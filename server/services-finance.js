import { query, withTx, audit } from './db.js';
import { POLICY } from './policy.js';
import { postTwoSided, createTransaction, LedgerError } from './ledger.js';
import { createTransactionApproval } from './approvals.js';
import { validAmountCents, newReference } from './util.js';
import { notify } from './notify.js';

/**
 * Member finance services: money requests, relationship rewards, share
 * certificates, and loans. All amounts are integer minor units. Nothing here
 * talks to an external payment rail: internal ledger movements are clearly
 * recorded as such, and external settlement remains gated on provider
 * authorization (see server/integrations).
 */

export function assertVerified(member) {
  if (!member || member.status !== 'verified') {
    throw new LedgerError('Membership verification is still in review', 403, 'membership_pending');
  }
}

function cleanText(value, max) {
  return String(value || '').trim().slice(0, max);
}

async function sourceAccount(client, memberId, accountId, { disallowKinds = ['TERM SHARE'] } = {}) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `SELECT * FROM accounts WHERE id = $1 AND member_id = $2 AND status = 'open'`, [accountId, memberId]);
  const account = rows[0];
  if (!account) throw new LedgerError('Unknown account', 400, 'unknown_account');
  if (disallowKinds.includes(account.kind)) {
    throw new LedgerError('Choose a deposit share for this movement', 400, 'invalid_account');
  }
  return account;
}

async function depositAccountFor(client, memberId, accountId) {
  const { rows } = await client.query(
    `SELECT * FROM accounts WHERE member_id = $1 AND status = 'open' ORDER BY
       CASE kind WHEN 'EVERYDAY' THEN 0 WHEN 'SAVINGS' THEN 1 ELSE 2 END, created_at LIMIT 1`, [memberId]);
  if (accountId) return sourceAccount(client, memberId, accountId);
  if (!rows[0]) throw new LedgerError('No open deposit account for this member', 400, 'no_account');
  return rows[0];
}

