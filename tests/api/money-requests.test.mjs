import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, loginMember, loginOperator, api } from './helpers.mjs';
import { query } from '../../server/db.js';

test('money request review, information response, and approval never move funds', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie: memberCookie } = await loginMember(env.base);
  const submitted = await api(env.base, '/api/money-requests', {
    method: 'POST', cookie: memberCookie,
    body: {
      requestType: 'transfer',
      amountCents: 15000,
      currency: 'USD',
      note: 'Please review this synthetic member money request.'
    }
  });
  assert.equal(submitted.status, 201);
  assert.equal(submitted.data.request.status, 'submitted');
  assert.match(submitted.data.request.reference, /^AVCU-MR-[A-F0-9]{12}$/);

  const history = await api(env.base, '/api/money-requests', { cookie: memberCookie });
  assert.equal(history.status, 200);
  assert.equal(history.data.requests[0].id, submitted.data.request.id);

  const { cookie: operatorCookie } = await loginOperator(env.base, 'teller@avcu.demo');
  const denied = await api(env.base, `/api/operator/approvals/${submitted.data.request.approvalId}/decide`, {
    method: 'POST', cookie: operatorCookie,
    body: { action: 'approve', reason: 'Operator cannot make final money request decisions.' }
  });
  assert.equal(denied.status, 403);

  const requestedInfo = await api(env.base, `/api/operator/approvals/${submitted.data.request.approvalId}/decide`, {
    method: 'POST', cookie: operatorCookie,
    body: { action: 'request_info', reason: 'Please clarify the purpose of the requested transfer.' }
  });
  assert.equal(requestedInfo.status, 200);
  const waiting = await api(env.base, '/api/money-requests', { cookie: memberCookie });
  assert.equal(waiting.data.requests[0].status, 'information_required');
  assert.match(waiting.data.requests[0].informationRequested, /clarify/i);

  const response = await api(env.base, `/api/money-requests/${submitted.data.request.id}/information`, {
    method: 'POST', cookie: memberCookie,
    body: { response: 'This is additional synthetic information for the money request review.' }
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.request.status, 'submitted');

  const { cookie: managerCookie } = await loginOperator(env.base, 'manager@avcu.demo');
  const approved = await api(env.base, `/api/operator/approvals/${submitted.data.request.approvalId}/decide`, {
    method: 'POST', cookie: managerCookie,
    body: { action: 'approve', reason: 'Approved for workflow testing only; no funds are moved.' }
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.approval.status, 'approved');

  const finalHistory = await api(env.base, '/api/money-requests', { cookie: memberCookie });
  assert.equal(finalHistory.data.requests[0].status, 'approved');
  const { rows } = await query('SELECT count(*)::int AS count FROM transactions WHERE reference = $1', [submitted.data.request.reference]);
  assert.equal(rows[0].count, 0, 'approval changes only the request state; no transaction is created');
});
