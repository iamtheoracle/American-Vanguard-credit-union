import crypto from 'node:crypto';
import { query, withTx, audit } from '../db.js';
import { POLICY } from '../policy.js';
import { validAmountCents } from '../util.js';

/**
 * Provider-independent AI layer.
 *
 * Rules enforced here (server side):
 *  - the model never gets database access, credentials, or code execution;
 *  - tool calls are validated against an allowlist + strict schemas;
 *  - every tool executes server-side authorization with the caller's identity;
 *  - money movement via AI becomes an approval request, never a direct posting;
 *  - failures are recorded and surfaced for manual fallback.
 *
 * Providers: 'openai' (OpenAI-compatible chat endpoint) when AI_API_KEY and
 * AI_BASE_URL are configured; 'sandbox' deterministic adapter otherwise.
 * 'failing' is a test-only provider used by automated tests.
 */

export function activeProvider() {
  // Only the explicit failure injection is honored for automated tests.
  // Normal requests stay local and never call an external AI endpoint.
  return process.env.AVCU_AI_PROVIDER === 'failing' ? 'failing' : 'local';
}

// ---- tool registry (allowlist; strict schemas) ------------------------------
const TOOLS = {
  get_my_accounts: {
    description: 'List the authenticated member\'s share accounts and balances',
    validate: () => ({}),
    exec: async ctx => {
      const { rows } = await query(
        'SELECT name, kind, suffix, balance_cents FROM accounts WHERE member_id = $1 AND status = $2 ORDER BY created_at',
        [ctx.member.id, 'open']);
      return { accounts: rows.map(r => ({ name: r.name, kind: r.kind, suffix: r.suffix, balanceCents: r.balance_cents })) };
    }
  },
  get_my_recent_transactions: {
    description: 'List the member\'s 10 most recent transactions',
    validate: input => {
      if (input !== null && typeof input !== 'object') throw new Error('Invalid arguments');
      return {};
    },
    exec: async ctx => {
      const { rows } = await query(
        `SELECT t.reference, t.type, t.status, t.amount_cents, t.memo, t.payee, t.created_at
         FROM transactions t
         JOIN accounts a ON (a.id = t.from_account_id OR a.id = t.to_account_id)
         WHERE a.member_id = $1 ORDER BY t.created_at DESC LIMIT 10`, [ctx.member.id]);
      return { transactions: rows };
    }
  },
  create_transfer_proposal: {
    description: 'Prepare a share transfer as a draft proposal for the member to confirm. Never moves money.',
    validate: input => {
      if (!input || typeof input !== 'object') throw new Error('Invalid arguments');
      if (!validAmountCents(input.amountCents)) throw new Error('amountCents must be a positive integer (minor units)');
      if (typeof input.toAccountName !== 'string' || !input.toAccountName.trim()) throw new Error('toAccountName required');
      if (typeof input.fromAccountName !== 'string' || !input.fromAccountName.trim()) throw new Error('fromAccountName required');
      return { amountCents: input.amountCents, from: input.fromAccountName.trim(), to: input.toAccountName.trim() };
    },
    exec: async (ctx, args) => {
      const { rows } = await query(
        `SELECT id, name, balance_cents FROM accounts WHERE member_id = $1 AND status = 'open'`, [ctx.member.id]);
      const from = rows.find(r => r.name.toLowerCase() === args.from.toLowerCase());
      const to = rows.find(r => r.name.toLowerCase() === args.to.toLowerCase());
      if (!from || !to || from.id === to.id) throw new Error('Unknown account names; use exact share names');
      if (from.balance_cents < args.amountCents) throw new Error('Insufficient available funds');
      if (ctx.member.status !== 'verified') throw new Error('Membership is pending verification');
      // Proposal only: money moves through the standard approval-limited pipeline.
      const result = await ctx.submitTransfer({
        fromAccountId: from.id, toAccountId: to.id,
        amountCents: args.amountCents, memo: 'Requested via AI assistant'
      });
      return { proposalCreated: true, reference: result.reference, status: result.status };
    }
  },
  create_support_case: {
    description: 'Open a support case so a human operator can help',
    validate: input => {
      if (!input || typeof input.subject !== 'string' || input.subject.trim().length < 3) {
        throw new Error('subject (string) required');
      }
      return { subject: input.subject.trim().slice(0, 120), body: String(input.body || '').trim().slice(0, 2000) };
    },
    exec: async (ctx, args) => ctx.createSupportCase(args)
  }
};
export const TOOL_NAMES = Object.keys(TOOLS);

