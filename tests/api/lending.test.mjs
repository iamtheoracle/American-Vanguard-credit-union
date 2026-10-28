import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, loginMember, loginOperator, getAccounts } from './helpers.mjs';

const PRIYA = ['priya@avcu.demo', 'Member!Demo2026'];

test('share certificates move funds into a term-share account with a commitment record', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const jordan = await loginMember(env.base);
  const before = await getAccounts(env.base, jordan.cookie);
  const draft = before.find(a => a.name === 'Share Draft');

  const opened = await api(env.base, '/api/investments', {
    method: 'POST', cookie: jordan.cookie,
    body: { amountCents: 100_000, termMonths: 12, accountId: draft.id }
  });
  assert.equal(opened.status, 201);
  assert.equal(opened.data.certificate.term_months, 12);
  assert.equal(opened.data.certificate.apy_bps, 450);

  const after = await getAccounts(env.base, jordan.cookie);
  assert.equal(after.find(a => a.name === 'Share Draft').balanceCents, draft.balanceCents - 100_000);
  const term = after.find(a => a.kind === 'TERM SHARE');
  assert.ok(term, 'a term-share account is created');
  assert.equal(term.balanceCents, 100_000);

  const list = await api(env.base, '/api/investments', { cookie: jordan.cookie });
  assert.equal(list.data.certificates.length, 1);
  assert.equal(list.data.certificates[0].accountNumber, term.accountNumber);

  const belowMinimum = await api(env.base, '/api/investments', {
    method: 'POST', cookie: jordan.cookie,
    body: { amountCents: 10_000, termMonths: 12, accountId: draft.id }
  });
  assert.equal(belowMinimum.status, 400);

  const badTerm = await api(env.base, '/api/investments', {
    method: 'POST', cookie: jordan.cookie,
    body: { amountCents: 100_000, termMonths: 9, accountId: draft.id }
  });
  assert.equal(badTerm.status, 400);

  const { query } = await import('../../server/db.js');
  const { rows } = await query(
    `SELECT t.type, t.status FROM transactions t WHERE t.type = 'certificate'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'posted');
});

test('loan applications require a credit decision and disburse into the ledger', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const jordan = await loginMember(env.base);
  const before = await getAccounts(env.base, jordan.cookie);
  const draft = before.find(a => a.name === 'Share Draft');

  const applied = await api(env.base, '/api/loans', {
    method: 'POST', cookie: jordan.cookie,
    body: {
      product: 'PERSONAL', principalCents: 300_000, termMonths: 24,
      purpose: 'Replace water heater', accountId: draft.id
    }
  });
  assert.equal(applied.status, 202);
  assert.equal(applied.data.loan.status, 'pending');
  const loanId = applied.data.loan.id;

  const unchanged = await getAccounts(env.base, jordan.cookie);
  assert.equal(unchanged.find(a => a.name === 'Share Draft').balanceCents, draft.balanceCents,
    'no disbursement before approval');

  const { cookie: teller } = await loginOperator(env.base, 'teller@avcu.demo');
  const denied = await api(env.base, `/api/operator/approvals/${applied.data.approvalId}/decide`, {
    method: 'POST', cookie: teller, body: { action: 'approve' }
  });
  assert.equal(denied.status, 403);

  const { cookie: manager } = await loginOperator(env.base, 'manager@avcu.demo');
  const approved = await api(env.base, `/api/operator/approvals/${applied.data.approvalId}/decide`, {
    method: 'POST', cookie: manager, body: { action: 'approve' }
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.outcome.status, 'active');

  const funded = await getAccounts(env.base, jordan.cookie);
  assert.equal(funded.find(a => a.name === 'Share Draft').balanceCents, draft.balanceCents + 300_000);

  const loans = await api(env.base, '/api/loans', { cookie: jordan.cookie });
  const loan = loans.data.loans.find(item => item.id === loanId);
  assert.equal(loan.status, 'active');
  assert.equal(loan.balanceCents, 300000);
  assert.ok(loan.nextDueDate);
  assert.ok(loan.monthlyPaymentCents > 0);

  const repayment = await api(env.base, `/api/loans/${loanId}/repay`, {
    method: 'POST', cookie: jordan.cookie, body: { amountCents: 50_000, accountId: draft.id }
  });
  assert.equal(repayment.status, 201);
  assert.ok(Number(repayment.data.loan.balanceCents) < 300_000);

  const afterRepay = await getAccounts(env.base, jordan.cookie);
  assert.equal(afterRepay.find(a => a.name === 'Share Draft').balanceCents,
    draft.balanceCents + 300_000 - 50_000);

  const payments = await api(env.base, '/api/loans', { cookie: jordan.cookie });
  assert.equal(payments.data.loans.find(item => item.id === loanId).payments.length, 1);

  const overpay = await api(env.base, `/api/loans/${loanId}/repay`, {
    method: 'POST', cookie: jordan.cookie, body: { amountCents: 900_000, accountId: draft.id }
  });
  assert.equal(overpay.status, 400);

  // Another member cannot repay a loan they do not own.
  const priya = await loginMember(env.base, ...PRIYA);
  const foreign = await api(env.base, `/api/loans/${loanId}/repay`, {
    method: 'POST', cookie: priya.cookie, body: { amountCents: 1000 }
  });
  assert.equal(foreign.status, 404);
});

test('loans above the management cap require a super admin decision', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const jordan = await loginMember(env.base);
  const accounts = await getAccounts(env.base, jordan.cookie);
  const draft = accounts.find(a => a.name === 'Share Draft');

  const applied = await api(env.base, '/api/loans', {
    method: 'POST', cookie: jordan.cookie,
    body: { product: 'AUTO', principalCents: 1_500_000, termMonths: 60, purpose: 'Used car', accountId: draft.id }
  });
  assert.equal(applied.status, 202);

  const { cookie: manager } = await loginOperator(env.base, 'manager@avcu.demo');
  const denied = await api(env.base, `/api/operator/approvals/${applied.data.approvalId}/decide`, {
    method: 'POST', cookie: manager, body: { action: 'approve' }
  });
  assert.equal(denied.status, 403);

  const { cookie: admin } = await loginOperator(env.base, 'super@avcu.demo');
  const approved = await api(env.base, `/api/operator/approvals/${applied.data.approvalId}/decide`, {
    method: 'POST', cookie: admin, body: { action: 'approve' }
  });
  assert.equal(approved.status, 200);

  const rejected = await api(env.base, '/api/loans', {
    method: 'POST', cookie: jordan.cookie,
    body: { product: 'PERSONAL', principalCents: 100_000, termMonths: 12, purpose: 'Small project', accountId: draft.id }
  });
  const { cookie: manager2 } = await loginOperator(env.base, 'manager@avcu.demo');
  const declined = await api(env.base, `/api/operator/approvals/${rejected.data.approvalId}/decide`, {
    method: 'POST', cookie: manager2, body: { action: 'reject' }
  });
  assert.equal(declined.status, 400, 'rejections require a reason');
  const declinedWithReason = await api(env.base, `/api/operator/approvals/${rejected.data.approvalId}/decide`, {
    method: 'POST', cookie: manager2, body: { action: 'reject', reason: 'Insufficient credit history' }
  });
  assert.equal(declinedWithReason.status, 200);
  const loans = await api(env.base, '/api/loans', { cookie: jordan.cookie });
  assert.equal(loans.data.loans.find(item => item.id === rejected.data.loan.id).status, 'declined');
});

test('rewards points accrue from recorded activity and redeem as a ledger credit', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const jordan = await loginMember(env.base);

  const summary = await api(env.base, '/api/rewards', { cookie: jordan.cookie });
  assert.equal(summary.status, 200);
  assert.equal(summary.data.points, 1250);
  assert.equal(summary.data.cashValueCents, 1250);

  const before = await getAccounts(env.base, jordan.cookie);
  const draft = before.find(a => a.name === 'Share Draft');

  const redeemed = await api(env.base, '/api/rewards/redeem', {
    method: 'POST', cookie: jordan.cookie, body: { points: 500, accountId: draft.id }
  });
  assert.equal(redeemed.status, 201);
  assert.equal(redeemed.data.creditCents, 500);

  const after = await getAccounts(env.base, jordan.cookie);
  assert.equal(after.find(a => a.name === 'Share Draft').balanceCents, draft.balanceCents + 500);

  const refreshed = await api(env.base, '/api/rewards', { cookie: jordan.cookie });
  assert.equal(refreshed.data.points, 750);

  const tooSmall = await api(env.base, '/api/rewards/redeem', {
    method: 'POST', cookie: jordan.cookie, body: { points: 300 }
  });
  assert.equal(tooSmall.status, 400);
  const tooMany = await api(env.base, '/api/rewards/redeem', {
    method: 'POST', cookie: jordan.cookie, body: { points: 5000 }
  });
  assert.equal(tooMany.status, 400);

  // Deposit activity earns points: $25 deposit = 25 points.
  const deposit = await api(env.base, '/api/deposits', {
    method: 'POST', cookie: jordan.cookie,
    body: { accountId: draft.id, amountCents: 2500, description: 'Rewards test deposit' }
  });
  assert.equal(deposit.status, 201);
  const earned = await api(env.base, '/api/rewards', { cookie: jordan.cookie });
  assert.equal(earned.data.points, 775);
});
