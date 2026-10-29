import express from 'express';
import { randomUUID } from 'node:crypto';
import { query, withTx, audit } from './db.js';
import {
  memberAuth, operatorAuth, applySessionCookie, clearAuthCookie,
  createMemberSession, createOperatorSession, destroySession, hashPassword, verifyPassword,
  findMemberByEmail, findMemberByLogin, findOperatorByEmail
} from './auth.js';
import { rateLimiter, clientKey, validEmail, validPassword, PASSWORD_MIN, COOKIE_MEMBER, COOKIE_OPERATOR } from './util.js';
import { submitMemberTransfer, submitMemberDeposit, freezeCard, testCardPurchase,
  createSupportCase, lookupIdempotent } from './services-member.js';
import { runChat, renderReply, activeProvider } from './ai/index.js';
import { submitMemberTransfer as svcTransfer } from './services-member.js';
import { notifyMember, queueMemberNotification, queueOperationsEmail } from './notifications.js';
import { recalculateMemberTier } from './membership-tiers.js';

const router = express.Router();
const loginLimiter = rateLimiter({ windowMs: 60_000, max: 8 });
const aiLimiter = rateLimiter({ windowMs: 60_000, max: 20 });

// ---- auth -------------------------------------------------------------------
router.post('/auth/register', async (req, res, next) => {
  try {
    const { email, password, fullName } = req.body || {};
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (!validPassword(password)) return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN} characters` });
    const name = String(fullName || '').trim();
    if (name.length < 2 || name.length > 100) return res.status(400).json({ error: 'Enter your full name' });
    const existing = await findMemberByEmail(email);
    if (existing) return res.status(409).json({ error: 'An application with this email already exists' });
    const hash = await hashPassword(password);
    const member = await withTx(async client => {
      const { rows } = await client.query(
        `INSERT INTO members (email, password_hash, full_name, status, application)
         VALUES (lower($1),$2,$3,'pending',$4)
         RETURNING id, member_number AS "memberNumber", email, full_name, status, created_at`,
        [email, hash, name, JSON.stringify({ channel: 'web', submittedAt: new Date().toISOString() })]);
      const created = rows[0];
      await client.query(
        `INSERT INTO approvals (item_type, member_id, payload, status, required_role, submitted_by, submitted_by_type)
         VALUES ('membership', $1, $2, 'pending', 'management', $1, 'member')`,
        [created.id, JSON.stringify({ memberId: created.id, email: created.email, fullName: created.full_name })]);
      await queueMemberNotification(client, {
        memberId: created.id,
        eventType: 'membership.application_received',
        eventKey: `membership-application:${created.id}:received`,
        title: 'Membership application received',
        body: 'Your membership application has been received and is awaiting review.',
        subject: 'We received your AVCU membership application'
      });
      return created;
    });
    await recalculateMemberTier(member.id).catch(error => console.error('[avcu] initial tier calculation failed:', error.code || error.name));
    res.status(201).json({ member: { id: member.id, memberNumber: String(member.memberNumber), email: member.email, fullName: member.full_name, status: member.status },
      message: 'Application received. Sign in to track its status.' });
  } catch (error) { next(error); }
});

router.post('/auth/login', async (req, res, next) => {
  try {
    if (!loginLimiter(clientKey(req))) {
      return res.status(429).json({ error: 'Too many sign-in attempts. Wait a minute and try again.' });
    }
    const { identifier, email, password } = req.body || {};
    const member = await findMemberByLogin(String(identifier || email || ''));
    const ok = member && await verifyPassword(String(password || ''), member.password_hash);
    if (!ok) return res.status(401).json({ error: 'Email or password is incorrect' });
    const session = await createMemberSession(member.id);
    applySessionCookie(req, res, 'member', session);
    const tier = await recalculateMemberTier(member.id).catch(() => null);
    res.json({ member: { id: member.id, memberNumber: String(member.member_number), email: member.email, fullName: member.full_name, status: member.status,
      membershipTier: tier?.tier || member.membership_tier || 'new_member' } });
  } catch (error) { next(error); }
});

router.post('/auth/logout', memberAuth, async (req, res, next) => {
  try {
    await destroySession('member', req.sessionToken);
    clearAuthCookie(req, res, 'member');
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.get('/auth/me', memberAuth, (req, res) => {
  res.json({ member: req.member });
});

router.get('/membership-tier', memberAuth, async (req, res, next) => {
  try {
    const tier = await recalculateMemberTier(req.member.id);
    res.json({ membership: tier, progress: tier?.progress || null });
  } catch (error) { next(error); }

});

// ---- accounts & transactions ------------------------------------------------
router.get('/accounts', memberAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, kind, name, suffix, balance_cents AS "balanceCents", status
       FROM accounts WHERE member_id = $1 AND status = 'open' ORDER BY created_at`, [req.member.id]);
    res.json({ accounts: rows.map(row => ({ ...row, balanceCents: Number(row.balanceCents) })) });
  } catch (error) { next(error); }
});

