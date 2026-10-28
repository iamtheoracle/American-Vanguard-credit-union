import { query, withTx, audit } from './db.js';
import { POLICY } from './policy.js';
import { postTwoSided, createTransaction, LedgerError } from './ledger.js';
import { validAmountCents } from './util.js';
import { notify } from './notify.js';

/**
 * Staff-controlled historical transaction entry and imports.
 *
 * Original dates, timestamps, external references, descriptions and statuses
 * are preserved verbatim. Only entries whose recorded status is settled
 * (posted/completed) change an account balance; pending, failed, declined and
 * reversed history is stored exactly as it occurred without inventing money.
 */

const ENTRY_TYPES = {
  deposit: { direction: 'credit', label: 'deposit' },
  adjustment: { direction: 'credit', label: 'adjustment credit' },
  bill_pay: { direction: 'debit', label: 'bill payment' },
  card_auth: { direction: 'debit', label: 'card purchase' }
};
const SETTLED = new Set(['posted', 'completed']);
const ALLOWED_STATUS = new Set(['posted', 'completed', 'pending_review', 'pending_approval', 'rejected', 'failed', 'declined', 'reversed']);
const MAX_ROWS = 500;

function clean(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function parseOccurredAt(value) {
  if (!value) throw new LedgerError('An original date and time is required', 400, 'invalid_date');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new LedgerError('The original date is not a valid timestamp', 400, 'invalid_date');
  if (date.getTime() > Date.now() + 86_400_000) {
    throw new LedgerError('The original date cannot be in the future', 400, 'invalid_date');
  }
  if (date.getUTCFullYear() < 1970) throw new LedgerError('The original date is too old', 400, 'invalid_date');
  return date;
}

function normalizeRow(row) {
  const type = clean(row.type, 20).toLowerCase();
  if (!ENTRY_TYPES[type]) {
    throw new LedgerError(`Unsupported entry type '${row.type}'. Use deposit, adjustment, bill_pay, or card_auth`, 400, 'invalid_type');
  }
  const amountCents = Number.isInteger(row.amountCents) ? row.amountCents : Number(row.amountCents);
  if (!validAmountCents(amountCents, { maxCents: POLICY.SINGLE_TRANSFER_MAX_CENTS })) {
    throw new LedgerError('Each entry needs a positive integer amount in cents up to $100,000', 400, 'invalid_amount');
  }
  const status = clean(row.status, 24).toLowerCase() || 'posted';
  if (!ALLOWED_STATUS.has(status)) {
    throw new LedgerError(`Unsupported status '${row.status}' for a historical entry`, 400, 'invalid_status');
  }
  const occurredAt = parseOccurredAt(row.occurredAt);
  const description = clean(row.description || row.memo, 160);
  if (!description) throw new LedgerError('Each entry needs a description', 400, 'invalid_description');
  const externalReference = clean(row.externalReference, 120) || null;
  const payee = clean(row.payee, 80) || null;
  return { type, amountCents, status, occurredAt, description, externalReference, payee };
}

async function resolveAccount(client, memberIdentifier, accountReference) {
  const identifier = clean(memberIdentifier, 200);
  if (!identifier) throw new LedgerError('A member identifier is required', 400, 'invalid_member');
  const { rows: members } = await client.query(
    `SELECT id, username, member_number, email, full_name, status FROM members
      WHERE lower(username) = lower($1) OR member_number = $1 OR lower(email) = lower($1) LIMIT 1`, [identifier]);
  const member = members[0];
  if (!member) throw new LedgerError(`No member matches '${identifier}'`, 400, 'member_not_found');
  const reference = clean(accountReference, 40);
  if (!reference) throw new LedgerError('An account number is required', 400, 'invalid_account');
  const { rows: accounts } = await client.query(
    `SELECT * FROM accounts WHERE member_id = $1 AND (account_number = $2 OR suffix = $2) AND status = 'open'`,
    [member.id, reference]);
  const account = accounts[0];
  if (!account) throw new LedgerError(`No open account '${reference}' for ${member.full_name}`, 400, 'account_not_found');
  return { member, account };
}

async function insertEntry(client, { operator, normalized, member, account, batchId, source }) {
  const config = ENTRY_TYPES[normalized.type];
  const settled = SETTLED.has(normalized.status);
  const tx = await createTransaction(client, {
    type: normalized.type,
    fromAccountId: config.direction === 'debit' ? account.id : null,
    toAccountId: config.direction === 'credit' ? account.id : null,
    amountCents: normalized.amountCents,
    status: settled ? 'posted' : normalized.status,
    memo: normalized.description,
    description: normalized.description,
    payee: normalized.payee,
    occurredAt: normalized.occurredAt,
    source,
    externalReference: normalized.externalReference,
    importBatchId: batchId || null,
    submittedBy: operator.id,
    submittedByType: 'operator'
  });
  if (settled) {
    await postTwoSided(client, {
      transactionId: tx.id,
      fromAccountId: config.direction === 'debit' ? account.id : null,
      toAccountId: config.direction === 'credit' ? account.id : null,
      amountCents: normalized.amountCents,
      memo: normalized.description,
      occurredAt: normalized.occurredAt
    });
    await client.query('UPDATE transactions SET posted_at = $1 WHERE id = $2', [normalized.occurredAt, tx.id]);
  }
  return tx;
}

export async function recordHistoricalTransaction({ operator, body }) {
  return withTx(async client => {
    const normalized = normalizeRow(body || {});
    const { member, account } = await resolveAccount(client, body?.memberIdentifier, body?.accountNumber);
    if (member.status !== 'verified') {
      throw new LedgerError('Historical entries require a verified member', 409, 'member_not_verified');
    }
    const tx = await insertEntry(client, {
      operator, normalized, member, account, source: 'operator'
    });
    await audit(client, {
      actorType: 'operator', actorId: operator.id, actorRole: operator.role,
      action: 'transaction.historical_entry', entityType: 'transaction', entityId: tx.id,
      metadata: {
        memberId: member.id, accountId: account.id, type: normalized.type,
        status: normalized.status, occurredAt: normalized.occurredAt.toISOString(),
        externalReference: normalized.externalReference
      }
    });
    return {
      transaction: {
        id: tx.id, reference: tx.reference, externalReference: tx.external_reference,
        status: tx.status, amountCents: Number(tx.amount_cents),
        occurredAt: tx.occurred_at, description: tx.description
      },
      member: { id: member.id, fullName: member.full_name, username: member.username },
      account: { id: account.id, accountNumber: account.account_number }
    };
  });
}

export async function importHistoricalTransactions({ operator, rows, filename }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new LedgerError('Provide at least one row to import', 400, 'empty_import');
  }
  if (rows.length > MAX_ROWS) {
    throw new LedgerError(`Import at most ${MAX_ROWS} rows at a time`, 400, 'import_too_large');
  }
  const normalizedRows = rows.map((row, index) => {
    try {
      return normalizeRow(row || {});
    } catch (error) {
      throw new LedgerError(`Row ${index + 1}: ${error.message}`, 400, error.code || 'invalid_row');
    }
  });

  return withTx(async client => {
    const resolved = [];
    for (let i = 0; i < rows.length; i += 1) {
      try {
        const target = await resolveAccount(client, rows[i]?.memberIdentifier, rows[i]?.accountNumber);
        resolved.push(target);
      } catch (error) {
        throw new LedgerError(`Row ${i + 1}: ${error.message}`, 400, error.code || 'invalid_row');
      }
    }
    const { rows: batchRows } = await client.query(
      `INSERT INTO import_batches (created_by, filename, row_count, status, detail)
       VALUES ($1,$2,$3,'committed',$4) RETURNING *`,
      [operator.id, clean(filename, 160) || null, rows.length, JSON.stringify({ source: 'manual-upload' })]);
    const batch = batchRows[0];

    let posted = 0;
    let totalCents = 0;
    const touched = new Map();
    for (let i = 0; i < normalizedRows.length; i += 1) {
      const normalized = normalizedRows[i];
      const { member, account } = resolved[i];
      if (member.status !== 'verified') {
        throw new LedgerError(`Row ${i + 1}: ${member.full_name} is not a verified member`, 409, 'member_not_verified');
      }
      const tx = await insertEntry(client, {
        operator, normalized, member, account, batchId: batch.id, source: 'import'
      });
      totalCents += normalized.amountCents;
      if (SETTLED.has(normalized.status)) posted += 1;
      touched.set(member.id, { count: (touched.get(member.id)?.count || 0) + 1, name: member.full_name });
      await audit(client, {
        actorType: 'operator', actorId: operator.id, actorRole: operator.role,
        action: 'transaction.imported', entityType: 'transaction', entityId: tx.id,
        metadata: { batchId: batch.id, occurredAt: normalized.occurredAt.toISOString(), status: normalized.status }
      });
    }

    await client.query(
      `UPDATE import_batches SET posted_count = $1, skipped_count = $2, total_cents = $3 WHERE id = $4`,
      [posted, normalizedRows.length - posted, totalCents, batch.id]);

    for (const [memberId, info] of touched) {
      await notify(client, {
        memberId, kind: 'activity', title: 'Historical activity added',
        body: `${info.count} historical transaction${info.count === 1 ? '' : 's'} were added to your ledger with their original dates.`
      });
    }

    await audit(client, {
      actorType: 'operator', actorId: operator.id, actorRole: operator.role,
      action: 'import.committed', entityType: 'import_batch', entityId: batch.id,
      metadata: { rows: rows.length, posted, totalCents }
    });

    return {
      batch: {
        id: batch.id, filename: batch.filename, rowCount: rows.length,
        postedCount: posted, skippedCount: normalizedRows.length - posted,
        totalCents, createdAt: batch.created_at
      }
    };
  });
}

