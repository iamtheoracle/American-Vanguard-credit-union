import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, loginMember, loginOperator, getAccounts } from './helpers.mjs';

async function jordanAccountNumber(env) {
  const { cookie } = await loginMember(env.base);
  const accounts = await getAccounts(env.base, cookie);
  const draft = accounts.find(a => a.name === 'Share Draft');
  return { cookie, draft, accounts };
}

test('management records a historical entry with its original date, reference, and status', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { draft } = await jordanAccountNumber(env);
  const { cookie: teller } = await loginOperator(env.base, 'teller@avcu.demo');
  const { cookie: manager } = await loginOperator(env.base, 'manager@avcu.demo');

  const payload = {
    memberIdentifier: 'jordan.hale',
    accountNumber: draft.accountNumber,
    type: 'deposit',
    amountCents: 12345,
    occurredAt: '2024-03-05T10:15:00.000Z',
    status: 'posted',
    externalReference: 'LEGACY-778',
    description: 'Legacy payroll March 2024'
  };

  const forbidden = await api(env.base, '/api/operator/transactions', {
    method: 'POST', cookie: teller, body: payload
  });
  assert.equal(forbidden.status, 403);

  const created = await api(env.base, '/api/operator/transactions', {
    method: 'POST', cookie: manager, body: payload
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.transaction.status, 'posted');
  assert.equal(created.data.transaction.externalReference, 'LEGACY-778');
  assert.equal(new Date(created.data.transaction.occurredAt).toISOString(), payload.occurredAt);

  const { cookie: memberCookie } = await loginMember(env.base);
  const after = await getAccounts(env.base, memberCookie);
  assert.equal(after.find(a => a.name === 'Share Draft').balanceCents, draft.balanceCents + 12345);

  const { query } = await import('../../server/db.js');
  const { rows } = await query(
    `SELECT occurred_at, created_at, source, external_reference FROM transactions WHERE external_reference = 'LEGACY-778'`);
  assert.equal(rows.length, 1);
  assert.equal(new Date(rows[0].occurred_at).toISOString(), payload.occurredAt);
  assert.equal(rows[0].source, 'operator');
  assert.ok(new Date(rows[0].created_at).getTime() > new Date(rows[0].occurred_at).getTime(),
    'insert time differs from the original date');

  const { rows: ledger } = await query(
    `SELECT occurred_at FROM ledger_entries WHERE transaction_id = (SELECT id FROM transactions WHERE external_reference = 'LEGACY-778')`);
  assert.equal(new Date(ledger[0].occurred_at).toISOString(), payload.occurredAt);

  const search = await api(env.base, '/api/operator/transactions?search=LEGACY-778', { cookie: manager });
  assert.equal(search.status, 200);
  assert.equal(search.data.transactions.length, 1);
  assert.equal(search.data.transactions[0].memberName, 'Jordan Hale');

  // Member activity shows the preserved original date and description.
  const memberActivity = await api(env.base, '/api/transactions?search=LEGACY-778', { cookie: memberCookie });
  assert.equal(memberActivity.data.transactions.length, 1);
  assert.equal(memberActivity.data.transactions[0].description, 'Legacy payroll March 2024');
});

test('non-settled historical statuses are preserved without changing balances', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { draft } = await jordanAccountNumber(env);
  const { cookie: manager } = await loginOperator(env.base, 'manager@avcu.demo');

  const pending = await api(env.base, '/api/operator/transactions', {
    method: 'POST', cookie: manager,
    body: {
      memberIdentifier: 'jordan@avcu.demo', accountNumber: draft.suffix, type: 'card_auth',
      amountCents: 7500, occurredAt: '2025-01-10T18:00:00.000Z', status: 'pending_review',
      description: 'Historic card purchase pending settlement'
    }
  });
  assert.equal(pending.status, 201);
  assert.equal(pending.data.transaction.status, 'pending_review');

  const { cookie: memberCookie } = await loginMember(env.base);
  const after = await getAccounts(env.base, memberCookie);
  assert.equal(after.find(a => a.name === 'Share Draft').balanceCents, draft.balanceCents);

  // Manual processing by management posts the pending item.
  const processed = await api(env.base, `/api/operator/transactions/${pending.data.transaction.id}/process`, {
    method: 'POST', cookie: manager, body: { action: 'post' }
  });
  assert.equal(processed.status, 200);
  const posted = await getAccounts(env.base, memberCookie);
  assert.equal(posted.find(a => a.name === 'Share Draft').balanceCents, draft.balanceCents - 7500);
});

