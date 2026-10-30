import { query, withTx, audit } from './db.js';
import { POLICY } from './policy.js';
import { createTransactionApproval } from './approvals.js';
import { postTwoSided, createTransaction, LedgerError } from './ledger.js';
import { validAmountCents } from './util.js';
import { queueMemberNotification } from './notifications.js';
import { cardIssuerAdapter, paymentsAdapter, outbound } from './integrations/index.js';

/**
 * Member banking services. Shared by HTTP routes and the AI tool layer so the
 * AI can never exercise a path members cannot.
 */

async function assertVerifiedMember(member) {
  if (member.status !== 'verified') {
    throw new LedgerError('Membership verification is still in review', 403, 'membership_pending');
  }
}

async function ownAccounts(memberId, ids) {
  const { rows } = await query(
    'SELECT * FROM accounts WHERE member_id = $1 AND id = ANY($2::uuid[])', [memberId, ids]);
  return rows;
}

async function consumeIdempotency(client, key, scope, result) {
  if (!key) return;
  await client.query(
    `INSERT INTO idempotency_keys (key, scope, result) VALUES ($1,$2,$3)
     ON CONFLICT (key) DO NOTHING`, [key, scope, JSON.stringify(result)]);
}

export async function lookupIdempotent(key, scope) {
  if (!key) return null;
  const { rows } = await query('SELECT result FROM idempotency_keys WHERE key = $1 AND scope = $2', [key, scope]);
  return rows[0] ? rows[0].result : null;
}

export function transferRequiresApproval({ amountCents, aiContext = false }) {
  return Boolean(aiContext) || Number(amountCents) > POLICY.TRANSFER_APPROVAL_LIMIT_CENTS;
}

export async function submitMemberTransfer({ member, body, idempotencyKey, aiContext = false }) {
  await assertVerifiedMember(member);
  if (idempotencyKey) {
    const prior = await lookupIdempotent(idempotencyKey, `transfer:${member.id}`);
    if (prior) return { transaction: prior, approvalId: prior.approvalId || null, status: prior.status, replayed: true };
  }
  const kind = body.kind === 'bill' ? 'bill' : 'share';
  const amountCents = body.amountCents;
  if (!validAmountCents(amountCents, { maxCents: POLICY.SINGLE_TRANSFER_MAX_CENTS })) {
    throw new LedgerError('Enter a valid amount between $0.01 and $100,000', 400, 'invalid_amount');
  }
  const { rows: accounts } = await query(
    'SELECT * FROM accounts WHERE member_id = $1 AND status = \'open\'', [member.id]);
  const from = accounts.find(a => a.id === body.fromAccountId);
  if (!from) throw new LedgerError('Unknown source account', 400, 'unknown_account');
  if (kind === 'bill') {
    if (!body.payee || !String(body.payee).trim() || String(body.payee).length > 80) {
      throw new LedgerError('Enter a biller or payee name', 400, 'invalid_payee');
    }
  } else {
    const to = accounts.find(a => a.id === body.toAccountId);
    if (!to || to.id === from.id) throw new LedgerError('Choose two different shares', 400, 'invalid_destination');
  }

  // Reject impossible transfers before queueing them for review. The ledger
  // rechecks funds under row locks when a transfer is actually posted.
  if (Number(from.balance_cents) < amountCents) {
    throw new LedgerError(`Insufficient available funds in ${from.name}`, 400, 'insufficient_funds');
  }

  if (kind === 'bill') {
    // Bill payments go through the payment adapter (sandbox until authorized).
    const result = await withTx(async client => {
      const tx = await createTransaction(client, {
        type: 'bill_pay', fromAccountId: from.id, amountCents,
        status: 'pending_approval', memo: body.memo || null, payee: String(body.payee).trim(),
        submittedBy: member.id, submittedByType: 'member', idempotencyKey
      });
      const approvalId = await createTransactionApproval(client, tx,
        { submittedByType: 'member', submittedBy: member.id });
      await audit(client, {
        actorType: 'member', actorId: member.id, action: aiContext ? 'ai.transfer_proposed' : 'transaction.submitted',
        entityType: 'transaction', entityId: tx.id,
        metadata: { amountCents, payee: String(body.payee).trim(), kind }
      });
      await queueMemberNotification(client, {
        memberId: member.id, eventType: 'transaction.transfer_submitted',
        eventKey: `transaction:${tx.id}:transfer-submitted`,
        title: 'Transfer status update',
        body: `Your transfer ${tx.reference} is ${tx.status.replaceAll('_', ' ')}.`,
        subject: 'AVCU transfer status update'
      });
      await consumeIdempotency(client, idempotencyKey, `transfer:${member.id}`, serializeTransfer(tx, approvalId));
      return { transaction: tx, approvalId };
    });
      return { transaction: result.transaction, approvalId: result.approvalId, status: result.transaction.status };
  }

  const needsApproval = transferRequiresApproval({ amountCents, aiContext });
  const result = await withTx(async client => {
    const status = needsApproval ? 'pending_approval' : 'posted';
    const tx = await createTransaction(client, {
      type: 'transfer', fromAccountId: from.id, toAccountId: body.toAccountId,
      amountCents, status, memo: body.memo || null,
      submittedBy: member.id, submittedByType: 'member', idempotencyKey
    });
    let approvalId = null;
    if (needsApproval) {
      approvalId = await createTransactionApproval(client, tx, { submittedByType: 'member', submittedBy: member.id });
    } else {
      await postTwoSided(client, {
        transactionId: tx.id, fromAccountId: from.id, toAccountId: body.toAccountId,
        amountCents, memo: body.memo
      });
    }
    await audit(client, {
      actorType: 'member', actorId: member.id, action: aiContext ? 'ai.transfer_proposed' : 'transaction.submitted',
      entityType: 'transaction', entityId: tx.id,
      metadata: { amountCents, kind, needsApproval }
    });
    await queueMemberNotification(client, {
      memberId: member.id, eventType: 'transaction.transfer_submitted',
      eventKey: `transaction:${tx.id}:transfer-submitted`,
      title: 'Transfer status update',
      body: `Your transfer ${tx.reference} is ${tx.status.replaceAll('_', ' ')}.`,
      subject: 'AVCU transfer status update'
    });
    await consumeIdempotency(client, idempotencyKey, `transfer:${member.id}`, serializeTransfer(tx, approvalId));
    return { transaction: tx, approvalId };
  });
  return { transaction: result.transaction, approvalId: result.approvalId, status: result.transaction.status };
}

