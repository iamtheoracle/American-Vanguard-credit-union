import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startTestServer, api, loginMember, loginOperator } from './helpers.mjs';
import { query } from '../../server/db.js';
import * as memberRepo from '../../server/repositories/member.js';
import * as operatorRepo from '../../server/repositories/operator.js';

const sha = value => createHash('sha256').update(value).digest('hex');

async function registerVerifiedMember(base, email, username) {
  const registered = await api(base, '/api/auth/register', {
    method: 'POST',
    body: { email, username, password: 'StrongPassphrase!123', fullName: 'Regression Member' }
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.data));
  const found = await query('SELECT id FROM members WHERE email = $1', [email]);
  await query("UPDATE members SET status = 'verified' WHERE id = $1", [found.rows[0].id]);
  return found.rows[0].id;
}

test('member ownership boundaries hide another member loans, money requests and support cases', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const owner = await loginMember(env.base);
  const otherMemberId = await registerVerifiedMember(env.base, 'isolated.member@avcu.demo', 'isolated_member');
  const otherLogin = await loginMember(env.base, 'isolated.member@avcu.demo', 'StrongPassphrase!123');
  assert.equal(otherLogin.response.status, 200);

  const createdCase = await api(env.base, '/api/support/cases', {
    method: 'POST', cookie: owner.cookie,
    body: { subject: 'Private case', body: 'This support request belongs to the first member.' }
  });
  assert.equal(createdCase.status, 201);
  const caseId = createdCase.data.case.id;

  const loan = await api(env.base, '/api/loans/applications', {
    method: 'POST', cookie: owner.cookie,
    body: { requestedAmountCents: 125000, currency: 'USD', requestedTermMonths: 12, purpose: 'Regression test loan purpose' }
  });
  assert.equal(loan.status, 201, JSON.stringify(loan.data));
  const loanId = loan.data.application.id;
  await query("UPDATE loan_applications SET status = 'information_required' WHERE id = $1", [loanId]);
  await query("UPDATE approvals SET status = 'info_requested' WHERE id = $1", [loan.data.application.approvalId]);

  const money = await api(env.base, '/api/money-requests', {
    method: 'POST', cookie: owner.cookie,
    body: { requestType: 'other', amountCents: 2500, currency: 'USD', note: 'Regression ownership check' }
  });
  assert.equal(money.status, 201, JSON.stringify(money.data));
  const moneyId = money.data.request.id;
  await query("UPDATE money_requests SET status = 'information_required' WHERE id = $1", [moneyId]);
  await query("UPDATE approvals SET status = 'info_requested' WHERE id = $1", [money.data.request.approvalId]);

  const caseRead = await api(env.base, `/api/support/cases/${caseId}`, { cookie: otherLogin.cookie });
  assert.equal(caseRead.status, 404);
  const caseWrite = await api(env.base, `/api/support/cases/${caseId}/messages`, {
    method: 'POST', cookie: otherLogin.cookie, body: { body: 'Unauthorized cross-member message' }
  });
  assert.equal(caseWrite.status, 404);

  const loanWrite = await api(env.base, `/api/loans/applications/${loanId}/information`, {
    method: 'POST', cookie: otherLogin.cookie, body: { response: 'Unauthorized loan information submission' }
  });
  assert.equal(loanWrite.status, 404);

  const moneyWrite = await api(env.base, `/api/money-requests/${moneyId}/information`, {
    method: 'POST', cookie: otherLogin.cookie, body: { response: 'Unauthorized money request submission' }
  });
  assert.equal(moneyWrite.status, 404);

  const { rows } = await query('SELECT member_id FROM support_cases WHERE id = $1', [caseId]);
  assert.notEqual(rows[0].member_id, otherMemberId);
  const { rows: messages } = await query('SELECT count(*)::int AS count FROM case_messages WHERE case_id = $1', [caseId]);
  assert.equal(messages[0].count, 1, 'unauthorized member must not append a case message');
});

