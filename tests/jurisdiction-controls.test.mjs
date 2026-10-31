import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('../supabase/migrations/202610310003_jurisdiction_controls.sql', import.meta.url), 'utf8');
const docs = await readFile(new URL('../docs/jurisdiction-and-product-controls.md', import.meta.url), 'utf8');

test('jurisdiction registry separates US, Canada, UK, EU/EEA and wider Europe', () => {
  for (const region of ['US','CA','UK','EU_EEA','EUROPE_NON_EEA']) assert.match(sql, new RegExp("'" + region + "'"));
  assert.match(sql, /'GB','United Kingdom','UK'/);
  assert.match(sql, /'CH','Switzerland','EUROPE_NON_EEA',false,false/);
  assert.match(sql, /'IS','Iceland','EU_EEA',false,true/);
  assert.match(sql, /'LI','Liechtenstein','EU_EEA',false,true/);
  assert.match(sql, /'NO','Norway','EU_EEA',false,true/);
});

test('all seeded countries remain closed by default', () => {
  assert.match(sql, /enabled_for_onboarding boolean not null default false/);
  assert.doesNotMatch(sql, /insert into public\.avcu_jurisdictions[\s\S]*?enabled_for_onboarding\s*\)\s*values[\s\S]*?true/i);
});

test('authorization is scoped by entity, country, customer type and capability', () => {
  for (const field of ['operating_entity_code','where a.operating_entity_code = p_operating_entity_code','country_code','customer_type','capability_code','evidence_reference','approved_by','effective_from']) {
    assert.match(sql, new RegExp(field));
  }
  assert.match(sql, /customer_type in \('individual','business'\)/);
});

test('provider route and approval must both be current and approved', () => {
  assert.match(sql, /a\.approval_status = 'approved'/);
  assert.match(sql, /r\.route_status = 'approved'/);
  assert.match(sql, /a\.effective_until is null or a\.effective_until > now\(\)/);
  assert.match(sql, /a\.review_due_at is null or a\.review_due_at > now\(\)/);
  assert.match(sql, /upper\(p_currency_code\) = any\(r\.supported_currency_codes\)/);
});

test('browser roles cannot execute financial capability predicate', () => {
  assert.match(sql, /revoke all on function public\.avcu_capability_is_enabled[\s\S]*?from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.avcu_capability_is_enabled[\s\S]*?to service_role/i);
  assert.match(sql, /revoke all on public\.avcu_product_authorizations from anon, authenticated/i);
});

test('docs keep legal permissions and production launch distinct from region membership', () => {
  assert.match(docs, /not licences/i);
  assert.match(docs, /No authorization row means denied/i);
  assert.match(docs, /Production banking remains disabled/i);
});
