import { createHash } from 'node:crypto';
import { newReference } from './util.js';

const MAX_AMOUNT = 10n ** 38n - 1n;

export class JournalError extends Error {
  constructor(message, status = 400, code = 'journal_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function normalizePostings(postings) {
  if (!Array.isArray(postings) || postings.length < 2 || postings.length > 100) {
    throw new JournalError('A journal requires between 2 and 100 postings');
  }
  return postings.map((posting, index) => {
    const amountText = String(posting?.amountMinor ?? '');
    if (!/^\\d{1,38}$/.test(amountText) || BigInt(amountText) <= 0n || BigInt(amountText) > MAX_AMOUNT) {
      throw new JournalError(`Posting ${index + 1} has an invalid exact amount`);
    }
    if (!['debit', 'credit'].includes(posting.direction)) {
      throw new JournalError(`Posting ${index + 1} has an invalid direction`);
    }
    if (typeof posting.financialAccountId !== 'string' || !posting.financialAccountId) {
      throw new JournalError(`Posting ${index + 1} requires a financial account`);
    }
    return {
      financialAccountId: posting.financialAccountId,
      direction: posting.direction,
      amountMinor: amountText,
      memo: typeof posting.memo === 'string' ? posting.memo.slice(0, 500) : null
    };
  });
}

function requestDigest(type, description, postings) {
  return createHash('sha256').update(JSON.stringify({
    type, description: description || null,
    postings: postings.map(({ financialAccountId, direction, amountMinor }) =>
      ({ financialAccountId, direction, amountMinor }))
  })).digest('hex');
}

/**
 * Creates and posts one immutable balanced journal transaction.
 * The caller MUST provide a SQL transaction; all account locks, journal rows,
 * and status transition must commit or roll back together.
 * Amounts are decimal integer strings/BigInts, never JS floating-point values.
 */
export async function postJournalTransaction(client, {
  transactionType, description, idempotencyKey, sourceSystem, sourceEventId,
  createdByType = 'system', createdBy = null, postings
}) {
  if (typeof transactionType !== 'string' || !/^[a-z][a-z0-9_]{1,59}$/.test(transactionType)) {
    throw new JournalError('Invalid journal transaction type');
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw new JournalError('A valid idempotency key is required');
  }
  if (!['member', 'operator', 'system', 'provider'].includes(createdByType)) {
    throw new JournalError('Invalid journal actor type');
  }
  const normalized = normalizePostings(postings);
  const digest = requestDigest(transactionType, description, normalized);

  const existing = await client.query(
    `SELECT id, reference, status, request_hash
     FROM journal_transactions WHERE idempotency_key = $1`, [idempotencyKey]);
  if (existing.rowCount) {
    if (existing.rows[0].request_hash !== digest) {
      throw new JournalError('Idempotency key was already used for a different journal request', 409, 'idempotency_conflict');
    }
    return { transaction: existing.rows[0], replayed: true };
  }

  const accountIds = [...new Set(normalized.map(p => p.financialAccountId))].sort();
  const { rows: accounts } = await client.query(
    `SELECT id, asset_code, status FROM financial_accounts
     WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [accountIds]);
  const byId = new Map(accounts.map(account => [account.id, account]));
  if (byId.size !== accountIds.length) throw new JournalError('One or more financial accounts do not exist', 404, 'account_not_found');
  for (const account of accounts) {
    if (account.status !== 'open') throw new JournalError('All journal accounts must be open', 409, 'account_not_open');
  }

  const totals = new Map();
  for (const posting of normalized) {
    const account = byId.get(posting.financialAccountId);
    const current = totals.get(account.asset_code) || { debit: 0n, credit: 0n };
    current[posting.direction] += BigInt(posting.amountMinor);
    totals.set(account.asset_code, current);
  }
  for (const [asset, total] of totals) {
    if (total.debit !== total.credit) {
      throw new JournalError(`Journal is not balanced for ${asset}`, 400, 'unbalanced_journal');
    }
  }

  const { rows: created } = await client.query(
    `INSERT INTO journal_transactions
      (reference, transaction_type, status, idempotency_key, request_hash,
       source_system, source_event_id, description, created_by_type, created_by)
     VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, reference, status, request_hash`,
    [newReference(), transactionType, idempotencyKey, digest,
      sourceSystem || null, sourceEventId || null, description || null, createdByType, createdBy]);
  const transaction = created[0];

  for (const posting of normalized) {
    const asset = byId.get(posting.financialAccountId).asset_code;
    await client.query(
      `INSERT INTO journal_entries
        (journal_transaction_id, financial_account_id, asset_code, direction, amount_minor, memo)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [transaction.id, posting.financialAccountId, asset, posting.direction, posting.amountMinor, posting.memo]);
  }

  const { rows: posted } = await client.query(
    `UPDATE journal_transactions SET status = 'posted', posted_at = now()
     WHERE id = $1 AND status = 'draft'
     RETURNING id, reference, status, posted_at`, [transaction.id]);
  if (!posted[0]) throw new JournalError('Journal could not be posted', 409, 'journal_post_failed');
  return { transaction: posted[0], replayed: false };
}