test('password reset tokens are single-use under replay and concurrent completion', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { rows } = await query("SELECT id, email FROM members WHERE email = 'jordan@avcu.demo'");
  const member = rows[0];
  const token = 'reset-regression-token';
  const tokenHash = sha(token);
  await memberRepo.createPasswordReset({
    member, tokenHash, resetUrl: new URL('https://example.invalid/reset?token=reset-regression-token')
  });

  const results = await Promise.allSettled([
    memberRepo.completePasswordReset({ tokenHash, passwordHash: 'hash-after-reset-a' }),
    memberRepo.completePasswordReset({ tokenHash, passwordHash: 'hash-after-reset-b' })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const replay = await memberRepo.completePasswordReset({ tokenHash, passwordHash: 'hash-replay' }).then(
    () => null, error => error
  );
  assert.ok(replay);
  assert.equal(replay.status, 400);
  const tokenRow = await query('SELECT used_at FROM password_reset_tokens WHERE token_hash = $1', [tokenHash]);
  assert.ok(tokenRow.rows[0].used_at);
});

test('concurrent administrator demotions cannot remove the last active super-admin', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const seeded = await query("SELECT id, email FROM operators WHERE email IN ('super@avcu.demo','manager@avcu.demo')");
  const superAdmin = seeded.find(row => row.email === 'super@avcu.demo');
  const manager = seeded.find(row => row.email === 'manager@avcu.demo');
  const actor = { id: manager.id, role: 'management' };
  const adminA = await operatorRepo.createOperator({
    email: 'regression-admin-a@avcu.demo', passwordHash: 'not-used-in-this-test', name: 'Admin A', role: 'super_admin', actor
  });
  const outcomes = await Promise.all([
    operatorRepo.updateOperator({ targetId: superAdmin.id, role: 'management', actor }),
    operatorRepo.updateOperator({ targetId: adminA.id, active: false, actor })
  ]);
  assert.equal(outcomes.filter(result => result.kind === 'updated').length, 1);
  assert.equal(outcomes.filter(result => result.kind === 'last_super_admin').length, 1);
  const remaining = await query("SELECT count(*)::int AS count FROM operators WHERE role = 'super_admin' AND active = TRUE");
  assert.equal(remaining.rows[0].count, 1, 'exactly one protected super-admin remains active');
});
test('multi-step loan submission rolls back when its audit write fails', async t => {
  const env = await startTestServer();
  t.after(async () => {
    await query('DROP TRIGGER IF EXISTS regression_fail_audit_insert ON audit_events');
    await query('DROP FUNCTION IF EXISTS regression_fail_audit_insert_fn()');
    await env.close();
  });
  const { rows } = await query("SELECT id FROM members WHERE email = 'jordan@avcu.demo'");
  const memberId = rows[0].id;
  await query(`CREATE OR REPLACE FUNCTION regression_fail_audit_insert_fn() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced audit failure for rollback test'; END $$`);
  await query(`CREATE TRIGGER regression_fail_audit_insert BEFORE INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION regression_fail_audit_insert_fn()`);
  const before = await query('SELECT count(*)::int AS count FROM loan_applications WHERE member_id = $1', [memberId]);
  await assert.rejects(memberRepo.createLoanApplication({
    memberId, amountCents: 50000, currency: 'USD', termMonths: 6,
    purpose: 'Rollback regression test', publicBaseUrl: 'https://example.invalid'
  }), /forced audit failure/);
  const after = await query('SELECT count(*)::int AS count FROM loan_applications WHERE member_id = $1', [memberId]);
  assert.equal(after.rows[0].count, before.rows[0].count, 'loan row must roll back');
  const approvals = await query("SELECT count(*)::int AS count FROM approvals WHERE member_id = $1 AND item_type = 'loan'", [memberId]);
  assert.equal(approvals.rows[0].count, 0, 'approval row must roll back with the loan');
});