// ---- payment requests -------------------------------------------------------
export async function createPaymentRequest({ member, body }) {
  assertVerified(member);
  const amountCents = body?.amountCents;
  if (!validAmountCents(amountCents, { maxCents: POLICY.SINGLE_TRANSFER_MAX_CENTS })) {
    throw new LedgerError('Enter a valid request amount between $0.01 and $100,000', 400, 'invalid_amount');
  }
  const recipient = cleanText(body?.recipient, 200);
  if (!recipient) throw new LedgerError('Enter a username, member number, or email', 400, 'invalid_recipient');
  const memo = cleanText(body?.memo, 120) || null;

  const { rows: matches } = await query(
    `SELECT id, username, member_number, email, full_name, status FROM members
      WHERE lower(username) = lower($1) OR member_number = $1 OR lower(email) = lower($1) LIMIT 1`, [recipient]);
  const target = matches[0] || null;
  if (target && target.id === member.id) {
    throw new LedgerError('You cannot request money from yourself', 400, 'self_request');
  }
  const emailLike = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient);
  if (!target && !emailLike) {
    throw new LedgerError('No member matches that username, member number, or email', 400, 'recipient_not_found');
  }

  return withTx(async client => {
    const { rows } = await client.query(
      `INSERT INTO payment_requests (requester_member_id, payer_member_id, payer_email, amount_cents, memo)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [member.id, target?.id || null, target ? null : recipient.toLowerCase(), amountCents, memo]);
    const request = rows[0];
    if (target?.id) {
      await notify(client, {
        memberId: target.id, kind: 'request',
        title: 'New money request',
        body: `${member.fullName} requested ${(amountCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}.`
      });
    }
    await audit(client, {
      actorType: 'member', actorId: member.id, action: 'request.created',
      entityType: 'payment_request', entityId: request.id,
      metadata: { amountCents, recipient, internal: Boolean(target?.id) }
    });
    return request;
  });
}

export async function listPaymentRequests(memberId) {
  await query(
    `UPDATE payment_requests SET status = 'expired', updated_at = now()
      WHERE status = 'pending' AND created_at < now() - interval '30 days'`);
  const sent = await query(
    `SELECT r.id, r.amount_cents AS "amountCents", r.memo, r.status, r.created_at AS "createdAt",
            r.payer_email AS "payerEmail", pm.full_name AS "payerName", pm.username AS "payerUsername"
       FROM payment_requests r LEFT JOIN members pm ON pm.id = r.payer_member_id
      WHERE r.requester_member_id = $1 ORDER BY r.created_at DESC LIMIT 50`, [memberId]);
  const received = await query(
    `SELECT r.id, r.amount_cents AS "amountCents", r.memo, r.status, r.created_at AS "createdAt",
            rm.full_name AS "requesterName", rm.username AS "requesterUsername", rm.member_number AS "requesterNumber"
       FROM payment_requests r JOIN members rm ON rm.id = r.requester_member_id
      WHERE r.payer_member_id = $1 ORDER BY r.created_at DESC LIMIT 50`, [memberId]);
  return { sent: sent.rows, received: received.rows };
}

export async function payPaymentRequest({ member, requestId, accountId }) {
  assertVerified(member);
  return withTx(async client => {
    const { rows } = await client.query(
      'SELECT * FROM payment_requests WHERE id = $1 FOR UPDATE', [requestId]);
    const request = rows[0];
    if (!request || request.payer_member_id !== member.id) {
      throw new LedgerError('Request not found', 404, 'not_found');
    }
    if (request.status !== 'pending') throw new LedgerError(`Request is already ${request.status}`, 409, 'not_pending');

    const from = await depositAccountFor(client, member.id, accountId);
    const { rows: requesterRows } = await client.query(
      'SELECT id, full_name FROM members WHERE id = $1', [request.requester_member_id]);
    const requester = requesterRows[0];
    const to = await depositAccountFor(client, requester.id, null);
    const amountCents = Number(request.amount_cents);

    const needsApproval = amountCents > POLICY.TRANSFER_APPROVAL_LIMIT_CENTS;
    const tx = await createTransaction(client, {
      type: 'request_payment',
      fromAccountId: from.id, toAccountId: to.id,
      amountCents,
      status: needsApproval ? 'pending_approval' : 'posted',
      memo: request.memo || `Payment of request from ${requester.full_name}`,
      payee: requester.full_name,
      submittedBy: member.id, submittedByType: 'member'
    });
    if (needsApproval) {
      await createTransactionApproval(client, tx, { submittedByType: 'member', submittedBy: member.id });
    } else {
      await postTwoSided(client, {
        transactionId: tx.id, fromAccountId: from.id, toAccountId: to.id,
        amountCents, memo: request.memo
      });
    }
    await client.query(
      `UPDATE payment_requests SET status = 'paid', transaction_id = $1, settled_at = now(), updated_at = now()
        WHERE id = $2`, [tx.id, request.id]);
    await notify(client, {
      memberId: requester.id, kind: 'request',
      title: 'Request paid',
      body: `${member.fullName} sent ${(amountCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}.`
    });
    await notify(client, {
      memberId: member.id, kind: 'payment',
      title: needsApproval ? 'Request payment submitted for review' : 'Request payment sent',
      body: needsApproval
        ? 'Your payment is above the review limit and will post after approval.'
        : 'The payment posted to your account and is visible in Activity.'
    });
    await audit(client, {
      actorType: 'member', actorId: member.id, action: 'request.paid',
      entityType: 'payment_request', entityId: request.id,
      metadata: { amountCents, transactionId: tx.id, needsApproval }
    });
    return { requestId: request.id, status: 'paid', transaction: { id: tx.id, reference: tx.reference, status: tx.status }, needsApproval };
  });
}

export async function closePaymentRequest({ member, requestId, action, reason }) {
  if (!['decline', 'cancel'].includes(action)) throw new LedgerError('Unknown action', 400, 'invalid_action');
  const column = action === 'decline' ? 'payer_member_id' : 'requester_member_id';
  const nextStatus = action === 'decline' ? 'declined' : 'cancelled';
  const { rows } = await query(
    `UPDATE payment_requests SET status = $1, updated_at = now()
      WHERE id = $2 AND ${column} = $3 AND status = 'pending' RETURNING *`,
    [nextStatus, requestId, member.id]);
  if (!rows[0]) throw new LedgerError('Request not found or already settled', 404, 'not_found');
  await audit(null, {
    actorType: 'member', actorId: member.id, action: `request.${nextStatus}`,
    entityType: 'payment_request', entityId: requestId, metadata: { reason: cleanText(reason, 200) || null }
  });
  return rows[0];
}

// ---- rewards ---------------------------------------------------------------
export async function awardPoints(client, { memberId, points, reason, transactionId = null }) {
  if (!Number.isInteger(points) || points === 0) return null;
  const { rows } = await client.query(
    `INSERT INTO reward_entries (member_id, points, reason, transaction_id)
     VALUES ($1,$2,$3,$4) RETURNING *`, [memberId, points, reason, transactionId]);
  return rows[0];
}

export async function rewardSummary(memberId) {
  const { rows } = await query(
    `SELECT coalesce(sum(points),0) AS balance FROM reward_entries WHERE member_id = $1`, [memberId]);
  const history = await query(
    `SELECT id, points, reason, created_at AS "createdAt" FROM reward_entries
      WHERE member_id = $1 ORDER BY id DESC LIMIT 100`, [memberId]);
  const earned = await query(
    `SELECT coalesce(sum(points),0) AS earned FROM reward_entries WHERE member_id = $1 AND points > 0`, [memberId]);
  return {
    points: Number(rows[0].balance),
    lifetimePoints: Number(earned.rows[0].earned),
    // 100 points = $1.00 of recorded statement credit.
    cashValueCents: Math.floor(Number(rows[0].balance)),
    history: history.rows
  };
}

export async function redeemRewards({ member, body }) {
  assertVerified(member);
  const points = body?.points;
  if (!Number.isInteger(points) || points < 500 || points % 100 !== 0) {
    throw new LedgerError('Redeem at least 500 points in increments of 100', 400, 'invalid_points');
  }
  return withTx(async client => {
    // Lock the member's reward rows, then total them (aggregates cannot be locked).
    const { rows: locked } = await client.query(
      'SELECT points FROM reward_entries WHERE member_id = $1 FOR UPDATE', [member.id]);
    const balance = locked.reduce((sum, entry) => sum + Number(entry.points), 0);
    if (balance < points) {
      throw new LedgerError('Not enough points for this redemption', 400, 'insufficient_points');
    }
    const account = await depositAccountFor(client, member.id, body?.accountId);
    const creditCents = points; // 100 points = 100 cents
    const tx = await createTransaction(client, {
      type: 'adjustment', toAccountId: account.id, amountCents: creditCents,
      status: 'posted', memo: `Rewards redemption · ${points} points`,
      description: 'Relationship rewards redeemed as a recorded statement credit',
      submittedBy: member.id, submittedByType: 'member'
    });
    await postTwoSided(client, {
      transactionId: tx.id, fromAccountId: null, toAccountId: account.id,
      amountCents: creditCents, memo: 'Rewards statement credit'
    });
    await awardPoints(client, {
      memberId: member.id, points: -points, reason: `Redeemed ${points} points`, transactionId: tx.id
    });
    await notify(client, {
      memberId: member.id, kind: 'rewards', title: 'Rewards redeemed',
      body: `${points} points were applied as a recorded statement credit.`
    });
    await audit(client, {
      actorType: 'member', actorId: member.id, action: 'rewards.redeemed',
      entityType: 'transaction', entityId: tx.id, metadata: { points, creditCents }
    });
    return { transaction: { id: tx.id, reference: tx.reference, status: tx.status }, points, creditCents };
  });
}

// ---- share certificates ----------------------------------------------------
export const CERTIFICATE_TERMS = { 6: 425, 12: 450, 24: 465, 36: 480 }; // illustrative APY, basis points

export async function listCertificates(memberId) {
  const { rows } = await query(
    `SELECT c.id, c.amount_cents AS "amountCents", c.term_months AS "termMonths",
            c.apy_bps AS "apyBps", c.status, c.opened_at AS "openedAt", c.matures_at AS "maturesAt",
            a.account_number AS "accountNumber", a.name AS "accountName"
       FROM certificate_commitments c JOIN accounts a ON a.id = c.account_id
      WHERE c.member_id = $1 ORDER BY c.opened_at DESC`, [memberId]);
  return rows;
}

export async function openCertificate({ member, body }) {
  assertVerified(member);
  const amountCents = body?.amountCents;
  const termMonths = Number(body?.termMonths);
  if (!validAmountCents(amountCents, { maxCents: POLICY.SINGLE_TRANSFER_MAX_CENTS })) {
    throw new LedgerError('Enter a valid commitment amount', 400, 'invalid_amount');
  }
  if (amountCents < 50_000) throw new LedgerError('The minimum share certificate is $500', 400, 'below_minimum');
  if (!CERTIFICATE_TERMS[termMonths]) throw new LedgerError('Choose a 6, 12, 24, or 36 month term', 400, 'invalid_term');
  const apyBps = CERTIFICATE_TERMS[termMonths];

  return withTx(async client => {
    const from = await sourceAccount(client, member.id, body?.accountId);
    const { rows: created } = await client.query(
      `INSERT INTO accounts (member_id, kind, name, suffix, balance_cents)
       VALUES ($1,'TERM SHARE',$2, lpad((floor(random()*9000)+1000)::int::text, 4, '0'), 0)
       RETURNING *`, [member.id, `${termMonths}-Month Share Certificate`]);
    const certificateAccount = created[0];
    const tx = await createTransaction(client, {
      type: 'certificate', fromAccountId: from.id, toAccountId: certificateAccount.id,
      amountCents, status: 'posted', memo: `${termMonths}-month share certificate`,
      description: 'Member share certificate commitment',
      submittedBy: member.id, submittedByType: 'member'
    });
    await postTwoSided(client, {
      transactionId: tx.id, fromAccountId: from.id, toAccountId: certificateAccount.id,
      amountCents, memo: 'Share certificate commitment'
    });
    const { rows: commitments } = await client.query(
      `INSERT INTO certificate_commitments
         (member_id, account_id, amount_cents, term_months, apy_bps, transaction_id, matures_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(months => $4))
       RETURNING *`,
      [member.id, certificateAccount.id, amountCents, termMonths, apyBps, tx.id]);
    await notify(client, {
      memberId: member.id, kind: 'investment', title: 'Share certificate opened',
      body: `A ${termMonths}-month share certificate for ${(amountCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} is now recorded.`
    });
    await audit(client, {
      actorType: 'member', actorId: member.id, action: 'certificate.opened',
      entityType: 'certificate', entityId: commitments[0].id,
      metadata: { amountCents, termMonths, apyBps, accountId: certificateAccount.id }
    });
    return {
      certificate: commitments[0],
      account: { id: certificateAccount.id, name: certificateAccount.name, accountNumber: certificateAccount.account_number },
      transaction: { id: tx.id, reference: tx.reference, status: tx.status }
    };
  });
}

// ---- loans -----------------------------------------------------------------
export const LOAN_PRODUCTS = {
  PERSONAL: { label: 'Personal loan', aprBps: 1099, minCents: 50_000, maxCents: 5_000_000 },
  AUTO: { label: 'Auto loan', aprBps: 649, minCents: 250_000, maxCents: 5_000_000 },
  SHARE_SECURED: { label: 'Share-secured loan', aprBps: 599, minCents: 50_000, maxCents: 2_500_000 }
};

export function monthlyPaymentCents(principalCents, aprBps, termMonths) {
  const rate = aprBps / 10000 / 12;
  if (rate === 0) return Math.ceil(principalCents / termMonths);
  const factor = rate / (1 - (1 + rate) ** -termMonths);
  return Math.round(principalCents * factor);
}

export async function applyForLoan({ member, body }) {
  assertVerified(member);
  const product = String(body?.product || '').toUpperCase();
  const config = LOAN_PRODUCTS[product];
  if (!config) throw new LedgerError('Choose a loan product', 400, 'invalid_product');
  const principalCents = body?.principalCents;
  const termMonths = Number(body?.termMonths);
  if (!validAmountCents(principalCents, { maxCents: config.maxCents }) || principalCents < config.minCents) {
    throw new LedgerError(`Enter an amount between $${config.minCents / 100} and $${config.maxCents / 100}`, 400, 'invalid_amount');
  }
  if (!Number.isInteger(termMonths) || termMonths < 6 || termMonths > 84) {
    throw new LedgerError('Choose a term between 6 and 84 months', 400, 'invalid_term');
  }
  const purpose = cleanText(body?.purpose, 120);
  if (purpose.length < 3) throw new LedgerError('Describe the purpose of the loan', 400, 'invalid_purpose');

  return withTx(async client => {
    const account = await sourceAccount(client, member.id, body?.accountId, { disallowKinds: [] });
    const monthly = monthlyPaymentCents(principalCents, config.aprBps, termMonths);
    const { rows } = await client.query(
      `INSERT INTO loans (member_id, reference, product, principal_cents, balance_cents, apr_bps,
         term_months, purpose, monthly_payment_cents, disbursement_account_id)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [member.id, `AVCU-LN-${newReference().slice(-10)}`, product, principalCents, config.aprBps,
       termMonths, purpose, monthly, account.id]);
    const loan = rows[0];
    const { rows: approvalRows } = await client.query(
      `INSERT INTO approvals (item_type, member_id, payload, status, required_role, submitted_by, submitted_by_type)
       VALUES ('loan', $1, $2, 'pending', $3, $1, 'member') RETURNING id`,
      [member.id, JSON.stringify({
        loanId: loan.id, reference: loan.reference, product, principalCents, termMonths,
        aprBps: config.aprBps, monthlyPaymentCents: monthly, purpose
      }), principalCents > POLICY.MANAGEMENT_APPROVAL_CAP_CENTS ? 'super_admin' : 'management']);
    await client.query('UPDATE loans SET approval_id = $1 WHERE id = $2', [approvalRows[0].id, loan.id]);
    await notify(client, {
      memberId: member.id, kind: 'loan', title: 'Loan application received',
      body: `Application ${loan.reference} is queued for a credit decision.`
    });
    await audit(client, {
      actorType: 'member', actorId: member.id, action: 'loan.applied',
      entityType: 'loan', entityId: loan.id,
      metadata: { product, principalCents, termMonths, approvalId: approvalRows[0].id }
    });
    return { loan, approvalId: approvalRows[0].id };
  });
}

export async function listLoans(memberId) {
  const { rows } = await query(
    `SELECT l.id, l.reference, l.product, l.principal_cents AS "principalCents",
            l.balance_cents AS "balanceCents", l.apr_bps AS "aprBps", l.term_months AS "termMonths",
            l.status, l.purpose, l.monthly_payment_cents AS "monthlyPaymentCents",
            l.next_due_date AS "nextDueDate", l.created_at AS "createdAt",
            l.approved_at AS "approvedAt", l.decision_reason AS "decisionReason",
            a.account_number AS "disbursementAccountNumber"
       FROM loans l LEFT JOIN accounts a ON a.id = l.disbursement_account_id
      WHERE l.member_id = $1 ORDER BY l.created_at DESC`, [memberId]);
  return rows;
}

export async function loanPayments(memberId, loanId) {
  const { rows } = await query(
    `SELECT p.id, p.amount_cents AS "amountCents", p.principal_cents AS "principalCents",
            p.interest_cents AS "interestCents", p.paid_at AS "paidAt", p.status,
            t.reference
       FROM loan_payments p LEFT JOIN transactions t ON t.id = p.transaction_id
      WHERE p.loan_id = $1 AND p.member_id = $2 ORDER BY p.paid_at DESC`, [loanId, memberId]);
  return rows;
}

export async function repayLoan({ member, loanId, body }) {
  assertVerified(member);
  const amountCents = body?.amountCents;
  if (!validAmountCents(amountCents, { maxCents: POLICY.SINGLE_TRANSFER_MAX_CENTS })) {
    throw new LedgerError('Enter a valid repayment amount', 400, 'invalid_amount');
  }
  return withTx(async client => {
    const { rows } = await client.query(
      `SELECT * FROM loans WHERE id = $1 AND member_id = $2 FOR UPDATE`, [loanId, member.id]);
    const loan = rows[0];
    if (!loan) throw new LedgerError('Loan not found', 404, 'not_found');
    if (loan.status !== 'active') throw new LedgerError('Only active loans accept repayments', 409, 'loan_inactive');
    const loanBalanceCents = Number(loan.balance_cents);
    if (amountCents > loanBalanceCents) {
      throw new LedgerError('Repayment may not exceed the remaining balance', 400, 'overpayment');
    }
    const account = await sourceAccount(client, member.id, body?.accountId);
    const interest = Math.min(
      Math.round(loanBalanceCents * (loan.apr_bps / 10000) / 12),
      Math.max(0, amountCents - 100));
    const principal = amountCents - interest;

    const tx = await createTransaction(client, {
      type: 'loan_payment', fromAccountId: account.id, amountCents, status: 'posted',
      memo: `Loan repayment · ${loan.reference}`, description: 'Loan repayment',
      submittedBy: member.id, submittedByType: 'member'
    });
    await postTwoSided(client, {
      transactionId: tx.id, fromAccountId: account.id, toAccountId: null,
      amountCents, memo: `Loan repayment ${loan.reference}`
    });
    const nextBalance = loanBalanceCents - principal;
    const nextStatus = nextBalance <= 0 ? 'paid_off' : 'active';
    await client.query(
      `UPDATE loans SET balance_cents = $1, status = $2,
         next_due_date = CASE WHEN $2 = 'paid_off' THEN NULL ELSE (current_date + interval '30 days')::date END
       WHERE id = $3`, [nextBalance, nextStatus, loan.id]);
    await client.query(
      `INSERT INTO loan_payments (loan_id, member_id, amount_cents, principal_cents, interest_cents,
         transaction_id, due_date, status)
       VALUES ($1,$2,$3,$4,$5,$6, current_date, 'paid')`,
      [loan.id, member.id, amountCents, principal, interest, tx.id]);
    await notify(client, {
      memberId: member.id, kind: 'loan', title: nextStatus === 'paid_off' ? 'Loan paid off' : 'Repayment recorded',
      body: `${(amountCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} applied to ${loan.reference}.`
    });
    await audit(client, {
      actorType: 'member', actorId: member.id, action: 'loan.repayment',
      entityType: 'loan', entityId: loan.id,
      metadata: { amountCents, principal, interest, transactionId: tx.id, nextStatus }
    });
    return {
      loan: { id: loan.id, balanceCents: nextBalance, status: nextStatus },
      transaction: { id: tx.id, reference: tx.reference, status: tx.status }
    };
  });
}