function validateToolCall(name, input) {
  if (!TOOLS[name]) return { allowed: false, reason: `Tool '${name}' is not on the allowlist` };
  try {
    return { allowed: true, args: TOOLS[name].validate(input) };
  } catch (error) {
    return { allowed: false, reason: `Invalid arguments for '${name}': ${error.message}` };
  }
}

// ---- sandbox (deterministic) adapter ----------------------------------------
const AMOUNT_RE = /\$\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)/;

function parseAmountCents(text) {
  const match = AMOUNT_RE.exec(text);
  if (!match) return null;
  const dollars = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(dollars)) return null;
  const cents = Math.round(dollars * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function sandboxClassify(message) {
  const m = String(message || '').toLowerCase();
  if (m.includes('balance') || m.includes('how much')) return 'balance';
  if (/(transfer|move)\s/.test(m) && AMOUNT_RE.test(m)) return 'transfer_request';
  if (m.includes('freeze') || m.includes('lock my card')) return 'card_freeze';
  if (m.includes('unfreeze') || m.includes('unlock')) return 'card_unfreeze';
  if (m.includes('human') || m.includes('person') || m.includes('representative') || m.includes('support')) return 'human_support';
  if (m.includes('dispute') || m.includes('fraud')) return 'human_support';
  return 'general';
}

function sandboxComplete({ member, message }) {
  const intent = sandboxClassify(message);
  const toolCalls = [];
  if (intent === 'balance') {
    toolCalls.push({ tool: 'get_my_accounts', input: {} });
  } else if (intent === 'transfer_request') {
    const amountCents = parseAmountCents(message);
    const to = /primary/.test(message.toLowerCase()) ? 'Primary Share'
      : /market/.test(message.toLowerCase()) ? 'Money Market'
      : /holiday/.test(message.toLowerCase()) ? 'Holiday Club' : 'Primary Share';
    const from = /holiday/.test(message.toLowerCase()) ? 'Holiday Club' : 'Share Draft';
    if (amountCents) toolCalls.push({ tool: 'create_transfer_proposal', input: { amountCents, fromAccountName: from, toAccountName: to } });
  } else if (intent === 'human_support') {
    toolCalls.push({ tool: 'create_support_case', input: { subject: `Assistant handoff: ${message.slice(0, 80)}`, body: message } });
  }
  const replyText = {
    balance: 'Here is the latest summary of your shares.',
    transfer_request: amountCentsSafe(message)
      ? 'I prepared a transfer proposal. It follows the standard review limits and is not executed until confirmed.'
      : 'I can prepare a transfer proposal if you include an amount, for example "transfer $50 to Primary Share".',
    card_freeze: 'For card freezes use the Debit card page so the action is recorded against your card with full audit. I cannot change card status directly.',
    card_unfreeze: 'You can unfreeze your card from the Debit card page. I cannot change card status directly.',
    human_support: 'I have opened a support case so a person can take over from here.',
    general: 'I can help with balances, recent activity, preparing transfer proposals, and connecting you with support.'
  }[intent];
  return { reply: replyText, intent, toolCalls };
}

function amountCentsSafe(message) {
  const cents = parseAmountCents(message);
  return cents !== null && validAmountCents(cents);
}

export async function runChat({ member, message, history, hooks }) {
  const provider = activeProvider();
  const hooksCtx = {
    member,
    submitTransfer: hooks.submitTransfer,
    createSupportCase: hooks.createSupportCase
  };
  try {
    let completion;
    if (provider === 'failing') throw new Error('Simulated provider outage (test provider)');
    completion = sandboxComplete({ member, message });

    const executed = [];
    let degraded = false;
    let fallbackNote = null;
    for (const call of completion.toolCalls.slice(0, POLICY.AI_MAX_TOOL_CALLS_PER_MESSAGE)) {
      const verdict = validateToolCall(call.tool, call.input);
      if (!verdict.allowed) {
        await audit(null, {
          actorType: 'ai', action: 'ai.policy_denied', entityType: 'tool', entityId: call.tool,
          metadata: { requesterId: member.id, reason: verdict.reason }
        });
        executed.push({ tool: call.tool, status: 'denied', reason: verdict.reason });
        continue;
      }
      try {
        const result = await TOOLS[call.tool].exec(hooksCtx, verdict.args);
        executed.push({ tool: call.tool, status: 'ok', result: summarizeToolResult(result) });
      } catch (error) {
        executed.push({ tool: call.tool, status: 'failed', reason: error.message });
        degraded = true;
        fallbackNote = 'A step of your request could not be completed automatically.';
      }
    }
    return { provider, status: degraded ? 'partial' : 'succeeded', reply: completion.reply, intent: completion.intent, toolCalls: executed };
  } catch (error) {
    return { provider, status: 'failed', reply: null, error: error.message,
      fallbackNote: 'The assistant is temporarily unavailable. Your request was not executed; nothing changed. Retry or reach a human operator.' };
  }
}

function summarizeToolResult(result) {
  if (result && Array.isArray(result.accounts)) {
    return { accountCount: result.accounts.length, totalCents: result.accounts.reduce((s, a) => s + a.balanceCents, 0) };
  }
  if (result && result.proposalCreated) return { proposalCreated: true, reference: result.reference, status: result.status };
  if (result && result.caseId) return { caseId: result.caseId };
  return result || {};
}

/** Render the final member-facing reply from the completion + tool outcomes. */
export function renderReply(completion, results) {
  if (completion.status === 'failed') {
    return { status: 'failed', message: completion.fallbackNote };
  }
  let text = completion.reply;
  const notes = [];
  for (const r of results) {
    if (r.status === 'ok' && r.result?.accountCount) {
      text = 'Here is your current snapshot.';
    }
    if (r.status === 'ok' && r.result?.proposalCreated) {
      notes.push(`Transfer proposal ${r.result.reference} was created with status ${r.result.status}. Confirm it from the Move money page or await review if it needs approval.`);
    }
    if (r.status === 'ok' && r.result?.caseId) {
      notes.push(`Support case opened (${String(r.result.caseId).slice(0, 8)}…). A person will follow up.`);
    }
    if (r.status === 'denied') notes.push('One requested action is not permitted through the assistant.');
    if (r.status === 'failed') notes.push(completion.fallbackNote || 'One step could not be completed.');
  }
  if (notes.length) text = `${text}\n\n${notes.join(' ')}`;
  return { status: completion.status, message: text, toolCalls: results };
}

export async function recordAiTask({ requesterType, requesterId, provider, purpose, input, completion, results, outcome }) {
  const status = completion.status === 'failed' ? 'failed' : 'succeeded';
  const { rows } = await query(
    `INSERT INTO ai_tasks (requester_type, requester_id, purpose, status, provider, input_excerpt, output, tool_calls, error, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now()) RETURNING id`,
    [requesterType, requesterId, purpose || 'chat', status, provider,
     String(input || '').slice(0, 500),
     JSON.stringify(outcome || {}), JSON.stringify(results || []), completion.error || null]);
  return rows[0];
}


