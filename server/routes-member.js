import express from 'express';
import { query, withTx, audit } from './db.js';
import {
  memberAuth, applySessionCookie, clearAuthCookie,
  createMemberSession, destroySession, hashPassword, verifyPassword,
  findMemberByEmail, findMemberByIdentifier, destroyOtherMemberSessions
} from './auth.js';
import {
  rateLimiter, clientKey, validEmail, validPassword, validUsername, PASSWORD_MIN, hashCode, numericCode
} from './util.js';
import { submitMemberTransfer, submitMemberDeposit, freezeCard, testCardPurchase,
  createSupportCase, lookupIdempotent } from './services-member.js';
import {
  createPaymentRequest, listPaymentRequests, payPaymentRequest, closePaymentRequest,
  rewardSummary, redeemRewards, listCertificates, openCertificate,
  applyForLoan, listLoans, loanPayments, repayLoan, assertVerified
} from './services-finance.js';
import { runChat, renderReply, activeProvider } from './ai/index.js';
import { submitMemberTransfer as svcTransfer } from './services-member.js';

const router = express.Router();
// Higher than the operator limit because members often share NAT addresses.
const loginLimiter = rateLimiter({ windowMs: 60_000, max: 30 });
const aiLimiter = rateLimiter({ windowMs: 60_000, max: 20 });
const verificationLimiter = rateLimiter({ windowMs: 10 * 60_000, max: 5 });

// ---- auth -------------------------------------------------------------------
function memberSummary(member) {
  return {
    id: member.id, email: member.email, fullName: member.full_name || member.fullName,
    username: member.username, memberNumber: member.member_number || member.memberNumber,
    status: member.status, emailVerified: member.email_verified ?? member.emailVerified ?? false,
    phone: member.phone || null, mailingAddress: member.mailing_address || member.mailingAddress || null
  };
}