router.get('/transactions', memberAuth, async (req, res, next) => {
  try {
    const { search, type, limit = '50' } = req.query;
    const capped = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const params = [req.member.id];
    let where = 'a.member_id = $1';
    if (type) { params.push(String(type)); where += ` AND t.type = $${params.length}`; }
    if (search) {
      params.push(`%${String(search).slice(0, 80)}%`);
      where += ` AND (t.memo ILIKE $${params.length} OR t.payee ILIKE $${params.length} OR t.reference ILIKE $${params.length})`;
    }
    const { rows } = await query(
      `SELECT DISTINCT t.id, t.reference, t.type, t.status, t.amount_cents AS "amountCents",
              t.memo, t.payee, t.created_at AS "createdAt",
              fa.name AS "fromAccountName", ta.name AS "toAccountName"
       FROM transactions t
       JOIN accounts a ON (a.id = t.from_account_id OR a.id = t.to_account_id)
       LEFT JOIN accounts fa ON fa.id = t.from_account_id
       LEFT JOIN accounts ta ON ta.id = t.to_account_id
       WHERE ${where}
       ORDER BY t.created_at DESC LIMIT ${capped}`, params);
    res.json({ transactions: rows.map(row => ({ ...row, amountCents: Number(row.amountCents) })) });
  } catch (error) { next(error); }
});

