import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('AVCU auth preview matches the member banking identity and stays non-collecting', async () => {
  const html = await readFile(new URL('../auth-preview.html', import.meta.url), 'utf8');
  assert.match(html, /American Vanguard Credit Union/i);
  assert.match(html, /Continue with Google/);
  assert.match(html, /Email address/);
  assert.match(html, /Forgot password\?/);
  assert.match(html, /Authentication preview only/);
  assert.match(html, /No credentials are sent or stored/);
  assert.match(html, /Preview only: authentication is not connected/);
  assert.doesNotMatch(html, /supabaseServiceRole|service_role|SUPABASE_SERVICE_ROLE_KEY/i);
});

test('AVCU auth preview supports persistent English, German, and Spanish selection', async () => {
  const html = await readFile(new URL('../auth-preview.html', import.meta.url), 'utf8');
  for (const language of ['en', 'de', 'es']) assert.match(html, new RegExp('value="' + language + '"'));
  assert.match(html, /avcu-auth-locale/);
  assert.match(html, /localStorage\.setItem/);
  assert.match(html, /Willkommen zurück/);
  assert.match(html, /Te damos la bienvenida/);
});
