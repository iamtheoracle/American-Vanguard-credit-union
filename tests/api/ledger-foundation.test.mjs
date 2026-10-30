import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.mjs';
import { query, withTx } from '../../server/db.js';
import { postJournalTransaction } from '../../server/journal.js';

test('asset-aware ledger schema enforces ownership, per-asset balancing and append-only entries', async t => {
  const env = await startTestServer();
  t.after(() => env.close());

  const { rows: members } = await query("SELECT id FROM members WHERE email = 'jordan@avcu.demo'");
  const memberId = members[0].id;
  const { rows: accountRows } = await query(
    `INSERT INTO financial_accounts
      (member_id, owner_type, account_code, display_name, account_type, asset_code, asset_kind, asset_precision, custody_domain, status)
     VALUES ($1,'member','test-usd','Test USD','checking','USD','fiat',2,'bank','open')
     RETURNING id`, [memberId]);
  const accountId = accountRows[0].id;
  const { rows: systemRows } = await query(
    `INSERT INTO financial_accounts
      (owner_type, account_code, display_name, account_type, asset_code, asset_kind, asset_precision, custody_domain, status)
     VALUES ('system','test-clearing','Test USD clearing','clearing','USD','fiat',2,'bank','open')
     RETURNING id`);
  const clearingId = systemRows[0].id;
  const { rows: txRows } = await query(
    `INSERT INTO journal_transactions (reference, transaction_type, status, posted_at)
     VALUES ('JRN-TEST-001','test_transfer','draft',NULL) RETURNING id`);
  const txId = txRows[0].id;

  await query(
    `INSERT INTO journal_entries (journal_transaction_id, financial_account_id, asset_code, direction, amount_minor)
     VALUES ($1,$2,'USD','debit',1000),($1,$3,'USD','credit',1000)`,
    [txId, accountId, clearingId]);
  await query("UPDATE journal_transactions SET status = 'posted', posted_at = now() WHERE id = $1", [txId]);
  await assert.rejects(
    () => query("UPDATE journal_entries SET amount_minor = 2000 WHERE journal_transaction_id = $1", [txId]),
    /append-only/);

  const { rows: balances } = await query(
    `SELECT asset_code,
       sum(CASE WHEN direction='debit' THEN amount_minor ELSE -amount_minor END) AS net
     FROM journal_entries WHERE journal_transaction_id = $1 GROUP BY asset_code`, [txId]);
  assert.equal(balances.length, 1);
  assert.equal(balances[0].net, '0');

  await assert.rejects(
    () => query(
      `INSERT INTO journal_entries (journal_transaction_id, financial_account_id, asset_code, direction, amount_minor)
       VALUES ($1,$2,'USD','debit',1)`, [txId, accountId]),
    /append-only/);
});

test('asset code foreign key prevents cross-asset journal postings', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { rows: members } = await query("SELECT id FROM members WHERE email = 'jordan@avcu.demo'");
  const { rows } = await query(
    `INSERT INTO financial_accounts
      (member_id, owner_type, account_code, display_name, account_type, asset_code, asset_kind, asset_precision, custody_domain, status)
     VALUES ($1,'member','test-usdc','Test USDC','custody','USDC','stablecoin',6,'digital_asset','open')
     RETURNING id`, [members[0].id]);
  const { rows: tx } = await query(
    `INSERT INTO journal_transactions (reference, transaction_type, status, posted_at)
     VALUES ('JRN-TEST-002','test_transfer','draft',NULL) RETURNING id`);
  await assert.rejects(
    () => query(
      `INSERT INTO journal_entries (journal_transaction_id, financial_account_id, asset_code, direction, amount_minor)
       VALUES ($1,$2,'USD','debit',100)`, [tx[0].id, rows[0].id]),
    /foreign key/);
});