router.post('/transfers', memberAuth, async (req, res, next) => {
  try {
    const idempotencyKey = req.header('Idempotency-Key') || null;
    if (idempotencyKey) {
      const prior = await lookupIdempotent(idempotencyKey, `transfer:${req.member.id}`);
      if (prior) return res.json({ replayed: true, transaction: prior, approvalId: prior.approvalId || null });
    }
    const result = await submitMemberTransfer({ member: req.member, body: req.body || {}, idempotencyKey });
    const tx = result.transaction;
    if (result.replayed) return res.json({ replayed: true, transaction: result.transaction });
    await recalculateMemberTier(req.member.id).catch(() => {});
    await notifyMember({ memberId: req.member.id, eventType: 'transaction.transfer_submitted',
      eventKey: `transaction:${tx.id}:transfer-submitted`,
      title: 'Transfer status update', body: `Your transfer ${tx.reference} is ${tx.status.replaceAll('_', ' ')}.`,
      subject: 'AVCU transfer status update' }).catch(error => console.error('[avcu] notification failed:', error.code || error.name));
    res.status(result.approvalId ? 202 : 201).json({
      transaction: { id: tx.id, reference: tx.reference, status: tx.status, amountCents: tx.amount_cents },
      approvalId: result.approvalId,
      message: tx.status === 'pending_approval'
        ? 'Submitted for review. Balances update after approval.' : 'Transfer completed.'
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  }
});

router.post('/deposits', memberAuth, async (req, res, next) => {
  try {
    const idempotencyKey = req.header('Idempotency-Key') || null;
    const result = await submitMemberDeposit({ member: req.member, body: req.body || {}, idempotencyKey });
    if (result.replayed) return res.json({ replayed: true, transaction: result.transaction, approvalId: result.approvalId || null });
    await recalculateMemberTier(req.member.id).catch(() => {});
    await notifyMember({ memberId: req.member.id, eventType: 'transaction.deposit_submitted',
      eventKey: `transaction:${result.transaction.id}:deposit-submitted`,
      title: 'Deposit status update', body: `Your deposit ${result.transaction.reference} is ${result.transaction.status.replaceAll('_', ' ')}.`,
      subject: 'AVCU deposit status update' }).catch(error => console.error('[avcu] notification failed:', error.code || error.name));
    res.status(result.approvalId ? 202 : 201).json({
      transaction: { id: result.transaction.id, reference: result.transaction.reference, status: result.transaction.status },
      message: result.status === 'pending_review'
        ? 'Deposit received and awaiting review.' : 'Deposit posted.'
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  }
});

// ---- card -------------------------------------------------------------------
router.get('/card', memberAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, last4 AS "last4", status, expires FROM cards WHERE member_id = $1`, [req.member.id]);
    res.json({ card: rows[0] || null });
  } catch (error) { next(error); }
});

router.post('/card/freeze', memberAuth, async (req, res, next) => {
  try {
    const card = await freezeCard({ member: req.member, frozen: Boolean(req.body?.frozen) });
    res.json({ card: { id: card.id, last4: card.last4, status: card.status } });
  } catch (error) { next(error); }
});

router.post('/card/test-purchase', memberAuth, async (req, res, next) => {
  try {
    const result = await testCardPurchase({ member: req.member, body: req.body || {} });
    const d = result.decision;
    res.status(d.outcome === 'approved' ? 200 : 402).json({
      outcome: d.outcome, reason: d.reason || null, sandbox: Boolean(d.sandbox),
      reference: result.transaction.reference,
      message: d.outcome === 'approved'
        ? `Sandbox authorization approved for ${req.body.merchant}. No funds moved.`
        : 'Sandbox authorization declined.'
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  }
});

// ---- loan applications ------------------------------------------------------
router.get('/loans/applications', memberAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, reference, requested_amount_cents AS "requestedAmountCents",
              currency, requested_term_months AS "requestedTermMonths", purpose, status,
              decision_reason AS "decisionReason", information_requested AS "informationRequested", submitted_at AS "submittedAt",
              reviewed_at AS "reviewedAt", created_at AS "createdAt"
       FROM loan_applications WHERE member_id = $1
       ORDER BY created_at DESC LIMIT 50`, [req.member.id]);
    res.json({ applications: rows.map(row => ({ ...row, requestedAmountCents: Number(row.requestedAmountCents) })) });
  } catch (error) { next(error); }
});

router.post('/loans/applications', memberAuth, async (req, res, next) => {
  try {
    if (req.member.status !== 'verified') {
      return res.status(403).json({ error: 'Membership verification is required before applying for a loan', code: 'membership_pending' });
    }
    const body = req.body || {};
    const amountCents = body.requestedAmountCents ?? body.amountCents;
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: 'Enter a positive whole-number amount in cents', code: 'invalid_amount' });
    }
    const currency = String(body.currency || 'USD').toUpperCase();
    if (currency !== 'USD') {
      return res.status(400).json({ error: 'Only USD applications are currently supported', code: 'unsupported_currency' });
    }
    const termMonths = body.requestedTermMonths == null || body.requestedTermMonths === ''
      ? null : Number(body.requestedTermMonths);
    if (termMonths !== null && (!Number.isSafeInteger(termMonths) || termMonths <= 0)) {
      return res.status(400).json({ error: 'Requested term must be a positive whole number of months', code: 'invalid_term' });
    }
    const purpose = String(body.purpose || '').trim();
    if (purpose.length < 10 || purpose.length > 2000) {
      return res.status(400).json({ error: 'Describe the purpose in 10–2000 characters', code: 'invalid_purpose' });
    }

    const application = await withTx(async client => {
      const reference = `AVCU-LA-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
      const { rows } = await client.query(
        `INSERT INTO loan_applications
          (member_id, reference, requested_amount_cents, currency, requested_term_months, purpose)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.member.id, reference, amountCents, currency, termMonths, purpose]);
      const created = rows[0];
      const approval = await client.query(
        `INSERT INTO approvals (item_type, member_id, payload, status, required_role, submitted_by, submitted_by_type)
         VALUES ('loan',$1,$2,'pending','management',$1,'member') RETURNING id`,
        [req.member.id, JSON.stringify({
          loanApplicationId: created.id, reference, requestedAmountCents: amountCents,
          currency, requestedTermMonths: termMonths, purpose
        })]);
      await client.query('UPDATE loan_applications SET approval_id = $1 WHERE id = $2', [approval.rows[0].id, created.id]);
      await client.query(
        `INSERT INTO operations_alerts (alert_type, loan_application_id)
         VALUES ('loan_application_submitted',$1) ON CONFLICT (alert_type, loan_application_id) DO NOTHING`,
        [created.id]);
      const reviewPath = process.env.AVCU_PUBLIC_BASE_URL
        ? new URL('/operator-portal.html', process.env.AVCU_PUBLIC_BASE_URL).toString()
        : '/operator-portal.html';
      await queueOperationsEmail(client, {
        eventKey: `loan-application-operations:${created.id}:submitted`,
        eventType: 'loan.application_submitted',
        title: 'New loan application submitted',
        subject: `New AVCU loan application ${reference}`,
        body: [
          `Reference: ${reference}`,
          `Submitted at (UTC): ${new Date(created.submitted_at).toISOString()}`,
          `Requested amount: ${(amountCents / 100).toFixed(2)} ${currency}`,
          termMonths ? `Requested term: ${termMonths} months` : null,
          `Review workspace: ${reviewPath}`,
          'Sign in with your authorized staff account to review the application. No funds have been disbursed.'
        ].filter(Boolean).join(String.fromCharCode(10))
      });
      await queueMemberNotification(client, {
        memberId: req.member.id,
        eventType: 'loan.application_received',
        eventKey: `loan-application:${created.id}:submitted`,
        title: 'Loan application received',
        body: `Application ${reference} was submitted and is awaiting review.`,
        subject: 'AVCU loan application received'
      });
      await audit(client, {
        actorType: 'member', actorId: req.member.id, action: 'loan.application_submitted',
        entityType: 'loan_application', entityId: created.id,
        metadata: { reference, requestedAmountCents: amountCents, currency, requestedTermMonths: termMonths }
      });
      return { ...created, approval_id: approval.rows[0].id };
    });
    res.status(201).json({
      application: {
        id: application.id, reference: application.reference,
        requestedAmountCents: Number(application.requested_amount_cents),
        currency: application.currency, requestedTermMonths: application.requested_term_months,
        purpose: application.purpose, status: application.status, submittedAt: application.submitted_at,
        approvalId: application.approval_id
      },
      message: 'Application submitted for review. Submission does not guarantee approval or disbursement.'
    });
  } catch (error) { next(error); }
});

