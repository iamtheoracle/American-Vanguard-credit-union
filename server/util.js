import crypto from 'node:crypto';

export const COOKIE_MEMBER = 'avcu_member';
export const COOKIE_OPERATOR = 'avcu_ops';

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function setSessionCookie(res, name, token, maxAgeSeconds, secure) {
  const attrs = [`${name}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`];
  if (secure) attrs.push('Secure');
  const existing = res.getHeader('Set-Cookie');
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  list.push(attrs.join('; '));
  res.setHeader('Set-Cookie', list);
}

export function clearSessionCookie(res, name, secure) {
  const attrs = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  const existing = res.getHeader('Set-Cookie');
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  list.push(attrs.join('; '));
  res.setHeader('Set-Cookie', list);
}

// Validate a money amount supplied as integer minor units.
export function validAmountCents(value, { maxCents = 100_000_000_00 } = {}) {
  return Number.isSafeInteger(value) && value > 0 && value <= maxCents;
}

export function newReference() {
  return `AVCU-${crypto.randomBytes(5).toString('hex').toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
}

export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function timingSafeEqualStrings(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

// Simple in-memory fixed-window rate limiter (per instance; sufficient for dev scale).
export function rateLimiter({ windowMs = 60_000, max = 10 } = {}) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, times] of hits) {
      const alive = times.filter(t => t > cutoff);
      if (alive.length === 0) hits.delete(key); else hits.set(key, alive);
    }
  }, windowMs).unref();
  return function limiter(key) {
    const cutoff = Date.now() - windowMs;
    const times = (hits.get(key) || []).filter(t => t > cutoff);
    if (times.length >= max) return false;
    times.push(Date.now());
    hits.set(key, times);
    return true;
  };
}

export function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export const PASSWORD_MIN = 10;
export function validPassword(password) {
  return typeof password === 'string' && password.length >= PASSWORD_MIN;
}

export function validEmail(email) {
  return typeof email === 'string' && email.length >= 5 && email.length <= 200 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

// Universal username: 4-24 characters, starts with a letter, no ambiguous punctuation.
export const USERNAME_RE = /^[a-z][a-z0-9._-]{3,23}$/;
export function validUsername(username) {
  return typeof username === 'string' && USERNAME_RE.test(username);
}

// Numeric member number (8 digits, never reused).
export const MEMBER_NUMBER_RE = /^\d{8}$/;
export function validMemberNumber(value) {
  return typeof value === 'string' && MEMBER_NUMBER_RE.test(value);
}

export function validIdentifier(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) return false;
  return validEmail(trimmed) || validUsername(trimmed.toLowerCase()) || validMemberNumber(trimmed);
}

// Verification codes are stored hashed, never in plain text.
export function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

export function numericCode(digits = 6) {
  const max = 10 ** digits;
  return String(crypto.randomInt(0, max)).padStart(digits, '0');
}