router.post('/auth/register', async (req, res, next) => {
  try {
    const { email, password, fullName } = req.body || {};
    const username = String(req.body?.username || '').trim().toLowerCase();
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (!validUsername(username)) {
      return res.status(400).json({
        error: 'Choose a username with 4-24 characters: letters, numbers, dots, dashes or underscores, starting with a letter'
      });
    }
    if (!validPassword(password)) return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN} characters` });
    const name = String(fullName || '').trim();
    if (name.length < 2 || name.length > 100) return res.status(400).json({ error: 'Enter your full name' });
    const existing = await findMemberByEmail(email);
    if (existing) return res.status(409).json({ error: 'An application with this email already exists' });
    const { rows: taken } = await query(
      'SELECT 1 FROM members WHERE lower(username) = lower($1)', [username]);
    if (taken.length) return res.status(409).json({ error: 'That username is already taken' });

    const hash = await hashPassword(password);
    const { rows } = await query(
      `INSERT INTO members (email, password_hash, full_name, username, status, application)
       VALUES (lower($1),$2,$3,$4,'pending',$5)
       RETURNING id, email, full_name, username, member_number, status, email_verified, created_at`,
      [email, hash, name, username,
       JSON.stringify({ channel: 'web', submittedAt: new Date().toISOString() })]);
    const member = rows[0];
    await query(
      `INSERT INTO approvals (item_type, member_id, payload, status, required_role, submitted_by, submitted_by_type)
       VALUES ('membership', $1, $2, 'pending', 'operator', $1, 'member')`, [member.id,
      JSON.stringify({ memberId: member.id, email: member.email, fullName: member.full_name, username: member.username })]);
    await audit(null, {
      actorType: 'member', actorId: member.id, action: 'membership.applied',
      entityType: 'member', entityId: member.id, metadata: { username }
    });
    res.status(201).json({
      member: {
        id: member.id, email: member.email, fullName: member.full_name,
        username: member.username, memberNumber: member.member_number, status: member.status
      },
      message: 'Application received. Your member number is issued immediately; accounts open after verification.'
    });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That email or username is already registered' });
    next(error);
  }
});

router.post('/auth/login', async (req, res, next) => {
  try {
    if (!loginLimiter(clientKey(req))) {
      return res.status(429).json({ error: 'Too many sign-in attempts. Wait a minute and try again.' });
    }
    const { password } = req.body || {};
    const identifier = req.body?.identifier || req.body?.email || req.body?.username;
    const member = await findMemberByIdentifier(identifier);
    const ok = member && await verifyPassword(String(password || ''), member.password_hash);
    if (!ok) return res.status(401).json({ error: 'Those credentials are incorrect' });
    if (member.status === 'rejected') {
      return res.status(403).json({ error: 'This membership application was not approved. Contact support.' });
    }
    const session = await createMemberSession(member.id);
    applySessionCookie(req, res, 'member', session);
    await query('UPDATE members SET last_login_at = now() WHERE id = $1', [member.id]);
    await audit(null, {
      actorType: 'member', actorId: member.id, action: 'member.login', entityType: 'member', entityId: member.id
    });
    res.json({ member: memberSummary(member) });
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

// ---- profile & security ------------------------------------------------------
router.patch('/profile', memberAuth, async (req, res, next) => {
  try {
    const phone = String(req.body?.phone || '').trim().slice(0, 32) || null;
    const mailingAddress = String(req.body?.mailingAddress || '').trim().slice(0, 200) || null;
    if (phone && !/^[0-9+()\-\s.]{7,32}$/.test(phone)) {
      return res.status(400).json({ error: 'Enter a valid phone number' });
    }
    const { rows } = await query(
      `UPDATE members SET phone = $1, mailing_address = $2, updated_at = now()
        WHERE id = $3 RETURNING id, phone, mailing_address`,
      [phone, mailingAddress, req.member.id]);
    await audit(null, {
      actorType: 'member', actorId: req.member.id, action: 'profile.updated',
      entityType: 'member', entityId: req.member.id
    });
    res.json({ profile: { phone: rows[0].phone, mailingAddress: rows[0].mailing_address } });
  } catch (error) { next(error); }
});

router.post('/auth/password', memberAuth, async (req, res, next) => {
  try {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (!validPassword(newPassword)) {
      return res.status(400).json({ error: `New password must be at least ${PASSWORD_MIN} characters` });
    }
    const { rows } = await query('SELECT password_hash FROM members WHERE id = $1', [req.member.id]);
    if (!await verifyPassword(currentPassword, rows[0].password_hash)) {
      return res.status(403).json({ error: 'Current password is incorrect' });
    }
    await query('UPDATE members SET password_hash = $1, updated_at = now() WHERE id = $2',
      [await hashPassword(newPassword), req.member.id]);
    await destroyOtherMemberSessions(req.member.id, req.sessionToken);
    await audit(null, {
      actorType: 'member', actorId: req.member.id, action: 'password.changed',
      entityType: 'member', entityId: req.member.id
    });
    res.json({ ok: true, message: 'Password updated. Other sessions were signed out.' });
  } catch (error) { next(error); }
});

// Development delivery: without a configured email provider the code is shown
// to the signed-in member so verification is still testable. Production must
// configure an email provider and stop returning the code.
router.post('/auth/email/verification-code', memberAuth, async (req, res, next) => {
  try {
    if (!verificationLimiter(`verify:${req.member.id}`)) {
      return res.status(429).json({ error: 'Too many verification requests. Try again later.' });
    }
    if (req.member.emailVerified) return res.json({ alreadyVerified: true });
    const code = numericCode(6);
    await query(
      `INSERT INTO email_verifications (member_id, code_hash, expires_at)
       VALUES ($1,$2, now() + interval '15 minutes')
       ON CONFLICT (member_id) DO UPDATE SET code_hash = EXCLUDED.code_hash,
         expires_at = EXCLUDED.expires_at, created_at = now()`,
      [req.member.id, hashCode(code)]);
    await audit(null, {
      actorType: 'member', actorId: req.member.id, action: 'email.verification_requested',
      entityType: 'member', entityId: req.member.id
    });
    const providerConfigured = Boolean(process.env.EMAIL_PROVIDER_API_KEY);
    res.json({
      delivery: providerConfigured ? 'email' : 'shown-in-app',
      message: providerConfigured
        ? 'A verification code was sent to your email address.'
        : 'No email provider is configured, so the code is shown here. It expires in 15 minutes.',
      ...(providerConfigured ? {} : { code })
    });
  } catch (error) { next(error); }
});

router.post('/auth/email/verify', memberAuth, async (req, res, next) => {
  try {
    const code = String(req.body?.code || '').trim();
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code' });
    const { rows } = await query(
      `SELECT code_hash, expires_at FROM email_verifications WHERE member_id = $1`, [req.member.id]);
    if (!rows[0] || new Date(rows[0].expires_at) <= new Date()) {
      return res.status(400).json({ error: 'That code expired. Request a new one.' });
    }
    if (rows[0].code_hash !== hashCode(code)) {
      return res.status(400).json({ error: 'That code is not correct' });
    }
    await query('UPDATE members SET email_verified = TRUE, updated_at = now() WHERE id = $1', [req.member.id]);
    await query('DELETE FROM email_verifications WHERE member_id = $1', [req.member.id]);
    await audit(null, {
      actorType: 'member', actorId: req.member.id, action: 'email.verified',
      entityType: 'member', entityId: req.member.id
    });
    res.json({ ok: true, emailVerified: true });
  } catch (error) { next(error); }
});

// ---- overview ---------------------------------------------------------------
router.get('/overview', memberAuth, async (req, res, next) => {
  try {
    const [accounts, transactions, notifications, card, requests] = await Promise.all([
      query(`SELECT id, kind, name, suffix, account_number AS "accountNumber",
                    routing_number AS "routingNumber", balance_cents AS "balanceCents", status,
                    opened_at AS "openedAt"
               FROM accounts WHERE member_id = $1 AND status = 'open' ORDER BY created_at`, [req.member.id]),
      query(`SELECT DISTINCT t.id, t.reference, t.type, t.status, t.amount_cents AS "amountCents",
                    t.memo, t.payee, t.occurred_at AS "occurredAt", t.created_at AS "createdAt",
                    t.description, fa.name AS "fromAccountName", ta.name AS "toAccountName"
               FROM transactions t
               JOIN accounts a ON (a.id = t.from_account_id OR a.id = t.to_account_id)
               LEFT JOIN accounts fa ON fa.id = t.from_account_id
               LEFT JOIN accounts ta ON ta.id = t.to_account_id
              WHERE a.member_id = $1 ORDER BY t.occurred_at DESC LIMIT 6`, [req.member.id]),
      query(`SELECT count(*) AS unread FROM notifications WHERE member_id = $1 AND read = FALSE`, [req.member.id]),
      query(`SELECT id, last4 AS "last4", status, expires FROM cards WHERE member_id = $1`, [req.member.id]),
      query(`SELECT count(*) AS pending FROM payment_requests
              WHERE payer_member_id = $1 AND status = 'pending'`, [req.member.id])
    ]);
    const totalCents = accounts.rows.reduce((sum, a) => sum + Number(a.balanceCents), 0);
    res.json({
      totalCents,
      accounts: accounts.rows,
      recentTransactions: transactions.rows,
      unreadNotifications: Number(notifications.rows[0].unread),
      pendingRequests: Number(requests.rows[0].pending),
      card: card.rows[0] || null
    });
  } catch (error) { next(error); }
});

// ---- accounts & transactions ------------------------------------------------
router.get('/accounts', memberAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, kind, name, suffix, account_number AS "accountNumber",
              routing_number AS "routingNumber", balance_cents AS "balanceCents", status,
              opened_at AS "openedAt"
       FROM accounts WHERE member_id = $1 AND status = 'open' ORDER BY created_at`, [req.member.id]);
    res.json({ accounts: rows });
  } catch (error) { next(error); }
});

