import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, loginMember } from './helpers.mjs';

test('deposit and card mutation endpoints fail closed without verified external providers', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);

  const deposit = await api(env.base, '/api/deposits', {
    method: 'POST', cookie, headers: { 'Idempotency-Key': 'test-disabled-deposit-001' },
    body: { accountId: 'any-account', amountCents: 5000, description: 'test' }
  });
  assert.equal(deposit.status, 503);
  assert.equal(deposit.data.code, 'deposit_service_unavailable');
  assert.match(deposit.data.error, /no deposit was created/i);

  const freeze = await api(env.base, '/api/card/freeze', {
    method: 'POST', cookie, body: { frozen: true }
  });
  assert.equal(freeze.status, 503);
  assert.equal(freeze.data.code, 'card_issuer_unavailable');

  const purchase = await api(env.base, '/api/card/test-purchase', {
    method: 'POST', cookie, body: { merchant: 'Example Merchant', amountCents: 1250 }
  });
  assert.equal(purchase.status, 503);
  assert.equal(purchase.data.code, 'card_processor_unavailable');
});
