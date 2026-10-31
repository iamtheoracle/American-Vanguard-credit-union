import { query } from '../db.js';

// Authentication repository: cookie tokens are only looked up server-side.
// Never return session tokens to a browser response.
export const createMemberSession = (token, memberId, expiresAt) =>
  query('INSERT INTO member_sessions (token, member_id, expires_at) VALUES ($1,$2,$3)', [token, memberId, expiresAt]);
export const createOperatorSession = (token, operatorId, expiresAt) =>
  query('INSERT INTO operator_sessions (token, operator_id, expires_at) VALUES ($1,$2,$3)', [token, operatorId, expiresAt]);
export function destroySession(kind, token) {
  if (kind === 'member') return query('DELETE FROM member_sessions WHERE token = $1', [token]);
  if (kind === 'operator') return query('DELETE FROM operator_sessions WHERE token = $1', [token]);
  throw new TypeError('Unknown session kind');
}
export function destroyAllSessions(kind, subjectId) {
  if (kind === 'member') return query('DELETE FROM member_sessions WHERE member_id = $1', [subjectId]);
  if (kind === 'operator') return query('DELETE FROM operator_sessions WHERE operator_id = $1', [subjectId]);
  throw new TypeError('Unknown session kind');
}
export const findMemberSession = token => query(`SELECT m.id, m.member_number, m.email, m.full_name, m.status, s.token, s.expires_at
  FROM member_sessions s JOIN members m ON m.id = s.member_id WHERE s.token = $1`, [token]);
export const findOperatorSession = token => query(`SELECT o.id, o.email, o.name, o.role, o.active, s.token, s.expires_at
  FROM operator_sessions s JOIN operators o ON o.id = s.operator_id WHERE s.token = $1`, [token]);
export const findMemberByEmail = email => query('SELECT * FROM members WHERE lower(email) = lower($1)', [email]);
export const findMemberByLogin = value => query(
  'SELECT * FROM members WHERE lower(email) = lower($1) OR member_number::text = $1 OR lower(username) = lower($1) LIMIT 1', [value]);
export const findOperatorByEmail = email => query('SELECT * FROM operators WHERE lower(email) = lower($1) AND active', [email]);