test('journal posting is balanced, exact, atomic and idempotent', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { rows: members } = await query("SELECT id FROM members WHERE email = 'jordan@avcu.demo'");
  const memberId = members[0].id;
  const { rows: memberAccount } = await query(
    `INSERT INTO financial_accounts
      (member_id, owner_type, account_code, display_name, account_type, asset_code, asset_kind, asset_precision, custody_domain, status)
     VALUES ($1,'member','post-usd','Posting account','checking','USD','fiat',2,'bank','open') RETURNING id`,
    [memberId]);
  const { rows: clearing } = await query(
    `INSERT INTO financial_accounts
      (owner_type, account_code, display_name, account_type, asset_code, asset_kind, asset_precision, custody_domain, status)
     VALUES ('system','post-clearing','Posting clearing','clearing','USD','fiat',2,'bank','open') RETURNING id`);
  const postings = [
    { financialAccountId: memberAccount[0].id, direction: 'debit', amountMinor: '2500' },
    { financialAccountId: clearing[0].id, direction: 'credit', amountMinor: 2500n }
  ];
  const first = await withTx(client => postJournalTransaction(client, {
    transactionType: 'member_transfer', idempotencyKey: 'journal-idem-0001', postings
  }));
  assert.equal(first.replayed, false);
  assert.equal(first.transaction.status, 'posted');

  const replay = await withTx(client => postJournalTransaction(client, {
    transactionType: 'member_transfer', idempotencyKey: 'journal-idem-0001', postings
  }));
  assert.equal(replay.replayed, true);
  assert.equal(replay.transaction.id, first.transaction.id);

  await assert.rejects(() => withTx(client => postJournalTransaction(client, {
    transactionType: 'member_transfer', idempotencyKey: 'journal-idem-0001',
    postings: [{ ...postings[0], amountMinor: '2600' }, { ...postings[1], amountMinor: '2600' }]
  })), error => error.code === 'idempotency_conflict');

  await assert.rejects(() => withTx(client => postJournalTransaction(client, {
    transactionType: 'member_transfer', idempotencyKey: 'journal-idem-0002',
    postings: [{ ...postings[0], amountMinor: '1000' }, { ...postings[1], amountMinor: '999' }]
  })), error => error.code === 'unbalanced_journal');
});

test('journal service rejects cross-asset balancing and floating point amounts', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { rows: usd } = await query(
    `INSERT INTO financial_accounts
      (owner_type, account_code, display_name, account_type, asset_code, asset_kind, asset_precision, custody_domain, status)
     VALUES ('system','cross-usd','USD','clearing','USD','fiat',2,'bank','open') RETURNING id`);
  const { rows: usdc } = await query(
    `INSERT INTO financial_accounts
      (owner_type, account_code, display_name, account_type, asset_code, asset_kind, asset_precision, custody_domain, status)
     VALUES ('system','cross-usdc','USDC','clearing','USDC','stablecoin',6,'digital_asset','open') RETURNING id`);
  await assert.rejects(() => withTx(client => postJournalTransaction(client, {
    transactionType: 'asset_transfer', idempotencyKey: 'journal-cross-asset-01',
    postings: [
      { financialAccountId: usd[0].id, direction: 'debit', amountMinor: '1000000' },
      { financialAccountId: usdc[0].id, direction: 'credit', amountMinor: '1000000' }
    ]
  })), error => error.code === 'unbalanced_journal');
  await assert.rejects(() => withTx(client => postJournalTransaction(client, {
    transactionType: 'asset_transfer', idempotencyKey: 'journal-float-amount',
    postings: [
      { financialAccountId: usd[0].id, direction: 'debit', amountMinor: 1.5 },
      { financialAccountId: usd[0].id, direction: 'credit', amountMinor: 1.5 }
    ]
  })), /invalid exact amount/);
});

test('database constraint rejects an unbalanced journal even when bypassing the service', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { rows: accounts } = await query(
    `INSERT INTO financial_accounts
      (owner_type, account_code, display_name, account_type, asset_code, asset_kind, asset_precision, custody_domain, status)
     VALUES
      ('system','db-guard-a','Guard A','clearing','USD','fiat',2,'internal','open'),
      ('system','db-guard-b','Guard B','clearing','USD','fiat',2,'internal','open')
     RETURNING id`);
  const { rows: tx } = await query(
    `INSERT INTO journal_transactions (reference, transaction_type, status)
     VALUES ('JRN-DB-GUARD','manual_test','draft') RETURNING id`);
  await query(
    `INSERT INTO journal_entries
      (journal_transaction_id, financial_account_id, asset_code, direction, amount_minor)
     VALUES ($1,$2,'USD','debit',100),($1,$3,'USD','credit',99)`,
    [tx[0].id, accounts[0].id, accounts[1].id]);
  await assert.rejects(
    () => query("UPDATE journal_transactions SET status='posted', posted_at=now() WHERE id=$1", [tx[0].id]),
    /not balanced per asset/);
  const { rows: current } = await query("SELECT status FROM journal_transactions WHERE id=$1", [tx[0].id]);
  assert.equal(current[0].status, 'draft');
});
