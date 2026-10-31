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
