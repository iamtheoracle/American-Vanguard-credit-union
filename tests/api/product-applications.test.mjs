import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, loginMember, loginOperator } from './helpers.mjs';

test('verified members can submit card and loan requests; requests are member-scoped and reviewable', async t => {
  const env = await startTestServer();
  t.after(() => env.close());

  const unauthenticated = await api(env.base, '/api/product-applications', {
    method: 'POST',
    body: { productType: 'credit_card', purpose: 'I would like to request a credit card.' }
  });
  assert.equal(unauthenticated.status, 401);

  const { cookie: member } = await loginMember(env.base);
  const card = await api(env.base, '/api/product-applications', {
    method: 'POST', cookie: member,
    body: { productType: 'credit_card', purpose: 'I would like to apply for a premium credit card.' }
  });
  assert.equal(card.status, 201);
  assert.equal(card.data.application.status, 'pending_review');

  const loan = await api(env.base, '/api/product-applications', {
    method: 'POST', cookie: member,
    body: { productType: 'auto_loan', requestedAmountCents: 1850000, purpose: 'I need financing to purchase a used vehicle.' }
  });
  assert.equal(loan.status, 201);
  assert.equal(loan.data.application.status, 'pending_review');

  const mine = await api(env.base, '/api/product-applications', { cookie: member });
  assert.equal(mine.status, 200);
  assert.equal(mine.data.applications.length, 2);

  const { cookie: manager } = await loginOperator(env.base, 'manager@avcu.demo');
  const queue = await api(env.base, '/api/operator/product-applications?status=all', { cookie: manager });
  assert.equal(queue.status, 200);
  assert.equal(queue.data.applications.length, 2);

  const reviewed = await api(env.base, '/api/operator/product-applications/' + encodeURIComponent(card.data.application.id), {
    method: 'PATCH', cookie: manager,
    body: { status: 'referred_to_partner', note: 'Prepared for external issuer review.' }
  });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.data.application.status, 'referred_to_partner');

  const { cookie: teller } = await loginOperator(env.base, 'teller@avcu.demo');
  const denied = await api(env.base, '/api/operator/product-applications/' + encodeURIComponent(loan.data.application.id), {
    method: 'PATCH', cookie: teller,
    body: { status: 'referred_to_partner', note: 'Attempted without management authority.' }
  });
  assert.equal(denied.status, 403);
});

test('product application validation rejects unsupported products and invalid loan amounts', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);

  const unsupported = await api(env.base, '/api/product-applications', {
    method: 'POST', cookie, body: { productType: 'gold_card', purpose: 'Please consider this product request.' }
  });
  assert.equal(unsupported.status, 400);

  const invalidLoan = await api(env.base, '/api/product-applications', {
    method: 'POST', cookie, body: { productType: 'personal_loan', requestedAmountCents: 20, purpose: 'I need a small personal loan.' }
  });
  assert.equal(invalidLoan.status, 400);
});
