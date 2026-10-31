import { query, withTx, audit } from '../db.js';
import { randomUUID } from 'node:crypto';
import { queueMemberNotification, queueOperationsEmail } from '../notifications.js';

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


// Authentication recovery and onboarding are repository-owned transactions.
// Reset tokens are single-use: row lock + used_at transition prevents replay.
export async function registerMember({ username, email, passwordHash, fullName }) {
  return withTx(async client => {
    const { rows } = await client.query(
      `INSERT INTO members (username, email, password_hash, full_name, status, application)
       VALUES ($1,lower($2),$3,$4,'pending',$5)
       RETURNING id, member_number AS "memberNumber", username, email, full_name, status, created_at`,
      [username, email, passwordHash, fullName, JSON.stringify({ channel: 'web', submittedAt: new Date().toISOString() })]);
    const created = rows[0];
    await client.query(
      `INSERT INTO approvals (item_type, member_id, payload, status, required_role, submitted_by, submitted_by_type)
       VALUES ('membership', $1, $2, 'pending', 'management', $1, 'member')`,
      [created.id, JSON.stringify({ memberId: created.id, username: created.username, email: created.email, fullName: created.full_name })]);
    await queueMemberNotification(client, { memberId: created.id,
      eventType: 'membership.application_received', eventKey: `membership-application:${created.id}:received`,
      title: 'Membership application received',
      body: 'Your membership application has been received and is awaiting review.',
      subject: 'We received your AVCU membership application' });
    return created;
  });
}
export async function createPasswordReset({ member, tokenHash, resetUrl }) {
  return withTx(async client => {
    // Serialize requests per member to ensure only the newest token remains usable.
    await client.query('SELECT id FROM members WHERE id = $1 FOR UPDATE', [member.id]);
    await client.query(
      `UPDATE password_reset_tokens SET used_at = now()
       WHERE member_id = $1 AND used_at IS NULL`, [member.id]);
    const { rows } = await client.query(
      `INSERT INTO password_reset_tokens (member_id, token_hash, expires_at)
       VALUES ($1,$2,now() + interval '30 minutes') RETURNING id, expires_at`,
      [member.id, tokenHash]);
    await client.query(
      `INSERT INTO notification_outbox
       (event_key, member_id, event_type, recipient, title, body, email_subject, email_text)
       VALUES ($1,$2,'auth.password_reset',$3,'Password reset instructions',$4,'AVCU password reset instructions',$4)
       ON CONFLICT (event_key) DO NOTHING`,
      [`password-reset:${rows[0].id}`, member.id, member.email,
       `Use this link within 30 minutes to reset your AVCU password: ${resetUrl.toString()}\nIf you did not request this, ignore this email. No funds or account details are included in this message.`]);
    await audit(client, { actorType: 'system', actorId: member.id,
      action: 'auth.password_reset_requested', entityType: 'member', entityId: member.id,
      metadata: { resetTokenId: rows[0].id, expiresAt: rows[0].expires_at } });
  });
}
export async function completePasswordReset({ tokenHash, passwordHash }) {
  return withTx(async client => {
    const { rows } = await client.query(
      `SELECT id, member_id FROM password_reset_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`, [tokenHash]);
    const reset = rows[0];
    if (!reset) {
      const error = new Error('The reset link is invalid or expired');
      error.status = 400;
      throw error;
    }
    const updated = await client.query(
      'UPDATE members SET password_hash = $1, updated_at = now() WHERE id = $2 RETURNING id',
      [passwordHash, reset.member_id]);
    if (!updated.rowCount) {
      const error = new Error('The reset link is invalid or expired');
      error.status = 400;
      throw error;
    }
    await client.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL', [reset.id]);
    await client.query("UPDATE notification_outbox SET body = '', email_text = '' WHERE event_key = $1", [`password-reset:${reset.id}`]);
    await client.query('DELETE FROM member_sessions WHERE member_id = $1', [reset.member_id]);
    await client.query(
      `UPDATE password_reset_tokens SET used_at = now()
       WHERE member_id = $1 AND id <> $2 AND used_at IS NULL`, [reset.member_id, reset.id]);
    await audit(client, { actorType: 'system', actorId: reset.member_id,
      action: 'auth.password_reset_completed', entityType: 'member', entityId: reset.member_id });
    return { memberId: reset.member_id };
  });
}


