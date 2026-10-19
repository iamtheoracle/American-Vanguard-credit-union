import express from 'express';
import { query, withTx, audit } from './db.js';
import {
  operatorAuth, requireOperatorRole, applySessionCookie, clearAuthCookie,
  createOperatorSession, destroySession, hashPassword, verifyPassword, findOperatorByEmail
} from './auth.js';
import { rateLimiter, clientKey, validEmail, validPassword, PASSWORD_MIN } from './util.js';
import { decideApproval, reversePostedTransaction } from './approvals.js';
import { integrationHealth } from './integrations/index.js';

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

const TIERS = {
  operator: ['operator'],
  management: ['management', 'super_admin'],
  super_admin: ['super_admin']
};

router.get('/operator/queue', ...guard('management', 'operator'), async (req, res, next) => {
  try {
    const [approvals, cases, aiFailed, membership, health] = await Promise.all([
      query(`SELECT count(*) FILTER (WHERE status = 'pending') AS pending,
                    count(*) FILTER (WHERE status = 'escalated') AS escalated
             FROM approvals`),
      query(`SELECT count(*) FILTER (WHERE status IN ('open','in_progress')) AS open,
                    count(*) FILTER (WHERE status = 'escalated') AS escalated
             FROM support_cases`),
      query(`SELECT count(*) AS failed FROM ai_tasks WHERE status = 'failed'`),
      query(`SELECT count(*) AS pending FROM members WHERE status = 'pending'`),
      integrationHealth()
    ]);
    res.json({
      approvals: { pending: Number(approvals.rows[0].pending), escalated: Number(approvals.rows[0].escalated) },
      cases: { open: Number(cases.rows[0].open), escalated: Number(cases.rows[0].escalated) },
      aiFailed: Number(aiFailed.rows[0].failed),
      membershipPending: Number(membership.rows[0].pending),
      integrations: health
    });
  } catch (error) { next(error); }
});

router.get('/operator/approvals', ...guard('management', 'operator'), async (req, res, next) => {
  try {
    const status = ['pending', 'escalated', 'approved', 'rejected', 'info_requested']
      .includes(req.query.status) ? req.query.status : null;
    const params = [];
    let where = 'TRUE';
    if (status) { params.push(status); where = `a.status = $${params.length}`; }
    const { rows } = await query(
      `SELECT a.id, a.item_type AS "itemType", a.status, a.required_role AS "requiredRole",
              a.payload, a.created_at AS "createdAt", a.decided_at AS "decidedAt",
              a.decision_reason AS "decisionReason", a.assigned_to AS "assignedTo",
              a.submitted_by_type AS "submittedByType", a.submitted_by AS "submittedBy",
              t.id AS "transactionId", t.reference, t.type AS "transactionType",
              t.amount_cents AS "amountCents", t.status AS "transactionStatus",
              m.full_name AS "memberName", m.email AS "memberEmail", m.id AS "memberId"
       FROM approvals a
       LEFT JOIN transactions t ON t.id = a.transaction_id
       LEFT JOIN members m ON m.id = a.member_id
       WHERE ${where}
       ORDER BY CASE a.status WHEN 'escalated' THEN 0 ELSE 1 END, a.created_at DESC
       LIMIT 100`, params);
    res.json({ approvals: rows });
  } catch (error) { next(error); }
});

router.post('/operator/approvals/:id/decide', ...guard('management', 'operator'), async (req, res, next) => {
  try {
    const { action, reason } = req.body || {};
    const result = await decideApproval({ approvalId: req.params.id, operator: req.operator, action, reason });
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
    res.json({ member, accounts: accounts.rows, transactions: transactions.rows });
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

// ---- audit trail -----------------------------------------------------------------
router.get('/operator/audit', ...guard('management', 'super_admin'), async (req, res, next) => {
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