export async function submitMemberDeposit({ member, body, idempotencyKey }) {
  await assertVerifiedMember(member);
  if (idempotencyKey) {
    const prior = await lookupIdempotent(idempotencyKey, `deposit:${member.id}`);
    if (prior) return { ...prior, status: prior.transaction.status, replayed: true };
  }
  const amountCents = body.amountCents;
  if (!validAmountCents(amountCents, { maxCents: POLICY.SINGLE_TRANSFER_MAX_CENTS })) {
    throw new LedgerError('Enter a valid check amount', 400, 'invalid_amount');
  }
  const description = String(body.description || '').trim();
  if (!description || description.length > 120) {
    throw new LedgerError('Enter a deposit description', 400, 'invalid_description');
  }
  const { rows } = await query(
    'SELECT * FROM accounts WHERE member_id = $1 AND status = \'open\'', [member.id]);
  const account = rows.find(a => a.id === body.accountId);
  if (!account) throw new LedgerError('Unknown deposit account', 400, 'unknown_account');

  const needsReview = amountCents > POLICY.DEPOSIT_REVIEW_LIMIT_CENTS;
  return withTx(async client => {
    const tx = await createTransaction(client, {
      type: 'deposit', toAccountId: account.id, amountCents,
      status: needsReview ? 'pending_review' : 'posted',
      memo: description, submittedBy: member.id, submittedByType: 'member', idempotencyKey
    });
    let approvalId = null;
    if (needsReview) {
      approvalId = await createTransactionApproval(client, tx, { submittedByType: 'member', submittedBy: member.id });
    } else {
      await postTwoSided(client, {
        transactionId: tx.id, fromAccountId: null, toAccountId: account.id,
        amountCents, memo: description
      });
    }
    await audit(client, {
      actorType: 'member', actorId: member.id, action: 'deposit.submitted',
      entityType: 'transaction', entityId: tx.id, metadata: { amountCents, needsReview }
    });
    await queueMemberNotification(client, {
      memberId: member.id, eventType: 'transaction.deposit_submitted',
      eventKey: `transaction:${tx.id}:deposit-submitted`,
      title: 'Deposit status update',
      body: `Your deposit ${tx.reference} is ${tx.status.replaceAll('_', ' ')}.`,
      subject: 'AVCU deposit status update'
    });
    const serialized = { transaction: { id: tx.id, reference: tx.reference, status: tx.status, amountCents: Number(tx.amount_cents) }, approvalId };
    await consumeIdempotency(client, idempotencyKey, `deposit:${member.id}`, serialized);
    return { transaction: tx, approvalId, status: tx.status };
  });
}

