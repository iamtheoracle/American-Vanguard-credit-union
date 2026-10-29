import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, loginMember, loginOperator, getAccounts } from './helpers.mjs';

test('operator approval queue supports server-side type, status, search, and pagination filters', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie: memberCookie } = await loginMember(env.base);
  const accounts = await getAccounts(env.base, memberCookie);
  const from = accounts.find(a => a.name === 'Share Draft');
  const to = accounts.find(a => a.name === 'Primary Share');
  const submitted = await api(env.base, '/api/transfers', {
    method: 'POST', cookie: memberCookie,
    body: { kind: 'share', fromAccountId: from.id, toAccountId: to.id, amountCents: 300000, memo: 'operator dashboard test' }
  });
  assert.equal(submitted.status, 202);

  const { cookie: managerCookie } = await loginOperator(env.base, 'manager@avcu.demo');
  const result = await api(env.base, '/api/operator/approvals?type=transaction&status=pending&search=jordan&page=1&limit=10', { cookie: managerCookie });
  assert.equal(result.status, 200);
  assert.ok(result.data.approvals.some(row => row.id === submitted.data.approvalId));
  assert.equal(result.data.pagination.page, 1);
  assert.equal(result.data.pagination.limit, 10);
  assert.ok(result.data.pagination.total >= 1);

  const wrongType = await api(env.base, '/api/operator/approvals?type=loan', { cookie: managerCookie });
  assert.equal(wrongType.status, 200);
  assert.equal(wrongType.data.approvals.some(row => row.id === submitted.data.approvalId), false);
});

test('operator member lookup returns audited account, transaction, loan, money-request, and approval history', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie: managerCookie } = await loginOperator(env.base, 'manager@avcu.demo');
  const lookup = await api(env.base, '/api/operator/members?search=jordan', { cookie: managerCookie });
  assert.equal(lookup.status, 200);
  assert.ok(lookup.data.members.length > 0);
  const member = lookup.data.members[0];
  const history = await api(env.base, `/api/operator/members/${encodeURIComponent(member.id)}`, { cookie: managerCookie });
  assert.equal(history.status, 200);
  for (const key of ['member', 'accounts', 'transactions', 'loans', 'moneyRequests', 'approvals']) {
    assert.ok(Object.hasOwn(history.data, key), `history response includes ${key}`);
  }
  const forbidden = await api(env.base, `/api/operator/members/${encodeURIComponent(member.id)}`);
  assert.equal(forbidden.status, 401);
});
