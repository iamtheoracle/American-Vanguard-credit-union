import { createHash } from 'node:crypto';
import { withTx, audit } from '../db.js';

const ACTION_POLICY = Object.freeze({
  'account.read': { risk: 'low', memberStatus: 'any' },
  'transaction.read': { risk: 'low', memberStatus: 'any' },
  'support.case.create': { risk: 'medium', memberStatus: 'any' },
  'transfer.proposal.create': { risk: 'high', memberStatus: 'verified', approvalRequired: true }
});

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export class AiExecutionError extends Error {
  constructor(message, code, status = 403) {
    super(message); this.name = 'AiExecutionError'; this.code = code; this.status = status;
  }
}

/**
 * All state-changing AI actions must pass this broker. The executor receives
 * the same SQL client used for the idempotency and audit records, so callers
 * can commit the action and its audit record atomically.
 */
export async function executeAiAction({ member, action, idempotencyKey, request, execute }) {
  if (!member?.id) throw new AiExecutionError('Authenticated member context is required', 'ai_auth_required', 401);
  const policy = ACTION_POLICY[action];
  if (!policy) throw new AiExecutionError('AI action is not allowlisted', 'ai_action_not_allowed');
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 12 || idempotencyKey.length > 200) {
    throw new AiExecutionError('A stable idempotency key is required', 'ai_idempotency_required', 400);
  }
  if (typeof execute !== 'function') throw new AiExecutionError('A server-side executor is required', 'ai_executor_required', 500);
  if (policy.memberStatus === 'verified' && member.status !== 'verified') {
    throw new AiExecutionError('Membership verification is required for this action', 'ai_member_not_verified', 403);
  }
  const requestHash = createHash('sha256').update(stableSerialize(request ?? null)).digest('hex');
  return withTx(async client => {
    await client.query(
      `INSERT INTO ai_execution_idempotency (member_id, idempotency_key, action, request_hash, status)
       VALUES ($1,$2,$3,$4,'processing') ON CONFLICT (member_id, idempotency_key) DO NOTHING`,
      [member.id, idempotencyKey, action, requestHash]);
    const { rows } = await client.query(
      `SELECT action, request_hash, status, result FROM ai_execution_idempotency
       WHERE member_id = $1 AND idempotency_key = $2 FOR UPDATE`,
      [member.id, idempotencyKey]);
    const prior = rows[0];
    if (prior.action !== action || prior.request_hash !== requestHash) {
      throw new AiExecutionError('Idempotency key was already used for a different request', 'ai_idempotency_conflict', 409);
    }
    if (prior.status === 'succeeded') return { replayed: true, result: prior.result };
    if (prior.status === 'processing') {
      // This row is created and completed in one transaction. A visible processing
      // row here indicates a legacy/manual state and must not be executed twice.
      throw new AiExecutionError('An action with this key is already processing', 'ai_action_in_progress', 409);
    }
    const result = await execute(client, { member, action, policy });
    await client.query(
      `UPDATE ai_execution_idempotency SET status = 'succeeded', result = $3::jsonb, updated_at = now()
       WHERE member_id = $1 AND idempotency_key = $2`,
      [member.id, idempotencyKey, JSON.stringify(result ?? {})]);
    await audit(client, { actorType: 'ai', actorId: member.id, action: 'ai.action.executed',
      entityType: 'ai_action', entityId: idempotencyKey,
      metadata: { action, risk: policy.risk, approvalRequired: Boolean(policy.approvalRequired) } });
    return { replayed: false, result };
  });
}

export function availableAiActions() {
  return Object.entries(ACTION_POLICY).map(([action, policy]) => ({ action, ...policy }));
}
