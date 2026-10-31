import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('../supabase/migrations/202610310004_ledger_posting_controls.sql', import.meta.url), 'utf8');

test('posting is a trusted server-side function and locks the journal header', () => {
  assert.match(sql, /create or replace function public\.avcu_post_ledger_transaction/);
  assert.match(sql, /security definer/);
  assert.match(sql, /where id = p_transaction_id\s+for update/i);
  assert.match(sql, /grant execute on function public\.avcu_post_ledger_transaction\(uuid\) to service_role/);
  assert.match(sql, /from public, anon, authenticated, service_role/);
});

test('posting requires a minimum two lines and balances each currency independently', () => {
  assert.match(sql, /v_line_count < 2/);
  assert.match(sql, /group by currency_code\s+having sum\(debit_amount\) <> sum\(credit_amount\)/i);
  assert.match(sql, /Only draft transactions can be posted/);
});

test('ledger lines must match their account currency and posted lines are immutable', () => {
  assert.match(sql, /new\.currency_code <> v_account_currency/);
  assert.match(sql, /Journal entries can only be changed while transaction is draft/);
  assert.match(sql, /Moving a journal line between transactions is prohibited/);
});

test('reversal creates a new compensating journal and is idempotent', () => {
  assert.match(sql, /v_key := 'reverse:' \|\| v_original\.id::text/);
  assert.match(sql, /credit_amount, debit_amount/);
  assert.match(sql, /Only posted transactions can be reversed/);
  assert.match(sql, /status = 'reversed', reversed_by = v_reversal\.id/);
});

test('posting and reversal create audit events', () => {
  assert.match(sql, /insert into public\.avcu_ledger_audit_events/);
  assert.match(sql, /event_type,event_type|event_type,actor_role/);
});

test('journal audit records are protected from browser and service-role direct writes', () => {
  assert.match(sql, /revoke all on public\.avcu_ledger_audit_events from public, anon, authenticated, service_role/);
});

test('draft journals are created only through an idempotent server function', () => {
  assert.match(migration, /create or replace function public\.avcu_create_draft_ledger_transaction/);
  assert.match(migration, /request_fingerprint text/);
  assert.match(migration, /digest\(jsonb_build_object/);
  assert.match(migration, /Idempotency key was already used for a different journal request/);
  assert.match(migration, /between 2 and 500 entries/);
  assert.match(migration, /grant execute on function public\.avcu_create_draft_ledger_transaction/);
});

test('service role cannot bypass controlled journal writes', () => {
  assert.match(migration, /revoke insert, update, delete on public\.avcu_ledger_transactions from service_role/);
  assert.match(migration, /revoke insert, update, delete on public\.avcu_ledger_entries from service_role/);
  assert.match(migration, /grant select on public\.avcu_ledger_transactions, public\.avcu_ledger_entries to service_role/);
});

test('transaction state changes require function-local operation markers', () => {
  assert.match(migration, /before insert or update on public\.avcu_ledger_transactions/);
  assert.match(migration, /v_operation is distinct from 'post'/);
  assert.match(migration, /v_operation is distinct from 'reverse'/);
  assert.match(migration, /set_config\('avcu\.ledger_operation','post',true\)/);
  assert.match(migration, /set_config\('avcu\.ledger_operation','reverse',true\)/);
});
