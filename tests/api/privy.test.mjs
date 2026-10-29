import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestServer, api, loginMember } from './helpers.mjs';
import { verifyPrivyAccessToken } from '../../server/integrations/privy.js';

function makeToken(privateKey, appId, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    aud: appId, iss: 'privy.io', sub: 'did:privy:test-user', iat: now, exp: now + 300, ...overrides
  })).toString('base64url');
  const input = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(input), {
    key: privateKey, dsaEncoding: 'ieee-p1363'
  }).toString('base64url');
  return `${input}.${signature}`;
}

test('Privy access token verification checks signature, audience and expiry', t => {
  const previous = {
    appId: process.env.PRIVY_APP_ID,
    appSecret: process.env.PRIVY_APP_SECRET,
    verificationKey: process.env.PRIVY_VERIFICATION_KEY
  };
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  process.env.PRIVY_APP_ID = 'avcu-test-app';
  process.env.PRIVY_APP_SECRET = 'test-secret';
  process.env.PRIVY_VERIFICATION_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      const name = ({ appId: 'PRIVY_APP_ID', appSecret: 'PRIVY_APP_SECRET',
        verificationKey: 'PRIVY_VERIFICATION_KEY' })[key];
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const token = makeToken(pair.privateKey, 'avcu-test-app');
  assert.equal(verifyPrivyAccessToken(token).sub, 'did:privy:test-user');
  assert.throws(() => verifyPrivyAccessToken(makeToken(pair.privateKey, 'another-app')),
    error => error.code === 'privy_token_invalid');
  assert.throws(() => verifyPrivyAccessToken('not.a.jwt'),
    error => error.code === 'privy_token_invalid');
});

test('member can link only a server-verified Privy identity and its canonical wallet list', async t => {
  const previous = {
    appId: process.env.PRIVY_APP_ID,
    appSecret: process.env.PRIVY_APP_SECRET,
    verificationKey: process.env.PRIVY_VERIFICATION_KEY
  };
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  process.env.PRIVY_APP_ID = 'avcu-test-app';
  process.env.PRIVY_APP_SECRET = 'test-secret';
  process.env.PRIVY_VERIFICATION_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      const name = ({ appId: 'PRIVY_APP_ID', appSecret: 'PRIVY_APP_SECRET',
        verificationKey: 'PRIVY_VERIFICATION_KEY' })[key];
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const token = makeToken(pair.privateKey, 'avcu-test-app');
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://auth.privy.io/api/v1/users/')) {
      assert.match(options.headers.Authorization, /^Basic /);
      return new Response(JSON.stringify({
        id: 'did:privy:test-user',
        linked_accounts: [
          { type: 'wallet', address: '0x1111111111111111111111111111111111111111',
            chain_type: 'ethereum', wallet_client_type: 'privy' },
          { type: 'email', address: 'not-a-wallet@example.com' }
        ]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(url, options);
  };
  const linked = await api(env.base, '/api/wallets/privy/link', {
    method: 'POST', cookie, body: { accessToken: token }
  });
  assert.equal(linked.status, 200);
  assert.equal(linked.data.linked, true);
  assert.equal(linked.data.walletCount, 1);
  assert.equal(linked.data.transfersEnabled, false);

  const status = await api(env.base, '/api/wallets/privy/status', { cookie });
  assert.equal(status.status, 200);
  assert.equal(status.data.account.privy_user_id, 'did:privy:test-user');
  assert.equal(status.data.account.wallets.length, 1);

  const unlinked = await api(env.base, '/api/wallets/privy/link', { method: 'DELETE', cookie });
  assert.equal(unlinked.status, 200);
  assert.equal(unlinked.data.linked, false);
});
