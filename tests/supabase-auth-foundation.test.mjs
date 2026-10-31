import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('AVCU member identity migration keeps client writes disabled', async () => {
  const sql = await readFile(new URL('../supabase/migrations/202610310001_member_identity_foundation.sql', import.meta.url), 'utf8');
  assert.match(sql, /references auth\.users\(id\) on delete restrict/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /auth_user_id = \(select auth\.uid\(\)\)/i);
  assert.match(sql, /revoke all on public\.member_profiles from anon, authenticated/i);
  assert.match(sql, /grant select on public\.member_profiles to authenticated/i);
  assert.doesNotMatch(sql, /for (insert|update|delete).*to authenticated/i);
  assert.match(sql, /not a financial ledger/i);
});

test('AVCU auth foundation documents prohibit public signup and browser service keys', async () => {
  const docs = await readFile(new URL('../docs/supabase-auth-foundation.md', import.meta.url), 'utf8');
  assert.match(docs, /Disable public signups/i);
  assert.match(docs, /Never put a service-role key in browser code/i);
  assert.match(docs, /same user-facing response/i);
  assert.match(docs, /Do not publish a production login route/i);
});
