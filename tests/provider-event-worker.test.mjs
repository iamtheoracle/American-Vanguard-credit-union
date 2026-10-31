import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('../supabase/migrations/202610310005_provider_event_worker.sql', import.meta.url), 'utf8');

test('provider event ingestion deduplicates IDs and detects payload conflicts', () => {
  assert.match(sql, /unique \(provider_code, provider_event_id\)/);
  assert.match(sql, /payload_sha256/);
  assert.match(sql, /Provider event ID was replayed with a different payload/);
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

test('service role uses narrow worker functions rather than direct event writes', () => {
  assert.match(sql, /revoke insert, update, delete on public\.avcu_provider_events from service_role/);
  for (const fn of ['avcu_ingest_provider_event','avcu_mark_provider_event_verified','avcu_claim_provider_event','avcu_complete_provider_event','avcu_retry_provider_event','avcu_quarantine_provider_event']) {
    assert.match(sql, new RegExp('grant execute on function public\\.' + fn));
  }
});
