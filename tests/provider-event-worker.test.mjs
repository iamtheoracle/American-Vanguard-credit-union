import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('../supabase/migrations/202610310005_provider_event_worker.sql', import.meta.url), 'utf8');
const baseSchema = await readFile(new URL('../supabase/migrations/202610310002_banking_foundation.sql', import.meta.url), 'utf8');

test('provider event ingestion deduplicates IDs and detects payload conflicts', () => {
  assert.match(baseSchema, /unique \(provider_code, provider_event_id\)/);
  assert.match(sql, /payload_sha256/);
  assert.match(sql, /payload_hash_conflict/);
  assert.match(sql, /Do not raise here: an exception would roll back this audit evidence/);
  assert.match(sql, /avcu_provider_event_conflicts/);
});

test('events cannot be processed before server-side signature verification', () => {
  assert.match(sql, /signature_verified = true/);
  assert.match(sql, /avcu_mark_provider_event_verified/);
  assert.match(sql, /documented algorithm, timestamp tolerance, key rotation and raw request bytes/);
});

test('worker claims are concurrent-safe and protected by expiring lease tokens', () => {
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /lease_token = gen_random_uuid\(\)/);
  assert.match(sql, /lease_expires_at > now\(\)/);
  assert.match(sql, /processing_status = 'processing'/);
});

test('retry is bounded and repeated failures are quarantined', () => {
  assert.match(sql, /attempt_count < 10/);
  assert.match(sql, /case when attempt_count >= 10 then 'quarantined' else 'retry' end/);
  assert.match(sql, /p_retry_after_seconds > 86400/);
});

test('service role uses narrow worker functions and cannot attest provider signatures', () => {
  assert.ok(sql.includes('revoke insert, update, delete on public.avcu_provider_events from service_role'));
  for (const fn of ['avcu_ingest_provider_event','avcu_claim_provider_event','avcu_complete_provider_event','avcu_retry_provider_event','avcu_quarantine_provider_event']) {
    assert.ok(sql.includes('grant execute on function public.' + fn + '('), fn + ' must have an explicit execute grant');
  }
  assert.ok(sql.toLowerCase().includes('grant execute on function public.avcu_mark_provider_event_verified(uuid,text) to avcu_provider_verifier'));
  assert.equal(sql.toLowerCase().includes('grant execute on function public.avcu_mark_provider_event_verified(uuid,text) to service_role'), false);
});

test('legacy unproven verification is quarantined and payload hashes are backfilled', () => {
  assert.match(sql, /where payload_sha256 is null/);
  assert.match(sql, /legacy_verification_unproven/);
  assert.match(sql, /where signature_verified = true\s+and signature_verified_at is null/);
});

test('worker timing inputs reject null and out-of-range values', () => {
  assert.match(sql, /p_lease_seconds is null or p_lease_seconds < 10 or p_lease_seconds > 300/);
  assert.match(sql, /p_retry_after_seconds is null or p_retry_after_seconds < 5 or p_retry_after_seconds > 86400/);
});
