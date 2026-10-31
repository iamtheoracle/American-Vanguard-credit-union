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


// Account, transaction, card and loan-application reads are member-scoped here.
export const listAccounts = memberId => query(
  `SELECT id, kind, name, suffix, balance_cents AS "balanceCents", status
   FROM accounts WHERE member_id = $1 AND status = 'open' ORDER BY created_at`, [memberId]);
export const listTransactions = (memberId, { type, search, limit, offset }) => {
  const params = [memberId];
  let where = 'a.member_id = $1';
  if (type) { params.push(String(type)); where += ` AND t.type = $${params.length}`; }
  if (search) { params.push(`%${String(search).slice(0, 80)}%`); where += ` AND (t.memo ILIKE $${params.length} OR t.payee ILIKE $${params.length} OR t.reference ILIKE $${params.length})`; }
  return query(`SELECT DISTINCT t.id, t.reference, t.type, t.status, t.amount_cents AS "amountCents",
    t.memo, t.payee, t.created_at AS "createdAt", fa.name AS "fromAccountName", ta.name AS "toAccountName"
    FROM transactions t JOIN accounts a ON (a.id = t.from_account_id OR a.id = t.to_account_id)
    LEFT JOIN accounts fa ON fa.id = t.from_account_id LEFT JOIN accounts ta ON ta.id = t.to_account_id
    WHERE ${where} ORDER BY t.created_at DESC LIMIT ${limit + 1} OFFSET ${offset}`, params);
};
export const getMemberCard = memberId => query(
  'SELECT id, last4 AS "last4", status, expires FROM cards WHERE member_id = $1', [memberId]);
export const listLoanApplications = memberId => query(
  `SELECT id, reference, requested_amount_cents AS "requestedAmountCents", currency,
    requested_term_months AS "requestedTermMonths", purpose, status,
    decision_reason AS "decisionReason", information_requested AS "informationRequested",
    submitted_at AS "submittedAt", reviewed_at AS "reviewedAt", created_at AS "createdAt"
   FROM loan_applications WHERE member_id = $1 ORDER BY created_at DESC LIMIT 50`, [memberId]);