router.post('/loans/applications/:id/information', memberAuth, async (req, res, next) => {
  try {
    const responseText = String(req.body?.response || '').trim();
    if (responseText.length < 10 || responseText.length > 2000) {
      return res.status(400).json({ error: 'Provide a response between 10 and 2000 characters', code: 'invalid_response' });
    }
    const application = await withTx(async client => {
      const { rows } = await client.query(
        `SELECT id, reference, approval_id AS "approvalId", status
         FROM loan_applications WHERE id = $1 AND member_id = $2 FOR UPDATE`,
        [req.params.id, req.member.id]);
      const current = rows[0];
      if (!current) {
        const error = new Error('Loan application not found');
        error.status = 404;
        throw error;
      }
      if (current.status !== 'information_required' || !current.approvalId) {
        const error = new Error('This application is not waiting for information');
        error.status = 409;
        throw error;
      }
      const updatedApproval = await client.query(
        `UPDATE approvals SET status = 'pending', info_requested = NULL, decision_reason = NULL,
           decided_at = NULL, updated_at = now()
         WHERE id = $1 AND status = 'info_requested' RETURNING id`,
        [current.approvalId]);
      if (!updatedApproval.rowCount) {
        const error = new Error('The review state changed; refresh and try again');
        error.status = 409;
        throw error;
      }
      await client.query(
        `UPDATE loan_applications
         SET status = 'submitted', member_response = $1, information_requested = NULL, updated_at = now()
         WHERE id = $2`, [responseText, current.id]);
      await client.query(
        `UPDATE operations_alerts
         SET status = 'pending', acknowledged_at = NULL, acknowledged_by = NULL
         WHERE loan_application_id = $1`, [current.id]);
      await queueMemberNotification(client, {
        memberId: req.member.id,
        eventType: 'loan.application_information_received',
        eventKey: `loan-application:${current.id}:information-received:${randomUUID()}`,
        title: 'Additional information submitted',
        body: `Your response for application ${current.reference} was submitted for review.`,
        subject: 'AVCU loan application update'
      });
      await audit(client, {
        actorType: 'member', actorId: req.member.id, action: 'loan.application_information_submitted',
        entityType: 'loan_application', entityId: current.id
      });
      return { id: current.id, reference: current.reference, status: 'submitted' };
    });
    res.json({ application });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  }
});