export async function freezeCard({ member, frozen }) {
  const { rows } = await query('SELECT * FROM cards WHERE member_id = $1', [member.id]);
  const card = rows[0];
  if (!card) throw new LedgerError('No card on file', 404, 'no_card');
  if (card.status === (frozen ? 'frozen' : 'active')) return card;
  // Freeze state is authoritative locally; issuer sync is sandboxed for now.
  const { rows: updated } = await query(
    `UPDATE cards SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [frozen ? 'frozen' : 'active', card.id]);
  await audit(null, {
    actorType: 'member', actorId: member.id, action: frozen ? 'card.frozen' : 'card.unfrozen',
    entityType: 'card', entityId: card.id, metadata: { last4: card.last4 }
  });
  return updated[0];
}

export async function testCardPurchase({ member, body }) {
  const amountCents = body.amountCents;
  if (!validAmountCents(amountCents, { maxCents: POLICY.CARD_PURCHASE_MAX_CENTS })) {
    throw new LedgerError('Enter a valid purchase amount', 400, 'invalid_amount');
  }
  const merchant = String(body.merchant || '').trim();
  if (!merchant || merchant.length > 80) throw new LedgerError('Enter a merchant name', 400, 'invalid_merchant');
  const { rows } = await query('SELECT * FROM cards WHERE member_id = $1', [member.id]);
  const card = rows[0];
  if (!card) throw new LedgerError('No card on file', 404, 'no_card');
  const { rows: acctRows } = await query(
    `SELECT a.* FROM accounts a JOIN cards c ON c.member_id = a.member_id WHERE c.id = $1 AND a.kind = 'EVERYDAY'`, [card.id]);
  const draft = acctRows[0];

  const txn = await withTx(async client => {
    const created = await createTransaction(client, {
      type: 'card_auth', fromAccountId: draft?.id || null, amountCents,
      status: 'pending_review', memo: `Card authorization · ${merchant}`,
      submittedBy: member.id, submittedByType: 'member'
    });
    await audit(client, {
      actorType: 'member', actorId: member.id, action: 'card.auth_requested',
      entityType: 'transaction', entityId: created.id, metadata: { merchant, amountCents }
    });
    return created;
  });

  try {
    const decision = await outbound('card-issuer', () => cardIssuerAdapter.authorize({
      providerRef: card.provider_ref, frozen: card.status === 'frozen', amountCents, merchant
    }), { idempotencyKey: txn.reference });
    await withTx(async client => {
      await client.query(
        `UPDATE transactions SET status = $1, processed_by = NULL, updated_at = now() WHERE id = $2`,
        [decision.outcome === 'approved' ? 'completed' : 'rejected', txn.id]);
      await audit(client, {
        actorType: 'system', action: `card.${decision.outcome}`, entityType: 'transaction',
        entityId: txn.id, metadata: { sandbox: true, reason: decision.reason || null, merchant }
      });
    });
    return { transaction: txn, decision };
  } catch (error) {
    await withTx(async client => {
      await client.query(
        `UPDATE transactions SET status = 'failed', updated_at = now() WHERE id = $1`, [txn.id]);
      await audit(client, {
        actorType: 'system', action: 'card.auth_failed', entityType: 'transaction',
        entityId: txn.id, metadata: { code: error.code, message: error.message }
      });
    });
    throw new LedgerError('Card authorization could not reach the issuer. Nothing was charged; try again or contact support.',
      502, 'issuer_unavailable');
  }
}

export async function createSupportCase({ member, subject, body }) {
  const cleanSubject = String(subject || '').trim().slice(0, 120);
  if (cleanSubject.length < 3) throw new LedgerError('Provide a short subject', 400, 'invalid_subject');
  const result = await withTx(async client => {
    const { rows } = await client.query(
      `INSERT INTO support_cases (member_id, subject) VALUES ($1,$2) RETURNING *`, [member.id, cleanSubject]);
    if (body) {
      await client.query(
        `INSERT INTO case_messages (case_id, author_type, author_id, body) VALUES ($1,'member',$2,$3)`,
        [rows[0].id, member.id, String(body).slice(0, 2000)]);
    }
    await audit(client, {
      actorType: 'member', actorId: member.id, action: 'case.opened',
      entityType: 'support_case', entityId: rows[0].id
    });
    return rows[0];
  });
  return result;
}

function serializeTransfer(tx, approvalId = null) {
  return { reference: tx.reference, status: tx.status, id: tx.id, approvalId, amountCents: Number(tx.amount_cents) };
}
