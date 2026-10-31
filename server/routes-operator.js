import express from 'express';
import { createHash } from 'node:crypto';
import { query, withTx, audit } from './db.js';
import {
  operatorAuth, requireOperatorRole, applySessionCookie, clearAuthCookie,
  createOperatorSession, destroySession, hashPassword, verifyPassword, findOperatorByEmail
} from './auth.js';
import { rateLimiter, clientKey, validEmail, validPassword, PASSWORD_MIN } from './util.js';
import { decideApproval, reversePostedTransaction } from './approvals.js';
import { integrationHealth } from './integrations/index.js';
import { notifyMember } from './notifications.js';
import { MEMBERSHIP_TIERS, recalculateMemberTier, overrideMemberTier, clearMemberTierOverride } from './membership-tiers.js';
import { validateLegacyTransactions } from './migration-validation.js';
import { listTeams, controlTeam } from './team-runtime.js';

const router = express.Router();
const loginLimiter = rateLimiter({ windowMs: 60_000, max: 8 });

// ---- operator authentication --------------------------------------------------
router.post('/operator/login', async (req, res, next) => {
  try {
    if (!loginLimiter(`ops:${clientKey(req)}`)) {
      return res.status(429).json({ error: 'Too many sign-in attempts. Wait a minute and try again.' });
    }
    const operator = await findOperatorByEmail(String(req.body?.email || ''));
    const ok = operator && await verifyPassword(String(req.body?.password || ''), operator.password_hash);
    if (!ok) return res.status(401).json({ error: 'Operator credentials are incorrect' });
    const session = await createOperatorSession(operator.id);
    applySessionCookie(req, res, 'operator', session);
    await audit(null, {
      actorType: 'operator', actorId: operator.id, actorRole: operator.role,
      action: 'operator.login', entityType: 'operator', entityId: operator.id
    });
    res.json({ operator: { id: operator.id, email: operator.email, name: operator.name, role: operator.role } });
  } catch (error) { next(error); }
});

