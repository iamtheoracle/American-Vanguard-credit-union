import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestServer, api, loginMember, loginOperator, getAccounts } from './helpers.mjs';
import { outbound, IntegrationError } from '../../server/integrations/index.js';
import { webhookSecret, verifyWebhookSignature } from '../../server/integrations/index.js';
import { base64Url } from '../../server/notifications.js';

test('Gmail message encoding uses Base64URL-safe characters', () => {
  assert.equal(base64Url(Buffer.from([251, 255])), '-_8');
});

test('integration health reports sandbox mode and honors failure injection', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie: manager } = await loginOperator(env.base, 'manager@avcu.demo');
  const r = await api(env.base, '/api/operator/integrations', { cookie: manager });
  assert.equal(r.status, 200);
  const names = r.data.integrations.map(i => i.name).sort();
  assert.deepEqual(names, ['card-issuer', 'payments']);
  assert.ok(r.data.integrations.every(i => i.mode === 'sandbox'), 'adapters must be labeled sandbox');

  const { cookie: teller } = await loginOperator(env.base, 'teller@avcu.demo');
  const denied = await api(env.base, '/api/operator/integrations', { cookie: teller });
  assert.equal(denied.status, 403);
});

test('sandbox failure injection classifies errors and opens the circuit', async t => {
  const env = await startTestServer({ sandboxFail: 'payments' });
  t.after(() => env.close());

  await assert.rejects(
    () => outbound('payments', async () => { throw new Error('sandbox outage'); }, { idempotencyKey: 'k1' }),
    error => error instanceof IntegrationError && error.code === 'provider_error');

  // After enough failures the circuit opens and blocks further calls.
  for (let i = 0; i < 4; i += 1) {
    await outbound('payments', async () => { throw new Error('sandbox outage'); }, { idempotencyKey: `k${i}` })
      .catch(() => {});
  }
  await assert.rejects(
    () => outbound('payments', async () => ({ ok: true })),
    error => error.code === 'circuit_open');
});

test('production webhook secrets fail closed and malformed timestamps are rejected', t => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    providerSecret: process.env.AVCU_WEBHOOK_SECRET_PAYMENTS,
    sandboxSecret: process.env.AVCU_WEBHOOK_SECRET_SANDBOX
  };
  t.after(() => {
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.providerSecret === undefined) delete process.env.AVCU_WEBHOOK_SECRET_PAYMENTS;
    else process.env.AVCU_WEBHOOK_SECRET_PAYMENTS = previous.providerSecret;
    if (previous.sandboxSecret === undefined) delete process.env.AVCU_WEBHOOK_SECRET_SANDBOX;
    else process.env.AVCU_WEBHOOK_SECRET_SANDBOX = previous.sandboxSecret;
  });

  process.env.NODE_ENV = 'production';
  delete process.env.AVCU_WEBHOOK_SECRET_PAYMENTS;
  delete process.env.AVCU_WEBHOOK_SECRET_SANDBOX;
  assert.equal(webhookSecret('payments'), null, 'production must not use the development fallback');

  const secret = 'test-provider-secret';
  const timestamp = String(Date.now());
  const body = '{"event":"test"}';
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  assert.equal(verifyWebhookSignature({ secret, body, signature, timestamp }), true);
  assert.equal(verifyWebhookSignature({ secret, body, signature, timestamp: 'not-a-timestamp' }), false);
  assert.equal(verifyWebhookSignature({ secret: '', body, signature, timestamp }), false);
});

test('webhooks verify signatures and reject replays', async t => {
  const env = await startTestServer();
  t.after(() => env.close());

  const secret = webhookSecret('sandbox');
  const payload = JSON.stringify({ event: 'payment.settled', amountCents: 1000 });
  const timestamp = String(Date.now());
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  const headers = {
    'X-AVCU-Signature': `sha256=${signature}`,
    'X-AVCU-Timestamp': timestamp,
    'X-AVCU-Event-Id': 'evt-test-1',
    'Content-Type': 'application/json'
  };

  const good = await fetch(`${env.base}/api/integrations/webhooks/sandbox`, {
    method: 'POST', headers, body: payload });
  assert.equal(good.status, 200);

  // Replay of the same event id: accepted at HTTP level but flagged, not re-processed twice.
  const replay = await fetch(`${env.base}/api/integrations/webhooks/sandbox`, {
    method: 'POST', headers, body: payload });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { received: true, replay: true });

  // Tampered signature is rejected.
  const bad = await fetch(`${env.base}/api/integrations/webhooks/sandbox`, {
    method: 'POST', headers: { ...headers, 'X-AVCU-Signature': 'sha256=deadbeef', 'X-AVCU-Event-Id': 'evt-test-2' },
    body: payload });
  assert.equal(bad.status, 401);

  // Stale timestamp is rejected (replay window).
  const staleTs = String(Date.now() - 10 * 60 * 1000);
  const staleSig = crypto.createHmac('sha256', secret).update(`${staleTs}.${payload}`).digest('hex');
  const stale = await fetch(`${env.base}/api/integrations/webhooks/sandbox`, {
    method: 'POST', headers: { ...headers, 'X-AVCU-Signature': `sha256=${staleSig}`, 'X-AVCU-Timestamp': staleTs, 'X-AVCU-Event-Id': 'evt-test-3' },
    body: payload });
  assert.equal(stale.status, 401);

  const { query } = await import('../../server/db.js');
  const { rows } = await query(`SELECT count(*) AS n FROM webhook_events`);
  assert.equal(Number(rows[0].n), 1, 'only the first delivery is stored');
});

test('bill payments flow through the payments adapter and fail safely', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const accounts = await getAccounts(env.base, cookie);
  const draft = accounts.find(a => a.name === 'Share Draft');

  const ok = await api(env.base, '/api/transfers', {
    method: 'POST', cookie,
    body: { kind: 'bill', fromAccountId: draft.id, amountCents: 8000, payee: 'Harbor Electric' }
  });
  assert.equal(ok.status, 202);
  assert.equal(ok.data.transaction.status, 'pending_approval',
    'bill payments await review before the ledger posts');

  const badPayee = await api(env.base, '/api/transfers', {
    method: 'POST', cookie,
    body: { kind: 'bill', fromAccountId: draft.id, amountCents: 8000, payee: '' }
  });
  assert.equal(badPayee.status, 400);
});
