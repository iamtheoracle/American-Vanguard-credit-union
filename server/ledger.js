import { newReference, validAmountCents } from './util.js';
import { POLICY } from './policy.js';

/**
 * Ledger operations. Every posting runs inside the caller's SQL transaction and
 * keeps the invariant: account.balance_cents == balance of the newest ledger
 * entry for that account. Row-level locks prevent concurrent double-spend.
 */

export async function loadAccountsForUpdate(client, ids) {
  const { rows } = await client.query(
    'SELECT * FROM accounts WHERE id = ANY($1::uuid[]) FOR UPDATE', [ids]);
  const byId = new Map(rows.map(r => [r.id, r]));
  for (const id of ids) if (!byId.has(id)) throw Object.assign(new Error('Account not found'), { status: 404 });
  for (const row of rows) {
    if (row.status !== 'open') throw Object.assign(new Error(`Account ${row.suffix} is not open`), { status: 400 });
  }
  return byId;
}

export class LedgerError extends Error {
  constructor(message, status = 400, code = 'ledger_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function postEntry(client, accountId, direction, amountCents, balanceAfter, transactionId, memo, occurredAt) {
  await client.query(
    `INSERT INTO ledger_entries (account_id, transaction_id, direction, amount_cents, balance_after_cents, memo, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,coalesce($7, now()))`,
    [accountId, transactionId, direction, amountCents, balanceAfter, memo || null, occurredAt || null]);
}

/**
 * Posts a two-sided movement. Caller must already hold the row locks.
 * transactionId must exist with status 'pending_approval' or 'pending_review'.
 */
export async function postTwoSided(client, { transactionId, fromAccountId, toAccountId, amountCents, memo, occurredAt = null }) {
  if (!validAmountCents(amountCents, { maxCents: POLICY.SINGLE_TRANSFER_MAX_CENTS })) {
    throw new LedgerError('Amount outside permitted range');
  }
  const accounts = await loadAccountsForUpdate(client, fromAccountId && toAccountId
    ? [fromAccountId, toAccountId] : [fromAccountId || toAccountId]);
  const from = fromAccountId ? accounts.get(fromAccountId) : null;
  const to = toAccountId ? accounts.get(toAccountId) : null;
  if (from && from.balance_cents < amountCents) {
    throw new LedgerError(`Insufficient available funds in ${from.name}`, 400, 'insufficient_funds');
  }
  if (from) {
    await client.query('UPDATE accounts SET balance_cents = balance_cents - $1 WHERE id = $2', [amountCents, fromAccountId]);
    await postEntry(client, fromAccountId, 'debit', amountCents, from.balance_cents - amountCents, transactionId, memo, occurredAt);
  }
  if (to) {
    await client.query('UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2', [amountCents, toAccountId]);
    await postEntry(client, toAccountId, 'credit', amountCents, to.balance_cents + amountCents, transactionId, memo, occurredAt);
  }
  await client.query(
    `UPDATE transactions SET status = 'posted', posted_at = coalesce(posted_at, now()), updated_at = now()
      WHERE id = $1`, [transactionId]);
}

export async function createTransaction(client, fields) {
  const reference = newReference();
  const { rows } = await client.query(
    `INSERT INTO transactions (reference, type, from_account_id, to_account_id, amount_cents,
       status, memo, payee, submitted_by, submitted_by_type, idempotency_key,
       occurred_at, source, external_reference, description, import_batch_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,coalesce($12, now()),$13,$14,$15,$16) RETURNING *`,
    [reference, fields.type, fields.fromAccountId || null, fields.toAccountId || null,
     fields.amountCents, fields.status, fields.memo || null, fields.payee || null,
     fields.submittedBy || null, fields.submittedByType || 'member', fields.idempotencyKey || null,
     fields.occurredAt || null, fields.source || 'member', fields.externalReference || null,
     fields.description || null, fields.importBatchId || null]);
  return rows[0];
}

/** Reversal entries are properly authorized compensating movements, never edits. */
export async function reverseTransaction(client, transactionId, { actor, reason }) {
  const { rows } = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [transactionId]);
  const original = rows[0];
  if (!original) throw new LedgerError('Transaction not found', 404);
  if (original.status !== 'posted') throw new LedgerError('Only posted transactions can be reversed', 400);
  const amountCents = Number(original.amount_cents);
  const reversal = await createTransaction(client, {
    type: 'reversal',
    fromAccountId: original.to_account_id || original.from_account_id,
    toAccountId: original.from_account_id || original.to_account_id,
    amountCents,
    status: 'pending_approval',
    memo: `Reversal of ${original.reference}: ${reason}`,
    submittedBy: actor?.id || null,
    submittedByType: actor?.type || 'operator',
    source: 'operator'
  });
  await postTwoSided(client, {
    transactionId: reversal.id,
    fromAccountId: reversal.from_account_id,
    toAccountId: reversal.to_account_id,
    amountCents,
    memo: `Reversal of ${original.reference}`,
    occurredAt: original.occurred_at
  });
  await client.query(
    `UPDATE transactions SET status = 'reversed', updated_at = now() WHERE id = $1`, [transactionId]);
  return reversal;
}