router.post('/operator/logout', operatorAuth, async (req, res, next) => {
  try {
    await destroySession('operator', req.sessionToken);
    clearAuthCookie(req, res, 'operator');
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.get('/auth/operator/me', operatorAuth, (req, res) => {
  res.json({ operator: req.operator });
});

// Everything below requires an operator session.
router.use('/operator', operatorAuth);

// ---- independent team runtime controls ------------------------------------------
router.get('/operator/teams', ...guard('management', 'operator', 'auditor'), async (req, res, next) => {
  try { res.json({ teams: await listTeams() }); }
  catch (error) { next(error); }
});

router.post('/operator/teams/:teamId/control', ...guard('super_admin'), async (req, res, next) => {
  try {
    const result = await controlTeam({
      teamId: req.params.teamId,
      desiredState: req.body?.desiredState,
      reason: req.body?.reason,
      actor: { type: 'operator', id: req.operator.id, role: req.operator.role },
      correlationId: String(req.header('X-Correlation-Id') || '').slice(0, 120) || null
    });
    await audit(null, {
      actorType: 'operator', actorId: req.operator.id, actorRole: req.operator.role,
      action: 'team.control.requested', entityType: 'team', entityId: req.params.teamId,
      metadata: { desiredState: result.desired_state, version: result.version }
    });
    res.json({ ok: true, team: result, note: 'Desired state recorded. A worker must acknowledge the command before runtime state is considered changed.' });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

const TIERS = {
  operator: ['operator'],
  management: ['management', 'super_admin'],
  super_admin: ['super_admin'],
  auditor: ['auditor']
};

router.get('/operator/queue', ...guard('management', 'operator'), async (req, res, next) => {
  try {
    const [approvals, cases, aiFailed, membership, alerts, moneyRequests, health] = await Promise.all([
      query(`SELECT count(*) FILTER (WHERE status = 'pending') AS pending,
                    count(*) FILTER (WHERE status = 'escalated') AS escalated
             FROM approvals`),
      query(`SELECT count(*) FILTER (WHERE status IN ('open','in_progress')) AS open,
                    count(*) FILTER (WHERE status = 'escalated') AS escalated
             FROM support_cases`),
      query(`SELECT count(*) AS failed FROM ai_tasks WHERE status = 'failed'`),
      query(`SELECT count(*) AS pending FROM members WHERE status = 'pending'`),
      query(`SELECT count(*) AS pending FROM operations_alerts WHERE status = 'pending' AND alert_type = 'loan_application_submitted'`),
      query(`SELECT count(*) AS pending FROM approvals WHERE item_type = 'money_request' AND status IN ('pending','escalated','info_requested')`),
      integrationHealth()
    ]);
    res.json({
      approvals: { pending: Number(approvals.rows[0].pending), escalated: Number(approvals.rows[0].escalated) },
      cases: { open: Number(cases.rows[0].open), escalated: Number(cases.rows[0].escalated) },
      aiFailed: Number(aiFailed.rows[0].failed),
      membershipPending: Number(membership.rows[0].pending),
      loanAlertsPending: Number(alerts.rows[0].pending),
      moneyRequestsPending: Number(moneyRequests.rows[0].pending),
      integrations: health
    });
  } catch (error) { next(error); }
});

router.get('/operator/approvals', ...guard('management', 'operator'), async (req, res, next) => {
  try {
    const allowedStatuses = ['pending', 'escalated', 'approved', 'rejected', 'info_requested'];
    const allowedTypes = ['membership', 'transaction', 'money_request', 'loan'];
    const status = allowedStatuses.includes(req.query.status) ? req.query.status : null;
    const itemType = allowedTypes.includes(req.query.type) ? req.query.type : null;
    const search = String(req.query.search || '').trim().slice(0, 80);
    const page = Math.max(1, Math.min(10000, Number.parseInt(req.query.page || '1', 10) || 1));
    const limit = Math.max(10, Math.min(100, Number.parseInt(req.query.limit || '50', 10) || 50));
    const params = [];
    const filters = [];
    if (status) { params.push(status); filters.push(`a.status = $${params.length}`); }
    if (itemType) { params.push(itemType); filters.push(`a.item_type = $${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      filters.push(`(m.full_name ILIKE $${params.length} OR m.email ILIKE $${params.length} OR t.reference ILIKE $${params.length} OR l.reference ILIKE $${params.length} OR mr.reference ILIKE $${params.length} OR a.id::text ILIKE $${params.length})`);
    }
    const where = filters.length ? filters.join(' AND ') : 'TRUE';
    const count = await query(
      `SELECT count(*)::int AS total FROM approvals a
       LEFT JOIN transactions t ON t.id = a.transaction_id
       LEFT JOIN loan_applications l ON l.approval_id = a.id
       LEFT JOIN money_requests mr ON mr.approval_id = a.id
       LEFT JOIN members m ON (m.id = a.member_id OR (a.item_type = 'transaction' AND a.submitted_by_type = 'member' AND a.submitted_by::text = m.id::text))
       WHERE ${where}`, params);
    const pageParams = [...params, limit, (page - 1) * limit];
    const { rows } = await query(
      `SELECT a.id, a.item_type AS "itemType", a.status, a.required_role AS "requiredRole",
              a.payload, a.created_at AS "createdAt", a.decided_at AS "decidedAt",
              a.decision_reason AS "decisionReason", a.assigned_to AS "assignedTo",
              a.submitted_by_type AS "submittedByType", a.submitted_by AS "submittedBy",
              t.id AS "transactionId", COALESCE(t.reference, l.reference, mr.reference) AS reference, t.type AS "transactionType",
              mr.request_type AS "requestType", COALESCE(t.amount_cents, l.requested_amount_cents, mr.amount_cents) AS "amountCents", t.status AS "transactionStatus",
              m.full_name AS "memberName", m.email AS "memberEmail", m.id AS "memberId"
       FROM approvals a
       LEFT JOIN transactions t ON t.id = a.transaction_id
       LEFT JOIN loan_applications l ON l.approval_id = a.id
       LEFT JOIN money_requests mr ON mr.approval_id = a.id
       LEFT JOIN members m ON m.id = a.member_id
       WHERE ${where}
       ORDER BY CASE a.status WHEN 'escalated' THEN 0 WHEN 'pending' THEN 1 WHEN 'info_requested' THEN 2 ELSE 3 END, a.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, pageParams);
    res.json({ approvals: rows, pagination: { page, limit, total: Number(count.rows[0].total), pages: Math.ceil(Number(count.rows[0].total) / limit) } });
  } catch (error) { next(error); }
});

router.post('/operator/approvals/:id/decide', ...guard('management', 'operator'), async (req, res, next) => {
  try {
    const { action, reason } = req.body || {};
    const result = await decideApproval({ approvalId: req.params.id, operator: req.operator, action, reason });
    const item = await query('SELECT item_type, member_id, transaction_id FROM approvals WHERE id = $1', [req.params.id]);
    if (item.rows[0]?.item_type === 'membership' && item.rows[0].member_id) {
      const memberId = item.rows[0].member_id;
      await recalculateMemberTier(memberId).catch(() => {});
      await notifyMember({ memberId, eventType: 'membership.application_decided',
        eventKey: `membership-approval:${result.approval.id}:${result.approval.status}`,
        title: 'Membership application update',
        body: `Your membership application was ${result.approval.status}.`,
        subject: 'AVCU membership application update' }).catch(error => console.error('[avcu] notification failed:', error.code || error.name));
    } else if (item.rows[0]?.item_type === 'transaction' && item.rows[0].transaction_id) {
      const owner = await query(
        `SELECT DISTINCT a.member_id FROM accounts a
         JOIN transactions t ON t.from_account_id = a.id OR t.to_account_id = a.id
         WHERE t.id = $1 LIMIT 1`, [item.rows[0].transaction_id]);
      if (owner.rows[0]?.member_id) {
        const memberId = owner.rows[0].member_id;
        await recalculateMemberTier(memberId).catch(() => {});
        await notifyMember({ memberId, eventType: 'transaction.approval_decided',
          eventKey: `transaction-approval:${result.approval.id}:${result.approval.status}:${memberId}`,
          title: 'Transaction status update',
          body: `A transaction review was ${result.approval.status}. Reference: ${result.approval.id}.`,
          subject: 'AVCU transaction status update' }).catch(error => console.error('[avcu] notification failed:', error.code || error.name));
      }
    }
    res.json({ ok: true, approval: { id: result.approval.id, status: result.approval.status }, outcome: result.outcome });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  }
});

router.post('/operator/approvals/:id/assign', ...guard('management', 'super_admin'), async (req, res, next) => {
  try {
    const { operatorId } = req.body || {};
    const { rows } = await query(
      `UPDATE approvals SET assigned_to = $1, updated_at = now()
       WHERE id = $2 AND status IN ('pending','escalated') RETURNING id`,
      [operatorId || req.operator.id, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Approval not found or already decided' });
    await audit(null, {
      actorType: 'operator', actorId: req.operator.id, actorRole: req.operator.role,
      action: 'approval.assigned', entityType: 'approval', entityId: req.params.id,
      metadata: { assignedTo: operatorId || req.operator.id }
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.post('/operator/transactions/:id/reverse', ...guard('super_admin'), async (req, res, next) => {
  try {
    const reversal = await reversePostedTransaction({
      transactionId: req.params.id, operator: req.operator, reason: req.body?.reason });
    res.json({ ok: true, reversal: { id: reversal.id, reference: reversal.reference, status: 'posted' } });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  }
});

// ---- members ------------------------------------------------------------------
router.get('/operator/members', ...guard('management', 'operator'), async (req, res, next) => {
  try {
    const search = String(req.query.search || '').slice(0, 80);
    const params = search ? [`%${search}%`] : [];
    const where = search ? 'WHERE (m.full_name ILIKE $1 OR m.email ILIKE $1)' : '';
    const { rows } = await query(
      `SELECT m.id, m.email, m.full_name AS "fullName", m.status, m.created_at AS "createdAt",
              (SELECT coalesce(sum(a.balance_cents),0) FROM accounts a WHERE a.member_id = m.id) AS "totalCents"
       FROM members m ${where} ORDER BY m.created_at DESC LIMIT 100`, params);
    res.json({ members: rows });
  } catch (error) { next(error); }
});

router.get('/operator/members/:id', ...guard('management', 'operator'), async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id, email, full_name AS "fullName", status, created_at AS "createdAt" FROM members WHERE id = $1',
      [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Member not found' });
    const member = rows[0];
    // Viewing a member's full profile is itself audited.
    await audit(null, {
      actorType: 'operator', actorId: req.operator.id, actorRole: req.operator.role,
      action: 'member.viewed', entityType: 'member', entityId: member.id
    });
    const accounts = await query(
      `SELECT id, name, kind, suffix, balance_cents AS "balanceCents", status FROM accounts WHERE member_id = $1`, [member.id]);
    const transactions = await query(
      `SELECT t.reference, t.type, t.status, t.amount_cents AS "amountCents", t.created_at AS "createdAt", t.memo, t.payee
       FROM transactions t JOIN accounts a ON (a.id = t.from_account_id OR a.id = t.to_account_id)
       WHERE a.member_id = $1 ORDER BY t.created_at DESC LIMIT 50`, [member.id]);
    const [loans, moneyRequests, approvals] = await Promise.all([
      query(`SELECT reference, status, requested_amount_cents AS "amountCents", currency,
                    created_at AS "createdAt", reviewed_at AS "reviewedAt", decision_reason AS "decisionReason"
             FROM loan_applications WHERE member_id = $1 ORDER BY created_at DESC LIMIT 50`, [member.id]),
      query(`SELECT reference, request_type AS "requestType", status, amount_cents AS "amountCents",
                    currency, created_at AS "createdAt", reviewed_at AS "reviewedAt", decision_reason AS "decisionReason"
             FROM money_requests WHERE member_id = $1 ORDER BY created_at DESC LIMIT 50`, [member.id]),
      query(`SELECT id, item_type AS "itemType", status, decision_reason AS "decisionReason",
                    created_at AS "createdAt", decided_at AS "decidedAt"
             FROM approvals WHERE member_id = $1 ORDER BY created_at DESC LIMIT 50`, [member.id])
    ]);
    res.json({
      member, accounts: accounts.rows, transactions: transactions.rows,
      loans: loans.rows, moneyRequests: moneyRequests.rows, approvals: approvals.rows
    });
  } catch (error) { next(error); }
});


// ---- membership tier operations ---------------------------------------------
router.get('/operator/membership-tiers', ...guard('management', 'operator'), async (req, res, next) => {
  try {
    const tier = Object.hasOwn(MEMBERSHIP_TIERS, req.query.tier) ? req.query.tier : null;
    const status = ['pending', 'verified', 'rejected'].includes(req.query.status) ? req.query.status : null;
    const search = String(req.query.search || '').trim().slice(0, 80);
    const params = [];
    const filters = [];
    if (tier) { params.push(tier); filters.push(`m.membership_tier = $${params.length}`); }
    if (status) { params.push(status); filters.push(`m.status = $${params.length}`); }
    if (search) { params.push(`%${search}%`); filters.push(`(m.full_name ILIKE $${params.length} OR m.email ILIKE $${params.length})`); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT m.id, m.email, m.full_name AS "fullName", m.status,
              m.membership_tier AS tier, m.tier_override AS "tierOverride",
              m.tier_override_reason AS "tierOverrideReason", m.tier_updated_at AS "tierUpdatedAt",
              m.created_at AS "createdAt",
              (SELECT count(DISTINCT t.id) FROM transactions t JOIN accounts a ON a.id = t.from_account_id OR a.id = t.to_account_id
               WHERE a.member_id = m.id AND t.status IN ('posted','completed','reversed')
                 AND t.created_at >= now() - interval '90 days') AS "activity90Days"
       FROM members m ${where} ORDER BY m.tier_updated_at DESC LIMIT 200`, params);
    res.json({ tiers: rows, availableTiers: MEMBERSHIP_TIERS });
  } catch (error) { next(error); }
});

router.put('/operator/members/:id/tier', ...guard('management'), async (req, res, next) => {
  try {
    const { tier, reason } = req.body || {};
    const membership = await overrideMemberTier({ memberId: req.params.id, tier, reason, operator: req.operator });
    res.json({ ok: true, membership });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

router.delete('/operator/members/:id/tier/override', ...guard('management'), async (req, res, next) => {
  try {
    const membership = await clearMemberTierOverride(req.params.id, req.operator);
    res.json({ ok: true, membership });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

router.get('/operator/members/:id/tier/history', ...guard('management', 'operator'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT previous_tier AS "previousTier", new_tier AS "newTier", reason,
              changed_by_type AS "changedByType", changed_by AS "changedBy", created_at AS "createdAt"
       FROM membership_tier_history WHERE member_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.params.id]);
    res.json({ history: rows });
  } catch (error) { next(error); }
});


router.get('/operator/email-deliveries', ...guard('management'), async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const status = ['sent', 'skipped', 'failed'].includes(req.query.status) ? req.query.status : null;
    const params = status ? [status] : [];
    const where = status ? 'WHERE status = $1' : '';
    const { rows } = await query(
      `SELECT id, member_id AS "memberId", recipient, event_type AS "eventType",
              subject, status, provider_message_id AS "providerMessageId",
              error_code AS "errorCode", created_at AS "createdAt"
       FROM email_delivery_log ${where} ORDER BY created_at DESC LIMIT ${limit}`, params);
    res.json({ deliveries: rows, gmailConfigured: Boolean(process.env.AVCU_GMAIL_CLIENT_ID &&
      process.env.AVCU_GMAIL_CLIENT_SECRET && process.env.AVCU_GMAIL_REFRESH_TOKEN && process.env.AVCU_GMAIL_FROM) });
  } catch (error) { next(error); }
});

// ---- support cases -------------------------------------------------------------

router.get('/operator/cases', ...guard('management', 'operator'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.id, c.subject, c.status, c.priority, c.created_at AS "createdAt", c.assigned_to AS "assignedTo",
              m.full_name AS "memberName", m.email AS "memberEmail"
       FROM support_cases c JOIN members m ON m.id = c.member_id
       ORDER BY CASE c.status WHEN 'escalated' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, c.created_at DESC LIMIT 100`);
    res.json({ cases: rows });
  } catch (error) { next(error); }
});

router.get('/operator/cases/:id', ...guard('management', 'operator'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.*, m.full_name AS "memberName", m.email AS "memberEmail"
       FROM support_cases c JOIN members m ON m.id = c.member_id WHERE c.id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Case not found' });
    const messages = await query(
      `SELECT m2.id, m2.author_type AS "authorType", m2.body, m2.created_at AS "createdAt"
       FROM case_messages m2 WHERE m2.case_id = $1 ORDER BY m2.id`, [req.params.id]);
    res.json({ case: rows[0], messages: messages.rows });
  } catch (error) { next(error); }
});

router.post('/operator/cases/:id/messages', ...guard('management', 'operator'), async (req, res, next) => {
  try {
    const body = String(req.body?.body || '').trim().slice(0, 2000);
    if (!body) return res.status(400).json({ error: 'Message cannot be empty' });
    const { rows } = await query(
      `INSERT INTO case_messages (case_id, author_type, author_id, body)
       VALUES ($1,'operator',$2,$3) RETURNING *`, [req.params.id, req.operator.id, body]);
    await query(`UPDATE support_cases SET status = 'in_progress', updated_at = now()
                 WHERE id = $1 AND status = 'open'`, [req.params.id]);
    res.status(201).json({ message: rows[0] });
  } catch (error) { next(error); }
});

router.post('/operator/cases/:id/status', ...guard('management', 'operator'), async (req, res, next) => {
  try {
    const status = String(req.body?.status || '');
    if (!['open', 'in_progress', 'escalated', 'resolved'].includes(status)) {
      return res.status(400).json({ error: 'Unknown case status' });
    }
    if (status === 'escalated' && req.operator.role === 'operator') {
      // Normal operators escalate; management decides.
      const { rows } = await query(
        `UPDATE support_cases SET status = 'escalated', priority = 'high', updated_at = now()
         WHERE id = $1 RETURNING id`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Case not found' });
      return res.json({ ok: true, status: 'escalated' });
    }
    if (status === 'escalated') return res.status(400).json({ error: 'Case is already escalated or use resolve' });
    const { rows } = await query(
      `UPDATE support_cases SET status = $1, updated_at = now() WHERE id = $2 RETURNING id`,
      [status, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Case not found' });
    return res.json({ ok: true, status });
  } catch (error) { next(error); }
});

// ---- AI task oversight -----------------------------------------------------------
router.get('/operator/ai-tasks', ...guard('management', 'super_admin'), async (req, res, next) => {
  try {
    const status = ['pending', 'succeeded', 'failed'].includes(req.query.status) ? req.query.status : null;
    const { rows } = await query(
      `SELECT id, requester_type AS "requesterType", requester_id AS "requesterId", purpose, status,
              provider, input_excerpt AS "inputExcerpt", error, tool_calls AS "toolCalls",
              created_at AS "createdAt", completed_at AS "completedAt"
       FROM ai_tasks ${status ? 'WHERE status = $1' : ''}
       ORDER BY created_at DESC LIMIT 100`, status ? [status] : []);
    res.json({ tasks: rows });
  } catch (error) { next(error); }
});

// ---- integrations ------------------------------------------------------------------
router.get('/operator/integrations', ...guard('management', 'super_admin'), async (req, res, next) => {
  try {
    res.json({ integrations: await integrationHealth() });
  } catch (error) { next(error); }
});

// ---- operator administration (super admin only) --------------------------------------
router.get('/operator/operators', requireOperatorRole('super_admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, email, name, role, active, created_at AS "createdAt" FROM operators ORDER BY created_at`);
    res.json({ operators: rows });
  } catch (error) { next(error); }
});

router.post('/operator/operators', requireOperatorRole('super_admin'), async (req, res, next) => {
  try {
    const { email, name, role, password } = req.body || {};
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email' });
    if (!['super_admin', 'management', 'operator'].includes(role)) return res.status(400).json({ error: 'Unknown role' });
    if (!validPassword(password)) return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN} characters` });
    if (!name || String(name).trim().length < 2) return res.status(400).json({ error: 'Enter a name' });
    const hash = await hashPassword(password);
    const { rows } = await query(
      `INSERT INTO operators (email, password_hash, name, role) VALUES (lower($1),$2,$3,$4)
       RETURNING id, email, name, role`, [email, hash, String(name).trim(), role]);
    await audit(null, {
      actorType: 'operator', actorId: req.operator.id, actorRole: req.operator.role,
      action: 'operator.created', entityType: 'operator', entityId: rows[0].id,
      metadata: { role }
    });
    res.status(201).json({ operator: rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'An operator with this email exists' });
    next(error);
  }
});

router.patch('/operator/operators/:id', requireOperatorRole('super_admin'), async (req, res, next) => {
  try {
    const { role, active } = req.body || {};
    const { rows: target } = await query('SELECT * FROM operators WHERE id = $1', [req.params.id]);
    const subject = target[0];
    if (!subject) return res.status(404).json({ error: 'Operator not found' });
    if (role && !['super_admin', 'management', 'operator'].includes(role)) {
      return res.status(400).json({ error: 'Unknown role' });
    }
    // Never allow removing the last active super admin.
    if ((role && role !== 'super_admin' && subject.role === 'super_admin') || active === false) {
      const { rows: admins } = await query(
        `SELECT count(*) AS n FROM operators WHERE role = 'super_admin' AND active AND id <> $1`, [subject.id]);
      if (Number(admins[0].n) === 0) {
        return res.status(409).json({ error: 'Cannot demote or deactivate the last active super admin' });
      }
    }
    if (subject.id === req.operator.id && (active === false || (role && role !== 'super_admin'))) {
      return res.status(409).json({ error: 'You cannot demote or deactivate your own account' });
    }
    const sets = [];
    const params = [];
    if (role) { params.push(role); sets.push(`role = $${params.length}`); }
    if (typeof active === 'boolean') { params.push(active); sets.push(`active = $${params.length}`); }
    const { rows } = await query(
      `UPDATE operators SET ${sets.join(', ')} WHERE id = $${params.length + 1}
       RETURNING id, email, name, role, active`, [...params, req.params.id]);
    await audit(null, {
      actorType: 'operator', actorId: req.operator.id, actorRole: req.operator.role,
      action: 'operator.updated', entityType: 'operator', entityId: req.params.id,
      metadata: { role, active }
    });
    res.json({ operator: rows[0] });
  } catch (error) { next(error); }
});

// ---- loan application operations alerts -------------------------------------
router.get('/operator/loan-alerts', ...guard('management', 'operator'), async (req, res, next) => {
  try {
    const status = ['pending','acknowledged','resolved'].includes(req.query.status) ? req.query.status : null;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const { rows } = await query(
      `SELECT oa.id, oa.alert_type AS "alertType", oa.status,
              oa.created_at AS "createdAt", oa.acknowledged_at AS "acknowledgedAt",
              oa.acknowledged_by AS "acknowledgedBy",
              la.id AS "applicationId", la.reference,
              la.requested_amount_cents AS "requestedAmountCents", la.currency,
              la.requested_term_months AS "requestedTermMonths", la.status AS "applicationStatus",
              la.submitted_at AS "submittedAt", m.id AS "memberId",
              m.full_name AS "memberName", m.email AS "memberEmail",
              COALESCE(outbox.status, 'not_configured') AS "emailStatus"
       FROM operations_alerts oa
       JOIN loan_applications la ON la.id = oa.loan_application_id
       JOIN members m ON m.id = la.member_id
       LEFT JOIN notification_outbox outbox ON outbox.event_key = 'loan-application-operations:' || la.id::text || ':submitted'
       WHERE ($1::text IS NULL OR oa.status = $1)
       ORDER BY CASE oa.status WHEN 'pending' THEN 0 ELSE 1 END, oa.created_at DESC
       LIMIT $2`, [status, limit]);
    res.json({ alerts: rows.map(row => ({ ...row, requestedAmountCents: Number(row.requestedAmountCents) })) });
  } catch (error) { next(error); }
});

router.post('/operator/loan-alerts/:id/acknowledge', ...guard('management', 'operator'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE operations_alerts
       SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $1
       WHERE id = $2 AND status = 'pending'
       RETURNING id, alert_type AS "alertType", status, acknowledged_at AS "acknowledgedAt"`,
      [req.operator.id, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Pending operations alert not found' });
    await audit(null, {
      actorType: 'operator', actorId: req.operator.id, actorRole: req.operator.role,
      action: 'loan.alert.acknowledged', entityType: 'operations_alert', entityId: rows[0].id,
      metadata: { alertType: rows[0].alertType }
    });
    res.json({ alert: rows[0] });
  } catch (error) { next(error); }
});

// ---- legacy migration staging -------------------------------------------------
router.get('/operator/migrations', ...guard('management', 'operator', 'auditor'), async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const { rows } = await query(
      `SELECT id, source_system AS "sourceSystem", source_file_name AS "sourceFileName",
              source_payload_sha256 AS "sourcePayloadSha256", status,
              source_count AS "sourceCount", accepted_count AS "acceptedCount",
              exception_count AS "exceptionCount", created_at AS "createdAt",
              validated_at AS "validatedAt", approved_at AS "approvedAt", imported_at AS "importedAt"
       FROM migration_batches ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
    res.json({ batches: rows });
  } catch (error) { next(error); }
});

router.post('/operator/migrations/validate', ...guard('management', 'operator'), async (req, res, next) => {
  try {
    const sourceSystem = String(req.body?.sourceSystem || '').trim();
    const sourceFileName = String(req.body?.sourceFileName || 'authorized-export.json').split(/[\\/]/).pop().slice(0, 255);
    const rows = req.body?.rows;
    if (!sourceSystem || !Array.isArray(rows) || rows.length < 1 || rows.length > 1000) {
      return res.status(400).json({ error: 'Provide a source system and between 1 and 1000 transaction rows', code: 'invalid_migration_payload' });
    }
    const normalizedInput = rows.map(row => row && typeof row === 'object' && !Array.isArray(row)
      ? { ...row, sourceSystem } : row);
    const result = validateLegacyTransactions(normalizedInput, sourceSystem);
    const payloadHash = createHash('sha256').update(JSON.stringify({ sourceSystem, sourceFileName, rows: normalizedInput })).digest('hex');
    const status = result.exceptionCount ? 'blocked' : 'validated';
    const batch = await withTx(async client => {
      const inserted = await client.query(
        `INSERT INTO migration_batches
          (source_system, source_file_name, source_payload_sha256, created_by, status,
           source_count, accepted_count, exception_count, source_totals, exception_summary, validated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()) RETURNING id, created_at`,
        [sourceSystem, sourceFileName || 'authorized-export.json', payloadHash, req.operator.id, status,
          result.sourceCount, result.acceptedCount, result.exceptionCount,
          JSON.stringify(result.totals), JSON.stringify(result.exceptions)]);
      const batchId = inserted.rows[0].id;
      const acceptedByRow = new Map(result.accepted.map(item => [item.rowNumber, item]));
      const exceptionByRow = new Map(result.exceptions.map(item => [item.rowNumber, item]));
      for (let index = 0; index < normalizedInput.length; index += 1) {
        const rowNumber = index + 1;
        const raw = normalizedInput[index];
        const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        const accepted = acceptedByRow.get(rowNumber);
        const exception = exceptionByRow.get(rowNumber);
        await client.query(
          `INSERT INTO migration_staged_transactions
            (batch_id, row_number, source_system, source_transaction_id, source_account_id,
             occurred_at, original_timestamp, amount_minor, currency, status, description, reference,
             validation_status, exception_code, exception_fields, raw_record)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [batchId, rowNumber, sourceSystem,
            typeof row.sourceTransactionId === 'string' ? row.sourceTransactionId.slice(0, 250) : null,
            typeof row.sourceAccountId === 'string' ? row.sourceAccountId.slice(0, 250) : null,
            accepted ? accepted.occurredAt : null,
            typeof row.occurredAt === 'string' ? row.occurredAt.slice(0, 100) : null,
            Number.isSafeInteger(row.amountMinor) ? row.amountMinor : null,
            typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency) ? row.currency : null,
            typeof row.status === 'string' && ['pending','posted','settled','failed','reversed'].includes(row.status) ? row.status : null,
            typeof row.description === 'string' ? row.description.slice(0, 2000) : '',
            typeof row.reference === 'string' ? row.reference.slice(0, 250) : null,
            accepted ? 'accepted' : 'exception', accepted ? null : (exception?.code || 'unknown_exception'),
            JSON.stringify(exception?.fields || []), JSON.stringify(raw ?? null)]);
      }
      await audit(client, {
        actorType: 'operator', actorId: req.operator.id, actorRole: req.operator.role,
        action: 'migration.batch_validated', entityType: 'migration_batch', entityId: batchId,
        metadata: { sourceSystem, payloadSha256: payloadHash, sourceCount: result.sourceCount,
          acceptedCount: result.acceptedCount, exceptionCount: result.exceptionCount, status }
      });
      return { id: batchId, createdAt: inserted.rows[0].created_at };
    });
    res.status(201).json({
      batch: { ...batch, sourceSystem, sourceFileName, sourcePayloadSha256: payloadHash,
        status, sourceCount: result.sourceCount, acceptedCount: result.acceptedCount,
        exceptionCount: result.exceptionCount, totals: result.totals, exceptions: result.exceptions },
      cutoverAllowed: false,
      message: 'Records are staged only. Reconciliation, authorized approval, and a verified source export are still required before any import or cutover.'
    });
  } catch (error) { next(error); }
});

router.get('/operator/migrations/:id', ...guard('management', 'operator', 'auditor'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, source_system AS "sourceSystem", source_file_name AS "sourceFileName",
              source_payload_sha256 AS "sourcePayloadSha256", status,
              source_count AS "sourceCount", accepted_count AS "acceptedCount",
              exception_count AS "exceptionCount", source_totals AS "sourceTotals",
              exception_summary AS "exceptionSummary", reconciliation_result AS "reconciliationResult",
              created_at AS "createdAt", validated_at AS "validatedAt", approved_at AS "approvedAt", imported_at AS "importedAt"
       FROM migration_batches WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Migration batch not found' });
    const exceptions = await query(
      `SELECT row_number AS "rowNumber", exception_code AS code, exception_fields AS fields, raw_record AS "rawRecord"
       FROM migration_staged_transactions WHERE batch_id = $1 AND validation_status = 'exception'
       ORDER BY row_number LIMIT 100`, [req.params.id]);
    await audit(null, {
      actorType: 'operator', actorId: req.operator.id, actorRole: req.operator.role,
      action: 'migration.batch_viewed', entityType: 'migration_batch', entityId: req.params.id,
      metadata: { exceptionCount: exceptions.rows.length }
    });
    res.json({ batch: rows[0], exceptions: exceptions.rows, cutoverAllowed: false });
  } catch (error) { next(error); }
});

// ---- audit trail -----------------------------------------------------------------
router.get('/operator/audit', ...guard('management', 'super_admin', 'auditor'), async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const { rows } = await query(
      `SELECT id, actor_type AS "actorType", actor_id AS "actorId", actor_role AS "actorRole",
              action, entity_type AS "entityType", entity_id AS "entityId", metadata,
              created_at AS "createdAt"
       FROM audit_events ORDER BY id DESC LIMIT ${limit}`);
    res.json({ events: rows });
  } catch (error) { next(error); }
});

function guard(...minTiers) {
  return [operatorAuth, (req, res, next) => {
    const allowed = minTiers.flatMap(t => TIERS[t]);
    if (!allowed.includes(req.operator.role)) {
      audit(null, {
        actorType: 'operator', actorId: req.operator.id, actorRole: req.operator.role,
        action: 'permission.denied', entityType: 'endpoint', entityId: req.originalUrl,
        metadata: { required: allowed, method: req.method }
      }).catch(() => {});
      return res.status(403).json({ error: 'Insufficient permissions for this operation' });
    }
    next();
  }];
}

export default router;
