import test from 'node:test';
import assert from 'node:assert/strict';
import { api, startTestServer, loginOperator, OPERATOR_PASSWORD, setCookieFrom } from './helpers.mjs';

test('RCC history page and assets require privileged operator access', async t => {
  const env = await startTestServer();
  t.after(() => env.close());

  for (const path of ['/rcc-history', '/rcc-history.html', '/rcc-history.css', '/rcc-history.js']) {
    const anonymous = await api(env.base, path);
    assert.equal(anonymous.status, 401, `${path} must not be publicly readable`);
    assert.match(anonymous.headers.get('cache-control') || '', /no-store/);
  }

  const member = await api(env.base, '/api/auth/login', {
    method: 'POST',
    body: { email: 'jordan@avcu.demo', password: 'Member!Demo2026' }
  });
  const memberCookie = setCookieFrom(member);
  assert.ok(memberCookie);
  const memberAccess = await api(env.base, '/rcc-history.html', { cookie: memberCookie });
  assert.equal(memberAccess.status, 401, 'member session must not grant operator access');

  const tellerLogin = await api(env.base, '/api/operator/login', {
    method: 'POST',
    body: { email: 'teller@avcu.demo', password: OPERATOR_PASSWORD }
  });
  const tellerCookie = setCookieFrom(tellerLogin);
  assert.ok(tellerCookie);
  const tellerAccess = await api(env.base, '/rcc-history.html', { cookie: tellerCookie });
  assert.equal(tellerAccess.status, 403, 'ordinary operator role must not view corporate financial history');

  const { cookie: managerCookie } = await loginOperator(env.base);
  const page = await api(env.base, '/rcc-history.html', { cookie: managerCookie });
  assert.equal(page.status, 200);
  assert.match(String(page.data), /RCC — Road Construction Company/);
  assert.match(page.headers.get('cache-control') || '', /no-store/);

  for (const path of ['/rcc-history.css', '/rcc-history.js']) {
    const asset = await api(env.base, path, { cookie: managerCookie });
    assert.equal(asset.status, 200, `${path} should be available to authorized management`);
    assert.match(asset.headers.get('cache-control') || '', /no-store/);
  }
});
