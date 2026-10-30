import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.mjs';
import { query } from '../../server/db.js';

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
     VALUES ('JRN-TEST-001','test_transfer','posted',now()) RETURNING id`);
  const txId = txRows[0].id;

  await query(
    `INSERT INTO journal_entries (journal_transaction_id, financial_account_id, asset_code, direction, amount_minor)
     VALUES ($1,$2,'USD','debit',1000),($1,$3,'USD','credit',1000)`,
    [txId, accountId, clearingId]);
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
