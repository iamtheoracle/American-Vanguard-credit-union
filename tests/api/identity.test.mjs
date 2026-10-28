import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, loginMember, setCookieFrom } from './helpers.mjs';

const STRONG = 'Str0ngPassphrase!';

test('registration issues a unique numeric member number and a separate username', async t => {
  const env = await startTestServer();
  t.after(() => env.close());

  const first = await api(env.base, '/api/auth/register', {
    method: 'POST',
    body: { email: 'alex@avcu.demo', username: 'alex.rivera', password: STRONG, fullName: 'Alex Rivera' }
  });
  assert.equal(first.status, 201);
  assert.match(first.data.member.memberNumber, /^\d{8}$/);
  assert.equal(first.data.member.username, 'alex.rivera');
  assert.equal(first.data.member.status, 'pending');

  const second = await api(env.base, '/api/auth/register', {
    method: 'POST',
    body: { email: 'sam@avcu.demo', username: 'sam.lee', password: STRONG, fullName: 'Sam Lee' }
  });
  assert.equal(second.status, 201);
  assert.notEqual(second.data.member.memberNumber, first.data.member.memberNumber);
  assert.notEqual(second.data.member.username, first.data.member.username);

  const duplicateUsername = await api(env.base, '/api/auth/register', {
    method: 'POST',
    body: { email: 'other@avcu.demo', username: 'ALEX.RIVERA', password: STRONG, fullName: 'Other Person' }
  });
  assert.equal(duplicateUsername.status, 409);

  const invalidUsername = await api(env.base, '/api/auth/register', {
    method: 'POST',
    body: { email: 'bad@avcu.demo', username: '9', password: STRONG, fullName: 'Bad Username' }
  });
  assert.equal(invalidUsername.status, 400);

  const { query } = await import('../../server/db.js');
  const { rows } = await query(
    `SELECT member_number, username FROM members WHERE username IN ('alex.rivera','sam.lee') ORDER BY username`);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].member_number, rows[1].member_number);
});

test('members sign in with email, username, or numeric member number', async t => {
  const env = await startTestServer();
  t.after(() => env.close());

  const byEmail = await api(env.base, '/api/auth/login', {
    method: 'POST', body: { identifier: 'jordan@avcu.demo', password: 'Member!Demo2026' }
  });
  assert.equal(byEmail.status, 200);
  assert.equal(byEmail.data.member.username, 'jordan.hale');
  assert.match(byEmail.data.member.memberNumber, /^\d{8}$/);

  const byUsername = await api(env.base, '/api/auth/login', {
    method: 'POST', body: { identifier: 'jordan.hale', password: 'Member!Demo2026' }
  });
  assert.equal(byUsername.status, 200);

  const byNumber = await api(env.base, '/api/auth/login', {
    method: 'POST', body: { identifier: byEmail.data.member.memberNumber, password: 'Member!Demo2026' }
  });
  assert.equal(byNumber.status, 200);

  const legacyEmailField = await api(env.base, '/api/auth/login', {
    method: 'POST', body: { email: 'jordan@avcu.demo', password: 'Member!Demo2026' }
  });
  assert.equal(legacyEmailField.status, 200);

  const wrong = await api(env.base, '/api/auth/login', {
    method: 'POST', body: { identifier: 'jordan.hale', password: 'wrong-password' }
  });
  assert.equal(wrong.status, 401);
});

test('accounts expose full account and routing numbers with ledger detail', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const accounts = await api(env.base, '/api/accounts', { cookie });
  assert.equal(accounts.status, 200);
  assert.equal(accounts.data.accounts.length, 4);
  const numbers = new Set();
  for (const account of accounts.data.accounts) {
    assert.match(account.accountNumber, /^4002\d{8}$/);
    assert.equal(account.routingNumber, '091000019');
    assert.ok(!numbers.has(account.accountNumber), 'account numbers are unique');
    numbers.add(account.accountNumber);
    assert.ok(account.openedAt);
  }

  const detail = await api(env.base, `/api/accounts/${accounts.data.accounts.find(a => a.name === 'Share Draft').id}`, { cookie });
  assert.equal(detail.status, 200);
  assert.ok(Array.isArray(detail.data.entries));
  assert.ok(detail.data.entries.length >= 1, 'seeded ledger entries are returned');

  const other = await api(env.base, '/api/accounts/00000000-0000-0000-0000-000000000000', { cookie });
  assert.equal(other.status, 404);
});