// ---- funding pool discovery -------------------------------------------------
router.get('/funding-pools', memberAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.id, p.name, p.description, p.target_amount_cents AS "targetAmountCents",
              p.currency, p.opens_at AS "opensAt", p.closes_at AS "closesAt",
              p.eligibility_requirements AS "eligibilityRequirements",
              p.fees_and_terms AS "feesAndTerms", p.risk_disclosure AS "riskDisclosure",
              p.return_assumptions AS "returnAssumptions",
              p.calculation_methodology AS "calculationMethodology",
              p.synthetic,
              COALESCE(sum(c.amount_cents) FILTER (WHERE c.status = 'verified' AND c.currency = p.currency), 0) AS "verifiedAmountCents"
       FROM funding_pools p
       LEFT JOIN funding_contributions c ON c.funding_pool_id = p.id
       WHERE p.status = 'published'
       GROUP BY p.id
       ORDER BY p.opens_at NULLS LAST, p.created_at DESC LIMIT 50`);
    const pools = rows.map(pool => {
      const target = Number(pool.targetAmountCents);
      const verified = Number(pool.verifiedAmountCents);
      return {
        ...pool,
        targetAmountCents: target,
        verifiedAmountCents: verified,
        progressPercent: target > 0 ? Math.min(100, Math.floor(verified / target * 100)) : 0,
        participationEnabled: false,
        participationStatus: pool.synthetic
          ? 'Synthetic preview only; not an actual investment.'
          : 'Live contributions are disabled until the authorized provider and release controls are verified.'
      };
    });
    res.json({ pools, liveContributionsEnabled: false });
  } catch (error) { next(error); }
});

router.post('/funding-pools/:id/contributions', memberAuth, async (req, res) => {
  res.status(503).json({
    error: 'Contributions are disabled. No funds were requested or transferred.',
    code: 'funding_provider_not_authorized',
    liveContributionsEnabled: false
  });
});

// ---- notifications ----------------------------------------------------------
router.get('/notifications', memberAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, title, body, read, created_at AS "createdAt" FROM notifications
       WHERE member_id = $1 ORDER BY created_at DESC LIMIT 30`, [req.member.id]);
    res.json({ notifications: rows });
  } catch (error) { next(error); }
});

