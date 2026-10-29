import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, loginMember, loginOperator, getAccounts } from './helpers.mjs';

async function submitLargeTransfer(env) {
  const { cookie } = await loginMember(env.base);
  const accounts = await getAccounts(env.base, cookie);
  const draft = accounts.find(a => a.name === 'Share Draft');
  const primary = accounts.find(a => a.name === 'Primary Share');
  const r = await api(env.base, '/api/transfers', {
    method: 'POST', cookie,
    body: { kind: 'share', fromAccountId: draft.id, toAccountId: primary.id, amountCents: 300_000, memo: 'house fund' }
  });
  assert.equal(r.status, 202);
  assert.equal(r.data.transaction.status, 'pending_approval');
  return { approvalId: r.data.approvalId, cookie, accounts };
}

test('high-value transfers require approval and approvals execute the posting', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { approvalId, accounts } = await submitLargeTransfer(env);
  const draftBefore = accounts.find(a => a.name === 'Share Draft').balanceCents;

  // The pending transfer must not have moved money.
  const afterSubmit = await getAccounts(env.base, (await loginMember(env.base)).cookie);
  assert.equal(afterSubmit.find(a => a.name === 'Share Draft').balanceCents, draftBefore);

  const { cookie: teller } = await loginOperator(env.base, 'teller@avcu.demo');
  // Normal operator lacks the required management role.
  const denied = await api(env.base, `/api/operator/approvals/${approvalId}/decide`, {
    method: 'POST', cookie: manager, body: { action: 'approve' }
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.code, 'insufficient_role');

  const { cookie: manager } = await loginOperator(env.base, 'manager@avcu.demo');
  const approved = await api(env.base, `/api/operator/approvals/${approvalId}/decide`, {
    method: 'POST', cookie: manager, body: { action: 'approve' }
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.approval.status, 'approved');
  assert.equal(approved.data.outcome.status, 'posted');

  const after = await getAccounts(env.base, (await loginMember(env.base)).cookie);
  assert.equal(after.find(a => a.name === 'Share Draft').balanceCents, draftBefore - 300_000);
});

test('rejections require a reason; duplicates and concurrency are rejected atomically', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { approvalId } = await submitLargeTransfer(env);

  const { cookie: manager } = await loginOperator(env.base, 'manager@avcu.demo');
  const noReason = await api(env.base, `/api/operator/approvals/${approvalId}/decide`, {
    method: 'POST', cookie: manager, body: { action: 'reject' }
  });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.data.code, 'reason_required');

  // Concurrent duplicate decisions: exactly one wins, the other conflicts.
  const [a, b] = await Promise.all([
    api(env.base, `/api/operator/approvals/${approvalId}/decide`, {
      method: 'POST', cookie: manager, body: { action: 'approve' } }),
    api(env.base, `/api/operator/approvals/${approvalId}/decide`, {
      method: 'POST', cookie: manager, body: { action: 'approve' } })
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], 'exactly one concurrent decision wins');
  const posting = (a.status === 200 ? a : b).data.outcome;
  assert.equal(posting.status, 'posted', 'the winning decision still executed the posting');
});

test('amount above the management cap requires super admin', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const accounts = await getAccounts(env.base, cookie);
  const draft = accounts.find(a => a.name === 'Share Draft');
  const market = accounts.find(a => a.name === 'Money Market');
  const { query } = await import('../../server/db.js');
  await query('UPDATE accounts SET balance_cents = 3000000 WHERE id = $1', [draft.id]);
  const r = await api(env.base, '/api/transfers', {
    method: 'POST', cookie,
    body: { kind: 'share', fromAccountId: draft.id, toAccountId: market.id, amountCents: 2_000_000 }
  });
  assert.equal(r.status, 202);
  const approvalId = r.data.approvalId;

  const { cookie: manager } = await loginOperator(env.base, 'manager@avcu.demo');
  const overLimit = await api(env.base, `/api/operator/approvals/${approvalId}/decide`, {
    method: 'POST', cookie: manager, body: { action: 'approve' }
  });
  assert.equal(overLimit.status, 403);
  assert.equal(overLimit.data.code, 'insufficient_role');

  const { cookie: admin } = await loginOperator(env.base, 'super@avcu.demo');
  const approved = await api(env.base, `/api/operator/approvals/${approvalId}/decide`, {
    method: 'POST', cookie: admin, body: { action: 'approve' }
  });
  assert.equal(approved.status, 200);
});

test('escalation raises the required role and records audit events', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { approvalId } = await submitLargeTransfer(env);

  const { cookie: manager } = await loginOperator(env.base, 'manager@avcu.demo');
  const escalated = await api(env.base, `/api/operator/approvals/${approvalId}/decide`, {
    method: 'POST', cookie: manager, body: { action: 'escalate', reason: 'Needs second review' }
  });
  assert.equal(escalated.status, 200);

  // An escalated item still requires management+; after escalation, decisions persist.
  const list = await api(env.base, '/api/operator/approvals?status=escalated', { cookie: manager });
  const item = list.data.approvals.find(x => x.id === approvalId);
  assert.equal(item.status, 'escalated');

  const { cookie: admin } = await loginOperator(env.base, 'super@avcu.demo');
  const approved = await api(env.base, `/api/operator/approvals/${approvalId}/decide`, {
    method: 'POST', cookie: admin, body: { action: 'approve' }
  });
  assert.equal(approved.status, 200);

  const { query } = await import('../../server/db.js');
  const { rows } = await query(
    `SELECT action FROM audit_events WHERE entity_id = $1 AND action LIKE 'approval.%'`, [approvalId]);
  const actions = rows.map(r => r.action);
  assert.ok(actions.includes('approval.escalate'));
  assert.ok(actions.includes('approval.approve'));
});

test('membership applications flow through the approval queue', async t => {
  const env = await startTestServer();
  t.after(() => env.close());

  await api(env.base, '/api/auth/register', {
    method: 'POST', body: { email: 'applicant@avcu.demo', password: 'Str0ngPassphrase!', fullName: 'Sam Lee' }
  });
  const { cookie: manager } = await loginOperator(env.base, 'manager@avcu.demo');
  const queue = await api(env.base, '/api/operator/approvals?status=pending', { cookie: manager });
  const membership = queue.data.approvals.find(a => a.itemType === 'membership');
  assert.ok(membership, 'expected a pending membership approval');

  const approved = await api(env.base, `/api/operator/approvals/${membership.id}/decide`, {
    method: 'POST', cookie: teller, body: { action: 'approve' }
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.outcome.status, 'verified');

  // The approved applicant can now sign in and see funded-capable accounts.
  const { cookie: memberCookie } = await loginMember(env.base, 'applicant@avcu.demo', 'Str0ngPassphrase!');
  const me = await api(env.base, '/api/auth/me', { cookie: memberCookie });
  assert.equal(me.data.member.status, 'verified');
  const accounts = await getAccounts(env.base, memberCookie);
  assert.equal(accounts.length, 2);
});
