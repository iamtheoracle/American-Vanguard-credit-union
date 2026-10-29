import crypto from 'node:crypto';

const PRIVY_API = 'https://auth.privy.io/api/v1';

export function privyConfigured() {
  return Boolean(process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET &&
    process.env.PRIVY_VERIFICATION_KEY);
}

/**
 * Verify Privy's ES256 access token using the app verification key from the
 * Privy dashboard. Audience, expiry and subject are checked after signature.
 */
export function verifyPrivyAccessToken(token) {
  if (!privyConfigured()) {
    const error = new Error('Privy is not configured');
    error.code = 'privy_not_configured';
    throw error;
  }
  try {
    if (typeof token !== 'string' || token.length > 8192) throw new Error('invalid token');
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('invalid token');
    const decode = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const header = decode(parts[0]);
    const claims = decode(parts[1]);
    if (header.alg !== 'ES256') throw new Error('unsupported algorithm');
    const key = crypto.createPublicKey(process.env.PRIVY_VERIFICATION_KEY.replace(/\\n/g, '\n'));
    const signature = Buffer.from(parts[2], 'base64url');
    const valid = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`),
      { key, dsaEncoding: 'ieee-p1363' }, signature);
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const now = Math.floor(Date.now() / 1000);
    if (!valid || !audience.includes(process.env.PRIVY_APP_ID) ||
        typeof claims.sub !== 'string' || !claims.sub.startsWith('did:privy:') ||
        !Number.isFinite(claims.exp) || claims.exp <= now ||
        (Number.isFinite(claims.iat) && claims.iat > now + 60) ||
        claims.iss !== 'privy.io') throw new Error('invalid claims');
    return claims;
  } catch {
    const error = new Error('Privy access token verification failed');
    error.code = 'privy_token_invalid';
    throw error;
  }
}

/** Retrieve the canonical Privy user and linked accounts using server credentials. */
export async function fetchPrivyUser(userId) {
  if (!privyConfigured()) {
    const error = new Error('Privy is not configured');
    error.code = 'privy_not_configured';
    throw error;
  }
  const credentials = Buffer.from(`${process.env.PRIVY_APP_ID}:${process.env.PRIVY_APP_SECRET}`).toString('base64');
  let response;
  try {
    response = await fetch(`${PRIVY_API}/users/${encodeURIComponent(userId)}`, {
      headers: {
        Authorization: `Basic ${credentials}`,
        'privy-app-id': process.env.PRIVY_APP_ID,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    const error = new Error('Privy identity service unavailable');
    error.code = 'privy_identity_unavailable';
    throw error;
  }
  if (!response.ok) {
    const error = new Error('Privy identity lookup failed');
    error.code = response.status >= 500 ? 'privy_identity_unavailable' : 'privy_token_invalid';
    throw error;
  }
  const user = await response.json().catch(() => null);
  return user && typeof user.id === 'string' ? user : null;
}
