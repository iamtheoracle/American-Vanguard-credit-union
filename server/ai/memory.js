import { query, withTx, audit } from '../db.js';
import { createHash } from 'node:crypto';

const MAX_FACT_LENGTH = 500;
const MAX_RESULTS = 10;
const BLOCKED = /\b(password|passcode|pin|cvv|otp|one[- ]time code|social security|ssn|account number|routing number|card number|medical diagnosis|medication|religion|political party|sexual orientation)\b/i;

function normalizeFact(value) {
  const fact = String(value || '').trim().replace(/\s+/g, ' ').slice(0, MAX_FACT_LENGTH);
  if (fact.length < 3) throw Object.assign(new Error('Memory fact is too short'), { code: 'memory_invalid_fact' });
  if (BLOCKED.test(fact)) throw Object.assign(new Error('This category of information cannot be saved to assistant memory'), { code: 'memory_restricted_content' });
  return fact;
}

/**
 * Save only after an explicit user request/confirmation. Never call this from
 * an automatic model extraction step. Facts are member-scoped and expire.
 */
export async function rememberMemberFact({ memberId, fact, category = 'preference', confirmed = false, ttlDays = 180 }) {
  if (!confirmed) throw Object.assign(new Error('Explicit user confirmation is required'), { code: 'memory_consent_required' });
  if (!memberId) throw Object.assign(new Error('Authenticated member required'), { code: 'memory_auth_required' });
  if (!['preference', 'goal', 'accessibility', 'project_context', 'communication_style'].includes(category)) {
    throw Object.assign(new Error('Unsupported memory category'), { code: 'memory_invalid_category' });
  }
  const safeFact = normalizeFact(fact);
  const boundedTtl = Math.max(1, Math.min(Number(ttlDays) || 180, 365));
  const fingerprint = createHash('sha256').update(`${memberId}: ${category}: ${safeFact.toLowerCase()}`).digest('hex');
  return withTx(async client => {
    const { rows } = await client.query(
      `INSERT INTO ai_memory_records (member_id, category, content, fingerprint, confirmed_at, expires_at)
       VALUES ($1,$2,$3,$4,now(),now() + ($5::int * interval '1 day'))
       ON CONFLICT (member_id, fingerprint) DO UPDATE SET
         content = EXCLUDED.content, confirmed_at = now(), expires_at = EXCLUDED.expires_at,
         updated_at = now(), deleted_at = NULL
       RETURNING id, category, content, confirmed_at, expires_at`,
      [memberId, category, safeFact, fingerprint, boundedTtl]);
    await audit(client, { actorType: 'member', actorId: memberId, action: 'ai.memory.saved',
      entityType: 'ai_memory', entityId: rows[0].id, metadata: { category, expiresAt: rows[0].expires_at } });
    return rows[0];
  });
}

export async function recallMemberFacts({ memberId, queryText, limit = 5 }) {
  if (!memberId) throw Object.assign(new Error('Authenticated member required'), { code: 'memory_auth_required' });
  const search = String(queryText || '').trim().slice(0, 300);
  if (!search) return [];
  const cap = Math.max(1, Math.min(Number(limit) || 5, MAX_RESULTS));
  const { rows } = await query(
    `SELECT id, category, content, confirmed_at, expires_at
     FROM ai_memory_records
     WHERE member_id = $1 AND deleted_at IS NULL AND expires_at > now()
       AND to_tsvector('english', content) @@ plainto_tsquery('english', $2)
     ORDER BY ts_rank(to_tsvector('english', content), plainto_tsquery('english', $2)) DESC,
              updated_at DESC LIMIT $3`,
    [memberId, search, cap]);
  return rows;
}

export async function forgetMemberFact({ memberId, memoryId }) {
  if (!memberId || !memoryId) throw Object.assign(new Error('Member and memory identifiers are required'), { code: 'memory_invalid_request' });
  return withTx(async client => {
    const { rows } = await client.query(
      `UPDATE ai_memory_records SET deleted_at = now(), content = '[deleted]', updated_at = now()
       WHERE id = $1 AND member_id = $2 AND deleted_at IS NULL RETURNING id`,
      [memoryId, memberId]);
    if (rows[0]) await audit(client, { actorType: 'member', actorId: memberId, action: 'ai.memory.deleted',
      entityType: 'ai_memory', entityId: memoryId });
    return { deleted: Boolean(rows[0]) };
  });
}

export async function purgeExpiredMemory() {
  const { rowCount } = await query(
    `UPDATE ai_memory_records SET deleted_at = now(), content = '[expired]', updated_at = now()
     WHERE deleted_at IS NULL AND expires_at <= now()`);
  return { expiredRecordsPurged: rowCount };
}