router.post('/notifications/mark-read', memberAuth, async (req, res, next) => {
  try {
    await query('UPDATE notifications SET read = TRUE WHERE member_id = $1', [req.member.id]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// ---- support cases ----------------------------------------------------------
router.get('/support/cases', memberAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.id, c.subject, c.status, c.priority, c.created_at AS "createdAt",
              (SELECT count(*) FROM case_messages m WHERE m.case_id = c.id) AS message_count
       FROM support_cases c WHERE c.member_id = $1 ORDER BY c.created_at DESC`, [req.member.id]);
    res.json({ cases: rows });
  } catch (error) { next(error); }
});

router.post('/support/cases', memberAuth, async (req, res, next) => {
  try {
    const created = await createSupportCase({ member: req.member,
      subject: req.body?.subject, body: req.body?.body });
    res.status(201).json({ case: { id: created.id, subject: created.subject, status: created.status } });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  }
});

router.get('/support/cases/:id', memberAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.* FROM support_cases c WHERE c.id = $1 AND c.member_id = $2`, [req.params.id, req.member.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Case not found' });
    const { rows: messages } = await query(
      `SELECT m.id, m.author_type AS "authorType", m.body, m.created_at AS "createdAt"
       FROM case_messages m WHERE m.case_id = $1 ORDER BY m.id`, [req.params.id]);
    res.json({ case: rows[0], messages });
  } catch (error) { next(error); }
});

router.post('/support/cases/:id/messages', memberAuth, async (req, res, next) => {
  try {
    const body = String(req.body?.body || '').trim().slice(0, 2000);
    if (!body) return res.status(400).json({ error: 'Message cannot be empty' });
    const { rows } = await query(
      `SELECT id FROM support_cases WHERE id = $1 AND member_id = $2`, [req.params.id, req.member.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Case not found' });
    const { rows: inserted } = await query(
      `INSERT INTO case_messages (case_id, author_type, author_id, body) VALUES ($1,'member',$2,$3) RETURNING *`,
      [req.params.id, req.member.id, body]);
    res.status(201).json({ message: inserted[0] });
  } catch (error) { next(error); }
});

// ---- AI assistant -----------------------------------------------------------
// AI chat: a task row is created first so retries reuse the same idempotency
// keys, meaning tool side effects (transfer proposals, cases) never duplicate.
async function runAiChat({ req, message, taskId }) {
  const hooks = {
    submitTransfer: args => svcTransfer({
      member: req.member, body: { kind: 'share', ...args },
      idempotencyKey: `ai-task-${taskId}:transfer`, aiContext: true
    }),
    createSupportCase: args => createSupportCase({ member: req.member, ...args })
  };
  const completion = await runChat({ member: req.member, message, history: [], hooks });
  const rendered = renderReply(completion, completion.toolCalls || []);
  const { rows } = await query(
    `UPDATE ai_tasks SET status = $1, provider = $2, output = $3, tool_calls = $4, error = $5, completed_at = now()
     WHERE id = $6 RETURNING id, status`,
    [completion.status === 'failed' ? 'failed' : 'succeeded', completion.provider,
     JSON.stringify(rendered), JSON.stringify(completion.toolCalls || []), completion.error || null, taskId]);
  return { task: rows[0], rendered, completion };
}

router.post('/ai/chat', memberAuth, async (req, res, next) => {
  try {
    if (!aiLimiter(clientKey(req))) return res.status(429).json({ error: 'Too many assistant messages. Try again shortly.' });
    const message = String(req.body?.message || '').trim().slice(0, 4000);
    if (!message) return res.status(400).json({ error: 'Message cannot be empty' });

    const { rows } = await query(
      `INSERT INTO ai_tasks (requester_type, requester_id, purpose, status, provider, input_excerpt)
       VALUES ('member',$1,'member_chat','pending',$2,$3) RETURNING id`,
      [req.member.id, activeProvider(), message.slice(0, 500)]);
    const taskId = rows[0].id;

    const { task, rendered, completion } = await runAiChat({ req, message, taskId });
    res.json({ taskId: task.id, status: rendered.status, message: rendered.message,
      toolCalls: rendered.toolCalls || [], provider: completion.provider || activeProvider() });
  } catch (error) { next(error); }
});

router.post('/ai/retry', memberAuth, async (req, res, next) => {
  try {
    const { taskId } = req.body || {};
    if (!taskId) return res.status(400).json({ error: 'taskId is required' });
    const { rows } = await query(
      `SELECT * FROM ai_tasks WHERE id = $1 AND requester_id = $2 AND requester_type = 'member'`,
      [taskId, req.member.id]);
    const task = rows[0];
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!task.input_excerpt) return res.status(400).json({ error: 'Original message unavailable' });
    await query(`UPDATE ai_tasks SET status = 'pending', error = NULL WHERE id = $1`, [taskId]);

    const { task: updated, rendered } = await runAiChat({
      req, message: task.input_excerpt, taskId
    });
    res.json({ taskId: updated.id, status: rendered.status, message: rendered.message,
      toolCalls: rendered.toolCalls || [], provider: activeProvider() });
  } catch (error) { next(error); }
});

export default router;
