import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, loginMember, getAccounts } from './helpers.mjs';

const PRIYA = ['priya@avcu.demo', 'Member!Demo2026'];

test('member-to-member requests can be created, paid, and declined with ledger effects', async t => {
  const env = await startTestServer();
  t.after(() => env.close());

  const jordan = await loginMember(env.base);
  const priya = await loginMember(env.base, ...PRIYA);

  const jordanAccounts = await getAccounts(env.base, jordan.cookie);
  const priyaAccounts = await getAccounts(env.base, priya.cookie);
  const jordanDraft = jordanAccounts.find(a => a.name === 'Share Draft');
  const priyaDraft = priyaAccounts.find(a => a.name === 'Share Draft');

  const created = await api(env.base, '/api/requests', {
    method: 'POST', cookie: jordan.cookie,
    body: { recipient: 'priya.raman', amountCents: 4200, memo: 'Dinner split' }
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.request.status, 'pending');
  const requestId = created.data.request.id;

  const received = await api(env.base, '/api/requests', { cookie: priya.cookie });
  const incoming = received.data.received.find(r => r.id === requestId);
  assert.ok(incoming, 'payer sees the request');
  assert.equal(incoming.requesterName, 'Jordan Hale');
  assert.equal(incoming.amountCents, 4200);

  const notifications = await api(env.base, '/api/notifications', { cookie: priya.cookie });
  assert.ok(notifications.data.notifications.some(n => n.kind === 'request'));

  // Only the addressed payer may pay it.
  const wrongPayer = await api(env.base, `/api/requests/${requestId}/pay`, {
    method: 'POST', cookie: jordan.cookie, body: { accountId: jordanDraft.id }
  });
  assert.equal(wrongPayer.status, 404);

  const paid = await api(env.base, `/api/requests/${requestId}/pay`, {
    method: 'POST', cookie: priya.cookie, body: { accountId: priyaDraft.id }
  });
  assert.equal(paid.status, 201);
  assert.equal(paid.data.transaction.status, 'posted');

  const priyaAfter = await getAccounts(env.base, priya.cookie);
  const jordanAfter = await getAccounts(env.base, jordan.cookie);
  assert.equal(priyaAfter.find(a => a.name === 'Share Draft').balanceCents, priyaDraft.balanceCents - 4200);
  assert.equal(jordanAfter.find(a => a.name === 'Share Draft').balanceCents, jordanDraft.balanceCents + 4200);

  const { query } = await import('../../server/db.js');
  const { rows } = await query(
    `SELECT t.type, t.status, r.status AS request_status
       FROM payment_requests r JOIN transactions t ON t.id = r.transaction_id WHERE r.id = $1`, [requestId]);
  assert.equal(rows[0].type, 'request_payment');
  assert.equal(rows[0].status, 'posted');
  assert.equal(rows[0].request_status, 'paid');

  // A second request is declined by the payer and moves no money.
  const second = await api(env.base, '/api/requests', {
    method: 'POST', cookie: jordan.cookie,
    body: { recipient: 'priya@avcu.demo', amountCents: 1500 }
  });
  assert.equal(second.status, 201);
  const declined = await api(env.base, `/api/requests/${second.data.request.id}/decline`, {
    method: 'POST', cookie: priya.cookie
  });
  assert.equal(declined.status, 200);
  assert.equal(declined.data.status, 'declined');
  const priyaFinal = await getAccounts(env.base, priya.cookie);
  assert.equal(priyaFinal.find(a => a.name === 'Share Draft').balanceCents, priyaDraft.balanceCents - 4200);
});

test('request validation: self, unknown recipients, email-only, and expiry behaviour', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const jordan = await loginMember(env.base);

  const self = await api(env.base, '/api/requests', {
    method: 'POST', cookie: jordan.cookie,
    body: { recipient: 'jordan.hale', amountCents: 100 }
  });
  assert.equal(self.status, 400);
  assert.equal(self.data.code, 'self_request');

  const unknown = await api(env.base, '/api/requests', {
    method: 'POST', cookie: jordan.cookie,
    body: { recipient: 'nobody-here', amountCents: 100 }
  });
  assert.equal(unknown.status, 400);

  const invalidAmount = await api(env.base, '/api/requests', {
    method: 'POST', cookie: jordan.cookie,
    body: { recipient: 'priya.raman', amountCents: 0 }
  });
  assert.equal(invalidAmount.status, 400);

  const external = await api(env.base, '/api/requests', {
    method: 'POST', cookie: jordan.cookie,
    body: { recipient: 'friend@example.com', amountCents: 2200, memo: 'Concert tickets' }
  });
  assert.equal(external.status, 201);
  const sent = await api(env.base, '/api/requests', { cookie: jordan.cookie });
  const row = sent.data.sent.find(r => r.id === external.data.request.id);
  assert.equal(row.payerEmail, 'friend@example.com');
  assert.equal(row.status, 'pending');

  // Cancelling a sent request is owner-only and frees it from the queue.
  const cancelled = await api(env.base, `/api/requests/${row.id}/cancel`, {
    method: 'POST', cookie: jordan.cookie
  });
  assert.equal(cancelled.status, 200);

  // Pending requests older than 30 days are expired on read.
  await api(env.base, '/api/requests', {
    method: 'POST', cookie: jordan.cookie,
    body: { recipient: 'priya.raman', amountCents: 700 }
  });
  const { query } = await import('../../server/db.js');
  await query(`UPDATE payment_requests SET created_at = now() - interval '31 days' WHERE status = 'pending'`);
  const after = await api(env.base, '/api/requests', { cookie: jordan.cookie });
  assert.ok(after.data.sent.every(r => r.status !== 'pending'));
});

test('high-value request payment requires approval before posting', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const jordan = await loginMember(env.base);
  const priya = await loginMember(env.base, ...PRIYA);
  const priyaAccounts = await getAccounts(env.base, priya.cookie);
  const priyaDraft = priyaAccounts.find(a => a.name === 'Share Draft');

  const created = await api(env.base, '/api/requests', {
    method: 'POST', cookie: jordan.cookie,
    body: { recipient: 'priya.raman', amountCents: 300_000, memo: 'Rent share' }
  });
  const paid = await api(env.base, `/api/requests/${created.data.request.id}/pay`, {
    method: 'POST', cookie: priya.cookie, body: { accountId: priyaDraft.id }
  });
  assert.equal(paid.status, 202);
  assert.equal(paid.data.transaction.status, 'pending_approval');
  assert.equal(paid.data.needsApproval, true);

  const after = await getAccounts(env.base, priya.cookie);
  assert.equal(after.find(a => a.name === 'Share Draft').balanceCents, priyaDraft.balanceCents,
    'pending request payment must not move money');
});
