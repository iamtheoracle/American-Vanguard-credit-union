import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL('../supabase/migrations/202610310002_banking_foundation.sql', import.meta.url),
  'utf8'
);
const architecture = readFileSync(
  new URL('../docs/banking-integration-architecture.md', import.meta.url),
  'utf8'
);

test('banking foundation defines provider-independent account and ledger tables', () => {
  for (const table of [
    'avcu_financial_accounts',
    'avcu_ledger_accounts',
    'avcu_ledger_transactions',
    'avcu_ledger_entries',
    'avcu_provider_events'
  ]) {
    assert.match(migration, new RegExp('create table if not exists public\\.' + table));
  }
});

test('financial tables enable RLS and deny direct browser-role access', () => {
  for (const table of [
    'avcu_financial_accounts',
    'avcu_ledger_accounts',
    'avcu_ledger_transactions',
    'avcu_ledger_entries',
    'avcu_provider_events'
  ]) {
    assert.match(migration, new RegExp('alter table public\\.' + table + ' enable row level security'));
    assert.match(migration, new RegExp('revoke all on public\\.' + table + ' from anon, authenticated'));
  }
});

test('journal lines require exactly one positive debit or credit', () => {
  assert.match(migration, /debit_amount > 0 and credit_amount = 0/);
  assert.match(migration, /credit_amount > 0 and debit_amount = 0/);
  assert.match(architecture, /balanced separately by currency/i);
});

test('provider events are deduplicated by provider and provider event ID', () => {
  assert.match(migration, /unique \(provider_code, provider_event_id\)/);
});

test('documentation explicitly blocks production until approvals and controls pass', () => {
  assert.match(architecture, /No production banking is enabled/);
  assert.match(architecture, /Explicit authorised production launch approval/);
});