export async function createLoanApplication({ memberId, amountCents, currency, termMonths, purpose, publicBaseUrl }) {
  return withTx(async client => {
    const reference = `AVCU-LA-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
    const inserted = await client.query(
      `INSERT INTO loan_applications
       (member_id, reference, requested_amount_cents, currency, requested_term_months, purpose)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [memberId, reference, amountCents, currency, termMonths, purpose]);
    const created = inserted.rows[0];
    const approval = await client.query(
      `INSERT INTO approvals (item_type, member_id, payload, status, required_role, submitted_by, submitted_by_type)
       VALUES ('loan',$1,$2,'pending','management',$1,'member') RETURNING id`,
      [memberId, JSON.stringify({ loanApplicationId: created.id, reference,
        requestedAmountCents: amountCents, currency, requestedTermMonths: termMonths, purpose })]);
    await client.query('UPDATE loan_applications SET approval_id = $1 WHERE id = $2', [approval.rows[0].id, created.id]);
    await client.query(
      `INSERT INTO operations_alerts (alert_type, loan_application_id)
       VALUES ('loan_application_submitted',$1) ON CONFLICT (alert_type, loan_application_id) DO NOTHING`, [created.id]);
    let reviewPath = '/operator-portal.html';
    try { if (publicBaseUrl) reviewPath = new URL('/operator-portal.html', publicBaseUrl).toString(); } catch {}
    await queueOperationsEmail(client, { eventKey: `loan-application-operations:${created.id}:submitted`,
      eventType: 'loan.application_submitted', title: 'New loan application submitted',
      subject: `New AVCU loan application ${reference}`,
      body: [`Reference: ${reference}`, `Submitted at (UTC): ${new Date(created.submitted_at).toISOString()}`,
        `Requested amount: ${(amountCents / 100).toFixed(2)} ${currency}`,
        termMonths ? `Requested term: ${termMonths} months` : null,
        `Review workspace: ${reviewPath}`,
        'Sign in with your authorized staff account to review the application. No funds have been disbursed.'
      ].filter(Boolean).join(String.fromCharCode(10)) });
    await queueMemberNotification(client, { memberId, eventType: 'loan.application_received',
      eventKey: `loan-application:${created.id}:submitted`, title: 'Loan application received',
      body: `Application ${reference} was submitted and is awaiting review.`,
      subject: 'AVCU loan application received' });
    await audit(client, { actorType: 'member', actorId: memberId, action: 'loan.application_submitted',
      entityType: 'loan_application', entityId: created.id,
      metadata: { reference, requestedAmountCents: amountCents, currency, requestedTermMonths: termMonths } });
    return { ...created, approval_id: approval.rows[0].id };
  });
}
export async function submitLoanInformation({ applicationId, memberId, responseText }) {
  return withTx(async client => {
    const { rows } = await client.query(
      `SELECT id, reference, approval_id AS "approvalId", status
       FROM loan_applications WHERE id = $1 AND member_id = $2 FOR UPDATE`, [applicationId, memberId]);
    const current = rows[0];
    if (!current) { const error = new Error('Loan application not found'); error.status = 404; throw error; }
    if (current.status !== 'information_required' || !current.approvalId) {
      const error = new Error('This application is not waiting for information'); error.status = 409; throw error;
    }
    const approval = await client.query(
      `UPDATE approvals SET status = 'pending', info_requested = NULL, decision_reason = NULL,
       decided_at = NULL, updated_at = now() WHERE id = $1 AND status = 'info_requested' RETURNING id`,
      [current.approvalId]);
    if (!approval.rowCount) { const error = new Error('The review state changed; refresh and try again'); error.status = 409; throw error; }
    await client.query(
      `UPDATE loan_applications SET status = 'submitted', member_response = $1,
       information_requested = NULL, updated_at = now() WHERE id = $2`, [responseText, current.id]);
    await client.query(
      `UPDATE operations_alerts SET status = 'pending', acknowledged_at = NULL, acknowledged_by = NULL
       WHERE loan_application_id = $1`, [current.id]);
    await queueMemberNotification(client, { memberId, eventType: 'loan.application_information_received',
      eventKey: `loan-application:${current.id}:information-received:${randomUUID()}`,
      title: 'Additional information submitted',
      body: `Your response for application ${current.reference} was submitted for review.`,
      subject: 'AVCU loan application update' });
    await audit(client, { actorType: 'member', actorId: memberId,
      action: 'loan.application_information_submitted', entityType: 'loan_application', entityId: current.id });
    return { id: current.id, reference: current.reference, status: 'submitted' };
  });
}
export async function createMoneyRequest({ memberId, requestType, amountCents, currency, note }) {
  return withTx(async client => {
    const reference = `AVCU-MR-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
    const inserted = await client.query(
      `INSERT INTO money_requests (member_id, reference, request_type, amount_cents, currency, member_note)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [memberId, reference, requestType, amountCents, currency, note]);
    const created = inserted.rows[0];
    const approval = await client.query(
      `INSERT INTO approvals (item_type, member_id, payload, status, required_role, submitted_by, submitted_by_type)
       VALUES ('money_request',$1,$2,'pending','management',$1,'member') RETURNING id`,
      [memberId, JSON.stringify({ moneyRequestId: created.id, reference, requestType, amountCents, currency, note })]);
    await client.query('UPDATE money_requests SET approval_id = $1 WHERE id = $2', [approval.rows[0].id, created.id]);
    await client.query(
      `INSERT INTO operations_alerts (alert_type, money_request_id)
       VALUES ('money_request_submitted',$1) ON CONFLICT DO NOTHING`, [created.id]);
    await queueOperationsEmail(client, { eventKey: `money-request-operations:${created.id}:submitted`,
      eventType: 'money_request.submitted', title: 'New money request submitted',
      subject: `New AVCU money request ${reference}`,
      body: [`Reference: ${reference}`, `Submitted at (UTC): ${new Date(created.submitted_at).toISOString()}`,
        `Requested amount: ${(amountCents / 100).toFixed(2)} ${currency}`, `Request type: ${requestType}`,
        'Sign in with your authorized staff account to review. Approval does not move funds.'
      ].join(String.fromCharCode(10)) });
    await queueMemberNotification(client, { memberId, eventType: 'money_request.received',
      eventKey: `money-request:${created.id}:submitted`, title: 'Money request received',
      body: `Request ${reference} was submitted for review. No funds have been moved.`,
      subject: 'AVCU money request received' });
    await audit(client, { actorType: 'member', actorId: memberId, action: 'money_request.submitted',
      entityType: 'money_request', entityId: created.id,
      metadata: { reference, requestType, amountCents, currency } });
    return { ...created, approval_id: approval.rows[0].id };
  });
}
export async function submitMoneyRequestInformation({ requestId, memberId, responseText }) {
  return withTx(async client => {
    const { rows } = await client.query(
      `SELECT id, reference, approval_id AS "approvalId", status
       FROM money_requests WHERE id = $1 AND member_id = $2 FOR UPDATE`, [requestId, memberId]);
    const current = rows[0];
    if (!current) { const error = new Error('Money request not found'); error.status = 404; throw error; }
    if (current.status !== 'information_required' || !current.approvalId) {
      const error = new Error('This request is not waiting for information'); error.status = 409; throw error;
    }
    const approval = await client.query(
      `UPDATE approvals SET status = 'pending', info_requested = NULL, decision_reason = NULL,
       decided_at = NULL, updated_at = now() WHERE id = $1 AND status = 'info_requested' RETURNING id`,
      [current.approvalId]);
    if (!approval.rowCount) { const error = new Error('The review state changed; refresh and try again'); error.status = 409; throw error; }
    await client.query(
      `UPDATE money_requests SET status = 'submitted', member_response = $1,
       information_requested = NULL, updated_at = now() WHERE id = $2`, [responseText, current.id]);
    await client.query(
      `UPDATE operations_alerts SET status = 'pending', acknowledged_at = NULL, acknowledged_by = NULL
       WHERE money_request_id = $1`, [current.id]);
    await queueMemberNotification(client, { memberId, eventType: 'money_request.information_received',
      eventKey: `money-request:${current.id}:information-received:${randomUUID()}`,
      title: 'Additional information submitted',
      body: `Your response for request ${current.reference} was submitted for review.`,
      subject: 'AVCU money request update' });
    await audit(client, { actorType: 'member', actorId: memberId,
      action: 'money_request.information_submitted', entityType: 'money_request', entityId: current.id });
    return { id: current.id, reference: current.reference, status: 'submitted' };
  });
}
