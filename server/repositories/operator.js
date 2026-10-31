import { query } from '../db.js';

// Operator reads are isolated behind named repository operations. Route guards
// remain responsible for the role/capability decision before calling these.
export async function getQueueSummary() {
  const [approvals, cases, aiFailed, membership, alerts, moneyRequests] = await Promise.all([
    query(`SELECT count(*) FILTER (WHERE status = 'pending') AS pending,
                  count(*) FILTER (WHERE status = 'escalated') AS escalated FROM approvals`),
    query(`SELECT count(*) FILTER (WHERE status IN ('open','in_progress')) AS open,
                  count(*) FILTER (WHERE status = 'escalated') AS escalated FROM support_cases`),
    query(`SELECT count(*) AS failed FROM ai_tasks WHERE status = 'failed'`),
    query(`SELECT count(*) AS pending FROM members WHERE status = 'pending'`),
    query(`SELECT count(*) AS pending FROM operations_alerts
           WHERE status = 'pending' AND alert_type = 'loan_application_submitted'`),
    query(`SELECT count(*) AS pending FROM approvals
           WHERE item_type = 'money_request' AND status IN ('pending','escalated','info_requested')`)
  ]);
  return { approvals, cases, aiFailed, membership, alerts, moneyRequests };
}
export const listAuditEvents = limit => query(
  `SELECT id, actor_type AS "actorType", actor_id AS "actorId", actor_role AS "actorRole",
          action, entity_type AS "entityType", entity_id AS "entityId", metadata,
          created_at AS "createdAt"
   FROM audit_events ORDER BY id DESC LIMIT $1`, [limit]);


export const listMembers = search => query(
  `SELECT m.id, m.email, m.full_name AS "fullName", m.status, m.created_at AS "createdAt",
    (SELECT coalesce(sum(a.balance_cents),0) FROM accounts a WHERE a.member_id = m.id) AS "totalCents"
   FROM members m ${search ? 'WHERE (m.full_name ILIKE $1 OR m.email ILIKE $1)' : ''}
   ORDER BY m.created_at DESC LIMIT 100`, search ? [`%${String(search).slice(0,80)}%`] : []);
export const getMemberProfile = memberId => query(
  'SELECT id, email, full_name AS "fullName", status, created_at AS "createdAt" FROM members WHERE id = $1', [memberId]);
export const listMemberAccounts = memberId => query(
  'SELECT id, name, kind, suffix, balance_cents AS "balanceCents", status FROM accounts WHERE member_id = $1', [memberId]);
export const listMemberTransactions = memberId => query(
  `SELECT t.reference, t.type, t.status, t.amount_cents AS "amountCents", t.created_at AS "createdAt", t.memo, t.payee
   FROM transactions t JOIN accounts a ON (a.id = t.from_account_id OR a.id = t.to_account_id)
   WHERE a.member_id = $1 ORDER BY t.created_at DESC LIMIT 50`, [memberId]);
export const listMemberLoans = memberId => query(
  `SELECT reference, status, requested_amount_cents AS "amountCents", currency, created_at AS "createdAt",
   reviewed_at AS "reviewedAt", decision_reason AS "decisionReason" FROM loan_applications
   WHERE member_id = $1 ORDER BY created_at DESC LIMIT 50`, [memberId]);
export const listMemberMoneyRequests = memberId => query(
  `SELECT reference, request_type AS "requestType", status, amount_cents AS "amountCents", currency,
   created_at AS "createdAt", reviewed_at AS "reviewedAt", decision_reason AS "decisionReason"
   FROM money_requests WHERE member_id = $1 ORDER BY created_at DESC LIMIT 50`, [memberId]);
export const listMemberApprovals = memberId => query(
  `SELECT id, item_type AS "itemType", status, decision_reason AS "decisionReason", created_at AS "createdAt", decided_at AS "decidedAt"
   FROM approvals WHERE member_id = $1 ORDER BY created_at DESC LIMIT 50`, [memberId]);
export const listMemberTierHistory = memberId => query(
  `SELECT previous_tier AS "previousTier", new_tier AS "newTier", reason, changed_by_type AS "changedByType",
   changed_by AS "changedBy", created_at AS "createdAt" FROM membership_tier_history
   WHERE member_id = $1 ORDER BY created_at DESC LIMIT 100`, [memberId]);