test('profile update, password rotation, and session invalidation', async t => {
  const env = await startTestServer();
  t.after(() => env.close());

  const first = await loginMember(env.base);
  const second = await loginMember(env.base);
  assert.ok(first.cookie && second.cookie);

  const profile = await api(env.base, '/api/profile', {
    method: 'PATCH', cookie: first.cookie,
    body: { phone: '(555) 010-2030', mailingAddress: '12 Liberty Lane, Arlington, VA' }
  });
  assert.equal(profile.status, 200);
  assert.equal(profile.data.profile.phone, '(555) 010-2030');

  const badPhone = await api(env.base, '/api/profile', {
    method: 'PATCH', cookie: first.cookie, body: { phone: 'call me' }
  });
  assert.equal(badPhone.status, 400);

  const wrongCurrent = await api(env.base, '/api/auth/password', {
    method: 'POST', cookie: first.cookie,
    body: { currentPassword: 'not-my-password', newPassword: 'An0therPassphrase!' }
  });
  assert.equal(wrongCurrent.status, 403);

  const changed = await api(env.base, '/api/auth/password', {
    method: 'POST', cookie: first.cookie,
    body: { currentPassword: 'Member!Demo2026', newPassword: 'An0therPassphrase!' }
  });
  assert.equal(changed.status, 200);

  // The session that changed the password stays valid; other sessions do not.
  const me = await api(env.base, '/api/auth/me', { cookie: first.cookie });
  assert.equal(me.status, 200);
  const other = await api(env.base, '/api/auth/me', { cookie: second.cookie });
  assert.equal(other.status, 401);

  const oldPassword = await api(env.base, '/api/auth/login', {
    method: 'POST', body: { identifier: 'jordan.hale', password: 'Member!Demo2026' }
  });
  assert.equal(oldPassword.status, 401);
  const newPassword = await api(env.base, '/api/auth/login', {
    method: 'POST', body: { identifier: 'jordan.hale', password: 'An0therPassphrase!' }
  });
  assert.equal(newPassword.status, 200);
});

test('email verification uses a hashed six-digit code', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  await api(env.base, '/api/auth/register', {
    method: 'POST',
    body: { email: 'verify@avcu.demo', username: 'verify.me', password: STRONG, fullName: 'Verity Mail' }
  });
  const { cookie } = await loginMember(env.base, 'verify@avcu.demo', STRONG);

  const wrong = await api(env.base, '/api/auth/email/verify', {
    method: 'POST', cookie, body: { code: '000000' }
  });
  assert.equal(wrong.status, 400);

  const requested = await api(env.base, '/api/auth/email/verification-code', { method: 'POST', cookie });
  assert.equal(requested.status, 200);
  assert.equal(requested.data.delivery, 'shown-in-app');
  assert.match(String(requested.data.code), /^\d{6}$/);

  const { query } = await import('../../server/db.js');
  const { rows } = await query('SELECT code_hash FROM email_verifications');
  assert.notEqual(rows[0].code_hash, requested.data.code, 'codes are stored hashed');

  const verified = await api(env.base, '/api/auth/email/verify', {
    method: 'POST', cookie, body: { code: requested.data.code }
  });
  assert.equal(verified.status, 200);
  assert.equal(verified.data.emailVerified, true);

  const me = await api(env.base, '/api/auth/me', { cookie });
  assert.equal(me.data.member.emailVerified, true);
});

test('session cookies are HttpOnly and never expose tokens in JSON', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const response = await api(env.base, '/api/auth/login', {
    method: 'POST', body: { identifier: 'jordan.hale', password: 'Member!Demo2026' }
  });
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.equal(JSON.stringify(response.data).includes(setCookie.split(';')[0]), false);
  assert.ok(setCookieFrom(response));
});
