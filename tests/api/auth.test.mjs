import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, loginMember, setCookieFrom, MEMBER_PASSWORD } from './helpers.mjs';
import { stopNotificationWorker } from '../../server/notifications.js';

test('authentication and session lifecycle', async t => {
  const env = await startTestServer();
  t.after(() => env.close());

  // 1. Register creates a pending application, not a verified member.
  const reg = await api(env.base, '/api/auth/register', {
    method: 'POST', body: { email: 'newmember@avcu.demo', username: 'alex_rivera', password: 'Str0ngPassphrase!', fullName: 'Alex Rivera' }
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  assert.equal(reg.data.member.status, 'pending');
  assert.match(reg.data.member.memberNumber, /^\d{10}$/, 'registration assigns a 10-digit numeric member ID');
  assert.equal(reg.data.member.username, 'alex_rivera');
  process.env.AVCU_PUBLIC_BASE_URL = 'https://avcu.test';
  stopNotificationWorker(); // Keep the test outbox stable while extracting the synthetic reset link.
  const resetRequest = await api(env.base, '/api/auth/password-reset/request', {
    method: 'POST', body: { identifier: reg.data.member.username }
  });
  assert.equal(resetRequest.status, 202);
  const db = await import('../../server/db.js');
  const { rows: resetEmails } = await db.query(
    "SELECT email_text FROM notification_outbox WHERE member_id = $1 AND event_type = 'auth.password_reset' ORDER BY created_at DESC LIMIT 1",
    [reg.data.member.id]
  );
  assert.equal(resetEmails.length, 1, 'reset instructions are queued for the verified member email');
  const resetMatch = resetEmails[0].email_text.match(/https:\/\/avcu\.test\/member-portal\.html\?resetToken=([A-Za-z0-9_-]+)/);
  assert.ok(resetMatch, 'reset email contains a valid portal link');
  const resetToken = resetMatch[1];
  const { rows: tokenRows } = await db.query('SELECT token_hash FROM password_reset_tokens WHERE member_id = $1', [reg.data.member.id]);
  assert.equal(tokenRows.length, 1);
  assert.notEqual(tokenRows[0].token_hash, resetToken, 'only a token hash is persisted');
  const resetComplete = await api(env.base, '/api/auth/password-reset/complete', {
    method: 'POST', body: { token: resetToken, password: 'NewSecurePassphrase!' }
  });
  assert.equal(resetComplete.status, 200);
  const { rows: scrubbedResetPayload } = await db.query(
    "SELECT email_text, body FROM notification_outbox WHERE event_type = 'auth.password_reset' AND member_id = $1",
    [reg.data.member.id]
  );
  assert.equal(scrubbedResetPayload[0].email_text, '');
  assert.equal(scrubbedResetPayload[0].body, '');
  const oldPasswordLogin = await api(env.base, '/api/auth/login', {
    method: 'POST', body: { identifier: reg.data.member.username, password: 'Str0ngPassphrase!' }
  });
  assert.equal(oldPasswordLogin.status, 401);
  const newPasswordLogin = await api(env.base, '/api/auth/login', {
    method: 'POST', body: { identifier: reg.data.member.username, password: 'NewSecurePassphrase!' }
  });
  assert.equal(newPasswordLogin.status, 200);
  const tokenReuse = await api(env.base, '/api/auth/password-reset/complete', {
    method: 'POST', body: { token: resetToken, password: 'AnotherSecurePassphrase!' }
  });
  assert.equal(tokenReuse.status, 400, 'reset tokens are single-use');

  // 2. Registration validation.
  const bad = await api(env.base, '/api/auth/register', {
    method: 'POST', body: { email: 'nope', password: 'short', fullName: 'X' }
  });
  assert.equal(bad.status, 400);
  const dupe = await api(env.base, '/api/auth/register', {
    method: 'POST', body: { email: 'newmember@avcu.demo', username: 'alex_rivera', password: 'Str0ngPassphrase!', fullName: 'Alex Rivera' }
  });
  assert.equal(dupe.status, 409);

  // 3. Login with wrong password fails; correct password succeeds.
  const wrong = await api(env.base, '/api/auth/login', {
    method: 'POST', body: { email: 'jordan@avcu.demo', password: 'wrong-password' }
  });
  assert.equal(wrong.status, 401);
  const { response: login, cookie } = await loginMember(env.base);
  assert.equal(login.status, 200);
  assert.equal(login.data.member.status, 'verified');
  assert.match(login.data.member.memberNumber, /^\d{10}$/);
  assert.ok(cookie);
  const numericLogin = await api(env.base, '/api/auth/login', {
    method: 'POST', body: { identifier: login.data.member.memberNumber, password: MEMBER_PASSWORD }
  });
  assert.equal(numericLogin.status, 200, 'member number should work independently from email');
  assert.equal(numericLogin.data.member.id, login.data.member.id);

  // 4. Session works, logout invalidates it.
  const me = await api(env.base, '/api/auth/me', { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.data.member.email, 'jordan@avcu.demo');
  const out = await api(env.base, '/api/auth/logout', { method: 'POST', cookie });
  assert.equal(out.status, 200);
  const after = await api(env.base, '/api/auth/me', { cookie });
  assert.equal(after.status, 401);

  // 5. Session expiry is enforced server-side.
  const { response: login2, cookie: cookie2 } = await loginMember(env.base);
  assert.equal(login2.status, 200);
  const { query } = await import('../../server/db.js');
  const sessionToken = cookie2.split(';')[0].split('=').slice(1).join('=');
  assert.ok(sessionToken);
  await query(`UPDATE member_sessions SET expires_at = now() - interval '1 minute' WHERE token = $1`, [sessionToken]);
  const expired = await api(env.base, '/api/auth/me', { cookie: cookie2 });
  assert.equal(expired.status, 401);

  // 6. Anonymous access to protected data is denied.
  const anon = await api(env.base, '/api/accounts');
  assert.equal(anon.status, 401);
});

test('member data isolation', async t => {
  const env = await startTestServer();
  t.after(() => env.close());

  await api(env.base, '/api/auth/register', {
    method: 'POST', body: { email: 'isolation@avcu.demo', username: 'riley_fox', password: 'Str0ngPassphrase!', fullName: 'Riley Fox' }
  });
  const { cookie: cookieB } = await loginMember(env.base, 'isolation@avcu.demo', 'Str0ngPassphrase!');
  // Pending member cannot see accounts and cannot move money.
  const accountsB = await api(env.base, '/api/accounts', { cookie: cookieB });
  assert.equal(accountsB.status, 200);
  assert.equal(accountsB.data.accounts.length, 0);
  const { cookie: cookieA } = await loginMember(env.base);
  const accountsA = await getAccountsSafe(env.base, cookieA);
  const foreignId = accountsA[0].id;
  const steal = await api(env.base, '/api/transfers', {
    method: 'POST', cookie: cookieB,
    body: { kind: 'share', fromAccountId: foreignId, toAccountId: foreignId, amountCents: 100 }
  });
  assert.equal(steal.status, 403); // pending verification
  const foreignTx = await api(env.base, `/api/support/cases`, { cookie: cookieB });
  assert.ok(Array.isArray(foreignTx.data.cases));
  assert.equal(foreignTx.data.cases.length, 0);
});

async function getAccountsSafe(base, cookie) {
  const r = await api(base, '/api/accounts', { cookie });
  assert.equal(r.status, 200);
  return r.data.accounts;
}
