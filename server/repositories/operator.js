import { query, withTx, audit } from '../db.js';

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


// Transactional support workflows. The case row is locked before appending a message
// so status changes and the message cannot be partially committed.
export async function createOperatorCaseMessage({ caseId, operatorId, body }) {
  return withTx(async client => {
    const locked = await client.query('SELECT id FROM support_cases WHERE id = $1 FOR UPDATE', [caseId]);
    if (!locked.rowCount) return null;
    const inserted = await client.query(
      `INSERT INTO case_messages (case_id, author_type, author_id, body)
       VALUES ($1,'operator',$2,$3) RETURNING *`, [caseId, operatorId, body]);
    await client.query(`UPDATE support_cases SET status = 'in_progress', updated_at = now()
                        WHERE id = $1 AND status = 'open'`, [caseId]);
    return inserted.rows[0];
  });
}
export async function updateSupportCaseStatus({ caseId, status, operator }) {
  return withTx(async client => {
    const locked = await client.query('SELECT id, status FROM support_cases WHERE id = $1 FOR UPDATE', [caseId]);
    if (!locked.rowCount) return { kind: 'not_found' };
    if (status === 'escalated' && operator.role !== 'operator' && locked.rows[0].status === 'escalated') {
      return { kind: 'invalid_transition' };
    }
    const updated = await client.query(
      `UPDATE support_cases SET status = $1,
         priority = CASE WHEN $1 = 'escalated' THEN 'high' ELSE priority END,
         updated_at = now() WHERE id = $2 RETURNING id`, [status, caseId]);
    return updated.rowCount ? { kind: 'updated' } : { kind: 'not_found' };
  });
}
export async function assignApproval({ approvalId, operatorId }) {
  return query(
    `UPDATE approvals SET assigned_to = $1, updated_at = now()
     WHERE id = $2 AND status IN ('pending','escalated') RETURNING id`,
    [operatorId, approvalId]);
}
export async function createOperator({ email, passwordHash, name, role, actor }) {
  return withTx(async client => {
    const inserted = await client.query(
      `INSERT INTO operators (email, password_hash, name, role)
       VALUES (lower($1),$2,$3,$4) RETURNING id, email, name, role`,
      [email, passwordHash, name, role]);
    await audit(client, { actorType: 'operator', actorId: actor.id, actorRole: actor.role,
      action: 'operator.created', entityType: 'operator', entityId: inserted.rows[0].id,
      metadata: { role } });
    return inserted.rows[0];
  });
}
export async function updateOperator({ targetId, role, active, actor }) {
  return withTx(async client => {
    const { rows } = await client.query('SELECT id, role, active FROM operators WHERE id = $1 FOR UPDATE', [targetId]);
    const subject = rows[0];
    if (!subject) return { kind: 'not_found' };
    if (subject.id === actor.id && (active === false || (role && role !== 'super_admin'))) return { kind: 'self_change' };
    if ((role && role !== 'super_admin' && subject.role === 'super_admin') || active === false) {
      const admins = await client.query(
        `SELECT id FROM operators WHERE role = 'super_admin' AND active
         ORDER BY id FOR UPDATE`);
      if (admins.rows.length <= 1 && subject.role === 'super_admin' && subject.active) return { kind: 'last_super_admin' };
    }
    const sets = [], params = [];
    if (role) { params.push(role); sets.push(`role = $${params.length}`); }
    if (typeof active === 'boolean') { params.push(active); sets.push(`active = $${params.length}`); }
    if (!sets.length) return { kind: 'unchanged' };
    params.push(targetId);
    const updated = await client.query(
      `UPDATE operators SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, email, name, role, active`, params);
    await audit(client, { actorType: 'operator', actorId: actor.id, actorRole: actor.role,
      action: 'operator.updated', entityType: 'operator', entityId: targetId,
      metadata: { role, active } });
    return { kind: 'updated', operator: updated.rows[0] };
  });
}
export async function acknowledgeOperationsAlert({ alertId, operator }) {
  return withTx(async client => {
    const updated = await client.query(
      `UPDATE operations_alerts SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $1
       WHERE id = $2 AND status = 'pending'
       RETURNING id, alert_type AS "alertType", status, acknowledged_at AS "acknowledgedAt"`,
      [operator.id, alertId]);
    if (!updated.rowCount) return null;
    await audit(client, { actorType: 'operator', actorId: operator.id, actorRole: operator.role,
      action: 'loan.alert.acknowledged', entityType: 'operations_alert', entityId: updated.rows[0].id,
      metadata: { alertType: updated.rows[0].alertType } });
    return updated.rows[0];
  });
}