router.get('/accounts/:id', memberAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, kind, name, suffix, account_number AS "accountNumber",
              routing_number AS "routingNumber", balance_cents AS "balanceCents", status,
              opened_at AS "openedAt"
         FROM accounts WHERE id = $1 AND member_id = $2`, [req.params.id, req.member.id]);
    const account = rows[0];
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const entries = await query(
      `SELECT id, direction, amount_cents AS "amountCents", balance_after_cents AS "balanceAfterCents",
              memo, occurred_at AS "occurredAt"
         FROM ledger_entries WHERE account_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 50`, [account.id]);
    res.json({ account, entries: entries.rows });
  } catch (error) { next(error); }
});

router.get('/transactions', memberAuth, async (req, res, next) => {
  try {
    const { search, type, status, from, to } = req.query;
    const capped = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const params = [req.member.id];
    let where = 'a.member_id = $1';
    const types = new Set(['transfer', 'bill_pay', 'deposit', 'card_auth', 'reversal', 'adjustment',
      'loan_disbursement', 'loan_payment', 'request_payment', 'certificate']);
    if (type && types.has(String(type))) { params.push(String(type)); where += ` AND t.type = $${params.length}`; }
    if (status && /^[a-z_]{3,20}$/.test(String(status))) {
      params.push(String(status)); where += ` AND t.status = $${params.length}`;
    }
    if (from && !Number.isNaN(Date.parse(String(from)))) {
      params.push(String(from)); where += ` AND t.occurred_at >= $${params.length}`;
    }
    if (to && !Number.isNaN(Date.parse(String(to)))) {
      params.push(String(to)); where += ` AND t.occurred_at <= $${params.length}`;
    }
    if (search) {
      params.push(`%${String(search).slice(0, 80)}%`);
      where += ` AND (t.memo ILIKE $${params.length} OR t.payee ILIKE $${params.length}
        OR t.reference ILIKE $${params.length} OR t.description ILIKE $${params.length}
        OR t.external_reference ILIKE $${params.length})`;
    }
    const { rows } = await query(
      `SELECT DISTINCT t.id, t.reference, t.external_reference AS "externalReference",
              t.type, t.status, t.amount_cents AS "amountCents", t.source,
              t.memo, t.payee, t.description,
              t.occurred_at AS "occurredAt", t.created_at AS "createdAt", t.posted_at AS "postedAt",
              t.from_account_id AS "fromAccountId", t.to_account_id AS "toAccountId",
              fa.name AS "fromAccountName", ta.name AS "toAccountName"
       FROM transactions t
       JOIN accounts a ON (a.id = t.from_account_id OR a.id = t.to_account_id)
       LEFT JOIN accounts fa ON fa.id = t.from_account_id
       LEFT JOIN accounts ta ON ta.id = t.to_account_id
       WHERE ${where}
       ORDER BY t.occurred_at DESC, t.created_at DESC LIMIT ${capped} OFFSET ${offset}`, params);
    res.json({ transactions: rows });
  } catch (error) { next(error); }
});

router.post('/transfers', memberAuth, async (req, res, next) => {
  try {
    const idempotencyKey = req.header('Idempotency-Key') || null;
    if (idempotencyKey) {
      const prior = await lookupIdempotent(idempotencyKey, `transfer:${req.member.id}`);
      if (prior) return res.json({ replayed: true, transaction: prior });
    }
    const result = await submitMemberTransfer({ member: req.member, body: req.body || {}, idempotencyKey });
    const tx = result.transaction;
    if (result.replayed) return res.json({ replayed: true, transaction: result.transaction });
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

// ---- money requests ----------------------------------------------------------
router.get('/requests', memberAuth, async (req, res, next) => {
  try {
    res.json(await listPaymentRequests(req.member.id));
  } catch (error) { next(error); }
});

router.post('/requests', memberAuth, async (req, res, next) => {
  try {
    const request = await createPaymentRequest({ member: req.member, body: req.body || {} });
    res.status(201).json({
      request: {
        id: request.id, amountCents: Number(request.amount_cents), memo: request.memo,
        status: request.status, createdAt: request.created_at
      }
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  }
});

router.post('/requests/:id/pay', memberAuth, async (req, res, next) => {
  try {
    const result = await payPaymentRequest({
      member: req.member, requestId: req.params.id, accountId: req.body?.accountId
    });
    res.status(result.needsApproval ? 202 : 201).json({
      ...result,
      message: result.needsApproval
        ? 'Payment submitted for review. It posts after approval.'
        : 'Payment sent.'
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  }
});

router.post('/requests/:id/decline', memberAuth, async (req, res, next) => {
  try {
    await closePaymentRequest({ member: req.member, requestId: req.params.id, action: 'decline' });
    res.json({ ok: true, status: 'declined' });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  }
});

router.post('/requests/:id/cancel', memberAuth, async (req, res, next) => {
  try {
    await closePaymentRequest({ member: req.member, requestId: req.params.id, action: 'cancel' });
    res.json({ ok: true, status: 'cancelled' });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  }
});

// ---- rewards -----------------------------------------------------------------
router.get('/rewards', memberAuth, async (req, res, next) => {
  try {
    res.json(await rewardSummary(req.member.id));
  } catch (error) { next(error); }
});

router.post('/rewards/redeem', memberAuth, async (req, res, next) => {
  try {
    const result = await redeemRewards({ member: req.member, body: req.body || {} });
    res.status(201).json(result);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  }
});

// ---- share certificates (investor commitments) --------------------------------
router.get('/investments', memberAuth, async (req, res, next) => {
  try {
    res.json({ certificates: await listCertificates(req.member.id) });
  } catch (error) { next(error); }
});

router.post('/investments', memberAuth, async (req, res, next) => {
  try {
    const result = await openCertificate({ member: req.member, body: req.body || {} });
    res.status(201).json(result);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  }
});

// ---- loans -------------------------------------------------------------------
router.get('/loans', memberAuth, async (req, res, next) => {
  try {
    const loans = await listLoans(req.member.id);
    const withPayments = await Promise.all(loans.map(async loan => ({
      ...loan,
      payments: loan.status === 'pending' ? [] : await loanPayments(req.member.id, loan.id)
    })));
    res.json({
      loans: withPayments,
      products: [
        { product: 'PERSONAL', label: 'Personal loan', aprBps: 1099, minCents: 50_000, maxCents: 5_000_000 },
        { product: 'AUTO', label: 'Auto loan', aprBps: 649, minCents: 250_000, maxCents: 5_000_000 },
        { product: 'SHARE_SECURED', label: 'Share-secured loan', aprBps: 599, minCents: 50_000, maxCents: 2_500_000 }
      ]
    });
  } catch (error) { next(error); }
});

router.post('/loans', memberAuth, async (req, res, next) => {
  try {
    const { loan, approvalId } = await applyForLoan({ member: req.member, body: req.body || {} });
    res.status(202).json({
      loan: {
        id: loan.id, reference: loan.reference, status: loan.status,
        principalCents: Number(loan.principal_cents), termMonths: loan.term_months
      },
      approvalId,
      message: 'Application submitted for a credit decision.'
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  }
});

router.post('/loans/:id/repay', memberAuth, async (req, res, next) => {
  try {
    const result = await repayLoan({ member: req.member, loanId: req.params.id, body: req.body || {} });
    res.status(201).json(result);
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

// ---- notifications ----------------------------------------------------------
router.get('/notifications', memberAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, title, body, kind, read, created_at AS "createdAt" FROM notifications
       WHERE member_id = $1 ORDER BY created_at DESC LIMIT 40`, [req.member.id]);
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

    const { task, rendered } = await runAiChat({ req, message, taskId });
    res.json({ taskId: task.id, status: rendered.status, message: rendered.message,
      toolCalls: rendered.toolCalls || [], provider: rendered.provider || undefined });
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
      toolCalls: rendered.toolCalls || [] });
  } catch (error) { next(error); }
});

export default router;
