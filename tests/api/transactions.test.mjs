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
  for (const account of after) {
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

test('deposits under the review threshold post immediately; large deposits await review', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const accounts = await getAccounts(env.base, cookie);
  const draft = accounts.find(a => a.name === 'Share Draft');
  const holiday = accounts.find(a => a.name === 'Holiday Club');

  const small = await api(env.base, '/api/deposits', {
    method: 'POST', cookie,
    body: { accountId: draft.id, amountCents: 2500, description: 'Small check' }
  });
  assert.equal(small.status, 201);
  assert.equal(small.data.transaction.status, 'posted');

  const large = await api(env.base, '/api/deposits', {
    method: 'POST', cookie,
    body: { accountId: holiday.id, amountCents: 250_000, description: 'Large check' }
  });
  assert.equal(large.status, 202);
  assert.equal(large.data.transaction.status, 'pending_review');

  const after = await getAccounts(env.base, cookie);
  assert.equal(after.find(a => a.name === 'Holiday Club').balanceCents, holiday.balanceCents,
    'pending deposit must not change the balance');
});

test('card freeze controls sandbox authorizations', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const { query } = await import('../../server/db.js');
  const beforeRows = await query(`SELECT status, count(*) AS n FROM transactions WHERE type = 'card_auth' GROUP BY status`);
  const beforeCounts = Object.fromEntries(beforeRows.rows.map(r => [r.status, Number(r.n)]));

  const active = await api(env.base, '/api/card/test-purchase', {
    method: 'POST', cookie, body: { amountCents: 2450, merchant: 'Harbor Market' }
  });
  assert.equal(active.status, 200);
  assert.equal(active.data.outcome, 'approved');
  assert.equal(active.data.sandbox, true);

  const freeze = await api(env.base, '/api/card/freeze', { method: 'POST', cookie, body: { frozen: true } });
  assert.equal(freeze.status, 200);
  assert.equal(freeze.data.card.status, 'frozen');

  const declined = await api(env.base, '/api/card/test-purchase', {
    method: 'POST', cookie, body: { amountCents: 2450, merchant: 'Harbor Market' }
  });
  assert.equal(declined.status, 402);
  assert.equal(declined.data.outcome, 'declined');
  assert.equal(declined.data.reason, 'card_frozen');

  await api(env.base, '/api/card/freeze', { method: 'POST', cookie, body: { frozen: false } });
  // Failed and completed card authorizations must be recorded as transactions.
  const { rows } = await query(
    `SELECT status, count(*) AS n FROM transactions WHERE type = 'card_auth' GROUP BY status`);
  const byStatus = Object.fromEntries(rows.map(r => [r.status, Number(r.n)]));
  assert.equal(byStatus.completed, (beforeCounts.completed || 0) + 1);
  assert.equal(byStatus.rejected, (beforeCounts.rejected || 0) + 1);
});
