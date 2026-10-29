import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const [html, js, css, netlify, memberApi, adminApi, identityHook] = await Promise.all([
  read('index.html'),
  read('app.js'),
  read('auth.css'),
  read('netlify.toml'),
  read('netlify/functions/member-api.mjs'),
  read('netlify/functions/admin-reviews.mjs'),
  read('netlify/functions/identity.mjs')
]);

test('member landing page presents the institutional disclaimer and email/password access', () => {
  assert.match(html, /not a chartered credit union/i);
  assert.match(html, /not deposit-insured/i);
  assert.match(html, /No live payment network is connected/i);
  assert.match(html, /A share in/);
  assert.match(html, /type="email"/);
  assert.match(html, /type="password"/);
  assert.match(html, /Forgot password\?/);
  assert.match(html, /Google, Apple and X sign-in are not accepted/i);
});

test('member interface does not fabricate balances or ledger activity', () => {
  assert.match(html, /Balance unavailable/);
  assert.match(html, /No authoritative account data connected/);
  assert.match(html, /No ledger connected/);
  assert.match(html, /A requested credit is not a deposit/i);
  assert.doesNotMatch(html, /\$12,480\.65|\$3,240\.65|\$6,840\.00/);
});

test('registration, confirmation, recovery and member submission have UI handlers', () => {
  assert.match(js, /signup\(/);
  assert.match(js, /handleAuthCallback\(/);
  assert.match(js, /recovery_token/);
  assert.match(js, /recoverPassword\(/);
  assert.match(js, /memberRequest\('POST'/);
  assert.match(html, /id="auth-form"/);
  assert.match(html, /id="application-form"/);
});

test('member API scopes application reads and writes to authenticated identity', () => {
  assert.match(memberApi, /await getUser\(\)/);
  assert.match(memberApi, /WHERE a\.identity_user_id = \$\{String\(user\.id\)\}/);
  assert.match(memberApi, /identity_user_id, email, full_name/);
  assert.match(memberApi, /Request origin could not be verified/);
  assert.match(memberApi, /Cache-Control.*no-store/);
});

test('staff review API requires server-side admin role, a note and a valid decision', () => {
  assert.match(adminApi, /user\.roles\.includes\("admin"\)/);
  assert.match(adminApi, /\["approved", "rejected", "resubmission"\]/);
  assert.match(adminApi, /note\.length < 3/);
  assert.match(adminApi, /INSERT INTO verification_review_events/);
  assert.match(adminApi, /already been decided/);
  assert.match(adminApi, /Request origin could not be verified/);
});

test('new accounts receive member role and cannot self-assign admin through signup', () => {
  assert.match(identityHook, /userSignup\(event\)/);
  assert.match(identityHook, /current\.filter\(role => role !== "admin"\)/);
  assert.match(identityHook, /"member"/);
  assert.doesNotMatch(identityHook, /roles\.push\(["']admin/);
});

test('Netlify build publishes generated frontend and configures same-origin security headers', () => {
  assert.match(netlify, /command = "npm run build && npm run check"/);
  assert.match(netlify, /publish = "public"/);
  assert.match(netlify, /Content-Security-Policy/);
  assert.match(netlify, /connect-src 'self'/);
  assert.match(netlify, /node_bundler = "esbuild"/);
});

test('review interface supports approve, reject and resubmission with required notes', () => {
  assert.match(js, /\['approved','Approve'\],\['rejected','Reject'\],\['resubmission','Request resubmission'\]/);
  assert.match(js, /Review note \(required\)/);
  assert.match(js, /note\.required = true/);
  assert.match(js, /Decision recorded in review history/);
});

test('identity verification provider is not represented as integrated KYC', () => {
  assert.match(html, /does not verify identity/i);
  assert.match(html, /not a real credit union account|not a chartered credit union/i);
  assert.doesNotMatch(js, /identity document verified|KYC complete|identity verification provider connected/i);
});
