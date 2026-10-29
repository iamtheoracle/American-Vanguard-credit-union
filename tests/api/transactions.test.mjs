import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, loginMember, getAccounts } from './helpers.mjs';

test('share transfers post balanced ledger entries and enforce invariants', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const accounts = await getAccounts(env.base, cookie);
  const draft = accounts.find(a => a.name === 'Share Draft');
  const primary = accounts.find(a => a.name === 'Primary Share');

  const before = { draft: draft.balanceCents, primary: primary.balanceCents };
  const r = await api(env.base, '/api/transfers', {
    method: 'POST', cookie,
    body: { kind: 'share', fromAccountId: draft.id, toAccountId: primary.id, amountCents: 12345, memo: 'test transfer' }
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.transaction.status, 'posted');

  const after = await getAccounts(env.base, cookie);
  const draftAfter = after.find(a => a.name === 'Share Draft');
  const primaryAfter = after.find(a => a.name === 'Primary Share');
  assert.equal(draftAfter.balanceCents, before.draft - 12345);
  assert.equal(primaryAfter.balanceCents, before.primary + 12345);
  assert.equal(before.draft + before.primary, draftAfter.balanceCents + primaryAfter.balanceCents, 'money conserved');

  // Ledger invariant: newest entry per account matches its balance.
  const { query } = await import('../../server/db.js');
  for (const account of after.filter(a => [draft.id, primary.id].includes(a.id))) {
    const { rows } = await query(
      `SELECT balance_after_cents FROM ledger_entries WHERE account_id = $1 ORDER BY id DESC LIMIT 1`, [account.id]);
    assert.equal(Number(rows[0].balance_after_cents), account.balanceCents, `ledger matches balance for ${account.name}`);
  }
});

test('transfers validate funds, accounts, and amounts', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const accounts = await getAccounts(env.base, cookie);
  const holiday = accounts.find(a => a.name === 'Holiday Club');
  const draft = accounts.find(a => a.name === 'Share Draft');

  const insufficient = await api(env.base, '/api/transfers', {
    method: 'POST', cookie,
    body: { kind: 'share', fromAccountId: holiday.id, toAccountId: draft.id, amountCents: 10_000_000 }
  });
  assert.equal(insufficient.status, 400);
  assert.equal(insufficient.data.code, 'insufficient_funds');

  const sameShare = await api(env.base, '/api/transfers', {
    method: 'POST', cookie,
    body: { kind: 'share', fromAccountId: draft.id, toAccountId: draft.id, amountCents: 100 }
  });
  assert.equal(sameShare.status, 400);

  const fractional = await api(env.base, '/api/transfers', {
    method: 'POST', cookie,
    body: { kind: 'share', fromAccountId: draft.id, toAccountId: holiday.id, amountCents: 100.5 }
  });
  assert.equal(fractional.status, 400);

  const negative = await api(env.base, '/api/transfers', {
    method: 'POST', cookie,
    body: { kind: 'share', fromAccountId: draft.id, toAccountId: holiday.id, amountCents: -5 }
  });
  assert.equal(negative.status, 400);

  const foreign = await api(env.base, '/api/transfers', {
    method: 'POST', cookie,
    body: { kind: 'share', fromAccountId: '00000000-0000-0000-0000-000000000000', toAccountId: draft.id, amountCents: 100 }
  });
  assert.equal(foreign.status, 400);
});

test('duplicate submissions are prevented via idempotency keys', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const accounts = await getAccounts(env.base, cookie);
  const draft = accounts.find(a => a.name === 'Share Draft');
  const primary = accounts.find(a => a.name === 'Primary Share');
  const key = { 'Idempotency-Key': 'test-idem-1' };

  const first = await api(env.base, '/api/transfers', {
    method: 'POST', cookie, headers: key,
    body: { kind: 'share', fromAccountId: draft.id, toAccountId: primary.id, amountCents: 500 }
  });
  assert.equal(first.status, 201);
  const second = await api(env.base, '/api/transfers', {
    method: 'POST', cookie, headers: key,
    body: { kind: 'share', fromAccountId: draft.id, toAccountId: primary.id, amountCents: 500 }
  });
  assert.equal(second.status, 200);
  assert.equal(second.data.replayed, true);
  assert.equal(second.data.transaction.reference, first.data.transaction.reference);

  const accountsAfter = await getAccounts(env.base, cookie);
  const draftAfter = accountsAfter.find(a => a.name === 'Share Draft');
  assert.equal(draftAfter.balanceCents, draft.balanceCents - 500, 'charged exactly once');
});

test('deposits fail closed without a verified provider and never change balances', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const before = await getAccounts(env.base, cookie);
  const draft = before.find(a => a.name === 'Share Draft');
  const holiday = before.find(a => a.name === 'Holiday Club');

  for (const request of [
    { accountId: draft.id, amountCents: 2500, description: 'Small check' },
    { accountId: holiday.id, amountCents: 250_000, description: 'Large check' }
  ]) {
    const response = await api(env.base, '/api/deposits', {
      method: 'POST', cookie, body: request
    });
    assert.equal(response.status, 503);
    assert.equal(response.data.code, 'deposit_service_unavailable');
  }

  const after = await getAccounts(env.base, cookie);
  assert.equal(after.find(a => a.name === 'Share Draft').balanceCents, draft.balanceCents);
  assert.equal(after.find(a => a.name === 'Holiday Club').balanceCents, holiday.balanceCents);
});

test('card controls fail closed without a live issuer and create no fake authorizations', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const { query } = await import('../../server/db.js');
  const before = await query(`SELECT count(*) AS n FROM transactions WHERE type = 'card_auth'`);

  const purchase = await api(env.base, '/api/card/test-purchase', {
    method: 'POST', cookie, body: { amountCents: 2450, merchant: 'Harbor Market' }
  });
  assert.equal(purchase.status, 503);
  assert.equal(purchase.data.code, 'card_processor_unavailable');

  const freeze = await api(env.base, '/api/card/freeze', {
    method: 'POST', cookie, body: { frozen: true }
  });
  assert.equal(freeze.status, 503);
  assert.equal(freeze.data.code, 'card_issuer_unavailable');

  const after = await query(`SELECT count(*) AS n FROM transactions WHERE type = 'card_auth'`);
  assert.equal(Number(after.rows[0].n), Number(before.rows[0].n),
    'unavailable provider must not create simulated card transactions');
});


test('member activity supports safe filtering, date validation, and offset pagination', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);

  const first = await api(env.base, '/api/transactions?limit=1&offset=0', { cookie });
  assert.equal(first.status, 200);
  assert.ok(Array.isArray(first.data.transactions));
  assert.equal(first.data.pagination.limit, 1);
  assert.equal(first.data.pagination.offset, 0);
  assert.equal(typeof first.data.pagination.hasMore, 'boolean');

  const badDate = await api(env.base, '/api/transactions?from=not-a-date', { cookie });
  assert.equal(badDate.status, 400);

  const reversedRange = await api(env.base, '/api/transactions?from=2026-10-20&to=2026-10-01', { cookie });
  assert.equal(reversedRange.status, 400);

  const noMatch = await api(env.base, '/api/transactions?status=__no_such_status__', { cookie });
  assert.equal(noMatch.status, 200);
  assert.deepEqual(noMatch.data.transactions, []);

  const second = await api(env.base, '/api/transactions?limit=1&offset=1', { cookie });
  assert.equal(second.status, 200);
  if (first.data.transactions.length && second.data.transactions.length) {
    assert.notEqual(first.data.transactions[0].id, second.data.transactions[0].id,
      'offset pagination should not repeat the same transaction');
  }
});
