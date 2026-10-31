import bcrypt from 'bcryptjs';
import { audit, bindActorContext } from './db.js';
import * as authRepo from './repositories/auth.js';
import { COOKIE_MEMBER, COOKIE_OPERATOR, parseCookies, setSessionCookie, clearSessionCookie, newToken } from './util.js';

export const MEMBER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;      // 12h
export const OPERATOR_SESSION_TTL_MS = 30 * 60 * 1000;         // 30 min (privileged roles rotate often)

export async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function expiry(ttl) {
  return new Date(Date.now() + ttl);
}

export async function createMemberSession(memberId) {
  const token = newToken();
  await authRepo.createMemberSession(token, memberId, expiry(MEMBER_SESSION_TTL_MS));
  return { token, ttlSeconds: Math.floor(MEMBER_SESSION_TTL_MS / 1000) };
}

export async function createOperatorSession(operatorId) {
  const token = newToken();
  await authRepo.createOperatorSession(token, operatorId, expiry(OPERATOR_SESSION_TTL_MS));
  return { token, ttlSeconds: Math.floor(OPERATOR_SESSION_TTL_MS / 1000) };
}

export async function destroySession(kind, token) {
  await authRepo.destroySession(kind, token);
}

export async function destroyAllSessions(kind, subjectId) {
  await authRepo.destroyAllSessions(kind, subjectId);
}

export function memberAuth(req, res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE_MEMBER];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  authRepo.findMemberSession(token).then(({ rows }) => {
    const row = rows[0];
    if (!row || new Date(row.expires_at) <= new Date()) {
      return res.status(401).json({ error: 'Session expired or invalid' });
    }
    req.member = { id: row.id, memberNumber: String(row.member_number), email: row.email, fullName: row.full_name, status: row.status };
    req.sessionToken = token;
    bindActorContext(req, res, { type: 'member', id: row.id, role: 'member' }, next);
  }).catch(next);
}

export function operatorAuth(req, res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE_OPERATOR];
  if (!token) return res.status(401).json({ error: 'Operator authentication required' });
  authRepo.findOperatorSession(token).then(({ rows }) => {
    const row = rows[0];
    if (!row || !row.active || new Date(row.expires_at) <= new Date()) {
      return res.status(401).json({ error: 'Operator session expired or invalid' });
    }
    req.operator = { id: row.id, email: row.email, name: row.name || row.full_name, role: row.role };
    req.sessionToken = token;
    bindActorContext(req, res, { type: 'operator', id: row.id, role: row.role }, next);
  }).catch(next);
}

// Server-enforced permission gate. Frontend visibility is never a control.
export function requireOperatorRole(...roles) {
  return (req, res, next) => {
    if (!req.operator) return res.status(401).json({ error: 'Operator authentication required' });
    if (!roles.includes(req.operator.role)) {
      audit(null, {
        actorType: 'operator', actorId: req.operator.id, actorRole: req.operator.role,
        action: 'permission.denied', entityType: 'endpoint', entityId: req.originalUrl,
        metadata: { required: roles, method: req.method }
      }).catch(() => {});
      return res.status(403).json({ error: 'Insufficient permissions for this operation' });
    }
    next();
  };
}

export function applySessionCookie(req, res, kind, { token, ttlSeconds }) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  setSessionCookie(res, kind === 'member' ? COOKIE_MEMBER : COOKIE_OPERATOR, token, ttlSeconds, secure);
}

export function clearAuthCookie(req, res, kind) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  clearSessionCookie(res, kind === 'member' ? COOKIE_MEMBER : COOKIE_OPERATOR, secure);
}

export async function findMemberByEmail(email) {
  const { rows } = await authRepo.findMemberByEmail(email);
  return rows[0] || null;
}

export async function findMemberByLogin(identifier) {
  const value = String(identifier || '').trim();
  const { rows } = await authRepo.findMemberByLogin(value);
  return rows[0] || null;
}

export async function findOperatorByEmail(email) {
  const { rows } = await authRepo.findOperatorByEmail(email);
  return rows[0] || null;
}
