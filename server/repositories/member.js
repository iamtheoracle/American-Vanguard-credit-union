import { query } from '../db.js';

// Every member-owned query requires the member ID taken from the validated cookie session.
export const listNotifications = memberId => query(
  `SELECT id, title, body, read, created_at AS "createdAt" FROM notifications
   WHERE member_id = $1 ORDER BY created_at DESC LIMIT 30`, [memberId]);
export const markNotificationsRead = memberId =>
  query('UPDATE notifications SET read = TRUE WHERE member_id = $1', [memberId]);
export const listSupportCases = memberId => query(
  `SELECT c.id, c.subject, c.status, c.priority, c.created_at AS "createdAt",
          (SELECT count(*) FROM case_messages m WHERE m.case_id = c.id) AS message_count
   FROM support_cases c WHERE c.member_id = $1 ORDER BY c.created_at DESC`, [memberId]);
export const getSupportCase = (caseId, memberId) =>
  query('SELECT c.* FROM support_cases c WHERE c.id = $1 AND c.member_id = $2', [caseId, memberId]);
export const getSupportCaseIdentity = (caseId, memberId) =>
  query('SELECT id FROM support_cases WHERE id = $1 AND member_id = $2', [caseId, memberId]);
export const listCaseMessages = caseId => query(
  `SELECT m.id, m.author_type AS "authorType", m.body, m.created_at AS "createdAt"
   FROM case_messages m WHERE m.case_id = $1 ORDER BY m.id`, [caseId]);
export const createCaseMessage = (caseId, memberId, body) => query(
  `INSERT INTO case_messages (case_id, author_type, author_id, body)
   VALUES ($1,'member',$2,$3) RETURNING *`, [caseId, memberId, body]);