export async function listImports(limit = 50) {
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const { rows } = await query(
    `SELECT b.id, b.filename, b.row_count AS "rowCount", b.posted_count AS "postedCount",
            b.skipped_count AS "skippedCount", b.total_cents AS "totalCents", b.status,
            b.created_at AS "createdAt", o.name AS "createdBy"
       FROM import_batches b JOIN operators o ON o.id = b.created_by
      ORDER BY b.created_at DESC LIMIT ${capped}`);
  return rows;
}

/** Manual processing: settle or reject a pending transaction with a reason. */
export async function processTransaction({ operator, transactionId, action, reason }) {
  if (!['post', 'reject'].includes(action)) {
    throw new LedgerError('Choose post or reject for manual processing', 400, 'invalid_action');
  }
  const note = clean(reason, 300);
  if (action === 'reject' && !note) {
    throw new LedgerError('A written reason is required to reject a transaction', 400, 'reason_required');
  }
  return withTx(async client => {
    const { rows } = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [transactionId]);
    const txn = rows[0];
    if (!txn) throw new LedgerError('Transaction not found', 404, 'not_found');
    if (!['pending_approval', 'pending_review'].includes(txn.status)) {
      throw new LedgerError(`Transaction is already ${txn.status}`, 409, 'already_processed');
    }
    if (action === 'post') {
      await postTwoSided(client, {
        transactionId: txn.id,
        fromAccountId: txn.from_account_id,
        toAccountId: txn.to_account_id,
        amountCents: Number(txn.amount_cents),
        memo: txn.memo || txn.description,
        occurredAt: txn.occurred_at
      });
      await client.query(
        'UPDATE transactions SET processed_by = $1, posted_at = now(), updated_at = now() WHERE id = $2',
        [operator.id, txn.id]);
    } else {
      await client.query(
        `UPDATE transactions SET status = 'rejected', processed_by = $1, decision_reason = $2,
           updated_at = now() WHERE id = $3`, [operator.id, note, txn.id]);
      await client.query(
        `UPDATE approvals SET status = 'rejected', decided_by = $1, decision_reason = $2,
           decided_at = now(), updated_at = now()
         WHERE transaction_id = $3 AND status IN ('pending','escalated')`,
        [operator.id, note, txn.id]);
    }
    const { rows: accountRows } = await client.query(
      `SELECT member_id FROM accounts WHERE id = $1`, [txn.to_account_id || txn.from_account_id]);
    const memberId = accountRows[0]?.member_id;
    if (memberId) {
      await notify(client, {
        memberId, kind: action === 'post' ? 'payment' : 'warning',
        title: action === 'post' ? 'Transaction processed' : 'Transaction rejected',
        body: action === 'post'
          ? 'An operator processed your pending transaction; it is now posted.'
          : note || 'An operator rejected your pending transaction.'
      });
    }
    await audit(client, {
      actorType: 'operator', actorId: operator.id, actorRole: operator.role,
      action: `transaction.manual_${action}`, entityType: 'transaction', entityId: txn.id,
      metadata: { reason: note || null, previousStatus: txn.status }
    });
    return { id: txn.id, status: action === 'post' ? 'posted' : 'rejected' };
  });
}