test('historical entry validation rejects bad dates, accounts, and unverified members', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { draft } = await jordanAccountNumber(env);
  const { cookie: manager } = await loginOperator(env.base, 'manager@avcu.demo');
  const base = {
    memberIdentifier: 'jordan.hale', accountNumber: draft.accountNumber,
    type: 'deposit', amountCents: 1000, occurredAt: '2024-01-01T00:00:00.000Z',
    status: 'posted', description: 'Valid description'
  };

  const cases = [
    [{ ...base, occurredAt: 'tomorrow-ish' }, 'invalid_date'],
    [{ ...base, occurredAt: '2099-01-01T00:00:00.000Z' }, 'invalid_date'],
    [{ ...base, accountNumber: 'nope' }, 'account_not_found'],
    [{ ...base, memberIdentifier: 'missing-member' }, 'member_not_found'],
    [{ ...base, type: 'wire_transfer' }, 'invalid_type'],
    [{ ...base, status: 'maybe' }, 'invalid_status'],
    [{ ...base, description: '' }, 'invalid_description'],
    [{ ...base, amountCents: 0 }, 'invalid_amount']
  ];
  for (const [body, code] of cases) {
    const response = await api(env.base, '/api/operator/transactions', { method: 'POST', cookie: manager, body });
    assert.equal(response.status, 400, `expected 400 for ${code}`);
    assert.equal(response.data.code, code);
  }

  await api(env.base, '/api/auth/register', {
    method: 'POST',
    body: { email: 'pending@avcu.demo', username: 'pending.member', password: 'Str0ngPassphrase!', fullName: 'Pending Person' }
  });
  const { query } = await import('../../server/db.js');
  const { rows } = await query('SELECT id FROM members WHERE email = $1', ['pending@avcu.demo']);
  const { rows: accountRows } = await query(
    `INSERT INTO accounts (member_id, kind, name, suffix) VALUES ($1,'EVERYDAY','Pending Draft','9999')
     RETURNING account_number`, [rows[0].id]);
  const unverified = await api(env.base, '/api/operator/transactions', {
    method: 'POST', cookie: manager,
    body: { ...base, memberIdentifier: 'pending.member', accountNumber: accountRows[0].account_number }
  });
  assert.equal(unverified.status, 409);
  assert.equal(unverified.data.code, 'member_not_verified');
});

test('CSV imports are all-or-nothing and record batch totals', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { draft } = await jordanAccountNumber(env);
  const { cookie: manager } = await loginOperator(env.base, 'manager@avcu.demo');

  const rows = [
    { memberIdentifier: 'jordan.hale', accountNumber: draft.accountNumber, type: 'deposit', amountCents: 5000,
      occurredAt: '2023-06-01T09:00:00.000Z', status: 'posted', externalReference: 'HIST-1', description: 'Historic deposit one' },
    { memberIdentifier: 'jordan.hale', accountNumber: draft.accountNumber, type: 'deposit', amountCents: 2500,
      occurredAt: '2023-06-02T09:00:00.000Z', status: 'posted', externalReference: 'HIST-2', description: 'Historic deposit two' },
    { memberIdentifier: 'jordan.hale', accountNumber: draft.accountNumber, type: 'card_auth', amountCents: 1200,
      occurredAt: '2023-06-03T09:00:00.000Z', status: 'declined', externalReference: 'HIST-3', description: 'Historic declined purchase' }
  ];

  const imported = await api(env.base, '/api/operator/imports', {
    method: 'POST', cookie: manager, body: { rows, filename: 'core-migration.csv' }
  });
  assert.equal(imported.status, 201);
  assert.equal(imported.data.batch.rowCount, 3);
  assert.equal(imported.data.batch.postedCount, 2);
  assert.equal(imported.data.batch.skippedCount, 1);
  assert.equal(Number(imported.data.batch.totalCents), 8700);

  const { cookie: memberCookie } = await loginMember(env.base);
  const after = await getAccounts(env.base, memberCookie);
  assert.equal(after.find(a => a.name === 'Share Draft').balanceCents, draft.balanceCents + 7500,
    'only posted rows change the balance');

  const batches = await api(env.base, '/api/operator/imports', { cookie: manager });
  assert.equal(batches.data.batches.length, 1);
  assert.equal(batches.data.batches[0].filename, 'core-migration.csv');

  const badBatch = await api(env.base, '/api/operator/imports', {
    method: 'POST', cookie: manager,
    body: { rows: [...rows, { ...rows[0], occurredAt: 'not-a-date', externalReference: 'HIST-4' }] }
  });
  assert.equal(badBatch.status, 400);
  const batchesAfter = await api(env.base, '/api/operator/imports', { cookie: manager });
  assert.equal(batchesAfter.data.batches.length, 1, 'failed batches are not committed');

  const { cookie: teller } = await loginOperator(env.base, 'teller@avcu.demo');
  const forbidden = await api(env.base, '/api/operator/imports', {
    method: 'POST', cookie: teller, body: { rows }
  });
  assert.equal(forbidden.status, 403);
});

test('historical entries appear in member activity ordered by original date', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { draft } = await jordanAccountNumber(env);
  const { cookie: manager } = await loginOperator(env.base, 'manager@avcu.demo');

  await api(env.base, '/api/operator/transactions', {
    method: 'POST', cookie: manager,
    body: {
      memberIdentifier: 'jordan.hale', accountNumber: draft.accountNumber, type: 'adjustment',
      amountCents: 500, occurredAt: '2019-11-02T12:00:00.000Z', status: 'posted',
      description: 'Opening adjustment'
    }
  });

  const { cookie: memberCookie } = await loginMember(env.base);
  const activity = await api(env.base, '/api/transactions', { cookie: memberCookie });
  const oldest = activity.data.transactions[activity.data.transactions.length - 1];
  assert.equal(oldest.description, 'Opening adjustment');
  assert.equal(new Date(oldest.occurredAt).toISOString(), '2019-11-02T12:00:00.000Z');
});
