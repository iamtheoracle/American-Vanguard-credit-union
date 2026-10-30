import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, loginMember, loginOperator, getAccounts } from './helpers.mjs';

test('operator tiers are enforced on the server, not the UI', async t => {
  const env = await startTestServer();
  t.after(() => env.close());

  const { cookie: operatorCookie } = await loginOperator(env.base, 'teller@avcu.demo');
  const { cookie: managerCookie } = await loginOperator(env.base, 'manager@avcu.demo');
  const { cookie: adminCookie } = await loginOperator(env.base, 'super@avcu.demo');

  // Normal operator may view queues and decide low-tier items...
  const queue = await api(env.base, '/api/operator/queue', { cookie: operatorCookie });
  assert.equal(queue.status, 200);

  // ...but cannot access super-admin-only operator administration.
  const operators = await api(env.base, '/api/operator/operators', { cookie: operatorCookie });
  assert.equal(operators.status, 403);
  const operatorsMgr = await api(env.base, '/api/operator/operators', { cookie: managerCookie });
  assert.equal(operatorsMgr.status, 403);
  const operatorsAdmin = await api(env.base, '/api/operator/operators', { cookie: adminCookie });
  assert.equal(operatorsAdmin.status, 200);

  // Management+ may see audit; normal operator may not.
  const auditOp = await api(env.base, '/api/operator/audit', { cookie: operatorCookie });
  assert.equal(auditOp.status, 403);
  const auditMgr = await api(env.base, '/api/operator/audit', { cookie: managerCookie });
  assert.equal(auditMgr.status, 200);

  // Reversals are super-admin only.
  const accounts = await getAccounts(env.base, (await loginMember(env.base)).cookie);
  const list = await api(env.base, '/api/transactions', { cookie: (await loginMember(env.base)).cookie });
  const posted = list.data.transactions.find(t => t.status === 'posted');
  assert.ok(posted, 'expected a seeded posted transaction');
  const reverseMgr = await api(env.base, `/api/operator/transactions/${posted.id}/reverse`, {
    method: 'POST', cookie: managerCookie, body: { reason: 'test' }
  });
  assert.equal(reverseMgr.status, 403);
  const reverseAdmin = await api(env.base, `/api/operator/transactions/${posted.id}/reverse`, {
    method: 'POST', cookie: adminCookie, body: { reason: 'test reversal' }
  });
  assert.equal(reverseAdmin.status, 200);

  // Member session cannot reach operator endpoints (direct API attempt).
  const memberCookie = (await loginMember(env.base)).cookie;
  const memberAsOperator = await api(env.base, '/api/operator/queue', { cookie: memberCookie });
  assert.equal(memberAsOperator.status, 401);
  const memberAsAdmin = await api(env.base, '/api/operator/operators', { cookie: memberCookie });
  assert.equal(memberAsAdmin.status, 401);
});

test('operator sessions expire quickly and logins are rate limited', async t => {
  const env = await startTestServer();
  t.after(() => env.close());

  const { cookie } = await loginOperator(env.base, 'teller@avcu.demo');
  assert.ok(cookie, 'operator login should set a session cookie');
  const { query } = await import('../../server/db.js');
  await query(`UPDATE operator_sessions SET expires_at = now() - interval '1 minute'`);
  const expired = await api(env.base, '/api/operator/queue', { cookie });
  assert.equal(expired.status, 401);

  const attempts = [];
  for (let i = 0; i < 12; i += 1) {
    attempts.push(api(env.base, '/api/operator/login', {
      method: 'POST', body: { email: 'teller@avcu.demo', password: 'definitely-wrong' }
    }));
  }
  const results = await Promise.all(attempts);
  const statuses = results.map(r => r.status);
  assert.ok(statuses.includes(429), `expected rate limiting among ${statuses.join(',')}`);
  assert.ok(statuses.includes(401));
});
