import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, loginMember, loginOperator, getAccounts, api } from './helpers.mjs';
import { query } from '../../server/db.js';
import { notifyMember, processNotificationOutbox } from '../../server/notifications.js';

test('notification outbox persists in-app events and deduplicates stable event keys', async t => {
  const previous = {
    clientId: process.env.AVCU_GMAIL_CLIENT_ID,
    clientSecret: process.env.AVCU_GMAIL_CLIENT_SECRET,
    refreshToken: process.env.AVCU_GMAIL_REFRESH_TOKEN,
    from: process.env.AVCU_GMAIL_FROM
  };
  delete process.env.AVCU_GMAIL_CLIENT_ID;
  delete process.env.AVCU_GMAIL_CLIENT_SECRET;
  delete process.env.AVCU_GMAIL_REFRESH_TOKEN;
  delete process.env.AVCU_GMAIL_FROM;

  const env = await startTestServer();
  t.after(async () => {
    await env.close();
    for (const [key, value] of Object.entries({
      AVCU_GMAIL_CLIENT_ID: previous.clientId,
      AVCU_GMAIL_CLIENT_SECRET: previous.clientSecret,
      AVCU_GMAIL_REFRESH_TOKEN: previous.refreshToken,
      AVCU_GMAIL_FROM: previous.from
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const { response } = await loginMember(env.base);
  assert.equal(response.status, 200);
  const memberId = response.data.member.id;
  const event = {
    memberId,
    eventType: 'test.approval_decided',
    eventKey: 'test-approval:AVCU-42:approved',
    title: 'Request update',
    body: 'Your request was approved.',
    subject: 'AVCU request update'
  };
  const first = await notifyMember(event);
  const duplicate = await notifyMember(event);
  assert.equal(first.status, 'queued');
  assert.equal(duplicate.duplicate, true);

  const queued = await query(
    'SELECT id, status, attempts FROM notification_outbox WHERE event_key = $1',
    [event.eventKey]
  );
  assert.equal(queued.rows.length, 1);
  assert.equal(queued.rows[0].status, 'pending');

  const notifications = await query(
    'SELECT count(*)::int AS count FROM notifications WHERE member_id = $1 AND title = $2',
    [memberId, event.title]
  );
  assert.equal(notifications.rows[0].count, 1);

  const processed = await processNotificationOutbox();
  assert.equal(processed.processed, 1);
  const final = await query(
    'SELECT status, attempts FROM notification_outbox WHERE event_key = $1',
    [event.eventKey]
  );
  assert.equal(final.rows[0].status, 'skipped', 'missing Gmail credentials must never be reported as sent');
  assert.equal(Number(final.rows[0].attempts), 1);
});


test('financial rejection, audit, and member notification are committed together', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie: memberCookie } = await loginMember(env.base);
  const accounts = await getAccounts(env.base, memberCookie);
  const draft = accounts.find(account => account.name === 'Share Draft');
  const primary = accounts.find(account => account.name === 'Primary Share');
  const submitted = await api(env.base, '/api/transfers', {
    method: 'POST',
    cookie: memberCookie,
    body: {
      kind: 'share',
      fromAccountId: draft.id,
      toAccountId: primary.id,
      amountCents: 300000,
      memo: 'outbox rejection test'
    }
  });
  assert.equal(submitted.status, 202);
  const approvalId = submitted.data.approvalId;

  const { cookie: managerCookie } = await loginOperator(env.base, 'manager@avcu.demo');
  const decision = await api(env.base, `/api/operator/approvals/${approvalId}/decide`, {
    method: 'POST',
    cookie: managerCookie,
    body: { action: 'reject', reason: 'Synthetic test rejection' }
  });
  assert.equal(decision.status, 200);
  assert.equal(decision.data.approval.status, 'rejected');

  const { rows: txRows } = await query(
    'SELECT status, decision_reason FROM transactions WHERE id = $1',
    [submitted.data.transaction.id]
  );
  assert.equal(txRows[0].status, 'rejected');
  assert.equal(txRows[0].decision_reason, 'Synthetic test rejection');

  const { rows: outboxRows } = await query(
    `SELECT event_key, member_id, status FROM notification_outbox
     WHERE event_key = $1`,
    [`transaction-approval:${approvalId}:rejected:${(await query('SELECT id FROM members WHERE email = $1', ['jordan@avcu.demo'])).rows[0].id}`]
  );
  assert.equal(outboxRows.length, 1, 'the terminal decision creates one durable member notification');
});


test('loan application review, information request, operations alert, and final decision work end to end', async t => {
  const oldEnv = {
    operationsEmail: process.env.AVCU_OPERATIONS_EMAIL,
    gmailClientId: process.env.AVCU_GMAIL_CLIENT_ID,
    gmailClientSecret: process.env.AVCU_GMAIL_CLIENT_SECRET,
    gmailRefreshToken: process.env.AVCU_GMAIL_REFRESH_TOKEN,
    gmailFrom: process.env.AVCU_GMAIL_FROM
  };
  process.env.AVCU_OPERATIONS_EMAIL = 'operations@avcu.demo';
  delete process.env.AVCU_GMAIL_CLIENT_ID;
  delete process.env.AVCU_GMAIL_CLIENT_SECRET;
  delete process.env.AVCU_GMAIL_REFRESH_TOKEN;
  delete process.env.AVCU_GMAIL_FROM;
  const env = await startTestServer();
  t.after(async () => {
    await env.close();
    const restore = {
      AVCU_OPERATIONS_EMAIL: oldEnv.operationsEmail,
      AVCU_GMAIL_CLIENT_ID: oldEnv.gmailClientId,
      AVCU_GMAIL_CLIENT_SECRET: oldEnv.gmailClientSecret,
      AVCU_GMAIL_REFRESH_TOKEN: oldEnv.gmailRefreshToken,
      AVCU_GMAIL_FROM: oldEnv.gmailFrom
    };
    for (const [key, value] of Object.entries(restore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const { cookie: memberCookie } = await loginMember(env.base);
  const submitted = await api(env.base, '/api/loans/applications', {
    method: 'POST',
    cookie: memberCookie,
    body: {
      requestedAmountCents: 250000,
      currency: 'USD',
      requestedTermMonths: 24,
      purpose: 'Synthetic integration test for a small emergency expense.'
    }
  });
  assert.equal(submitted.status, 201);
  assert.equal(submitted.data.application.status, 'submitted');
  assert.match(submitted.data.application.reference, /^AVCU-LA-[A-F0-9]{12}$/);
  const { rows: opsEmails } = await query(
    'SELECT recipient, status FROM notification_outbox WHERE event_key = $1',
    [`loan-application-operations:${submitted.data.application.id}:submitted`]
  );
  assert.equal(opsEmails.length, 1, 'the operations email is durably queued with the application');
  assert.equal(opsEmails[0].recipient, 'operations@avcu.demo');

  const { cookie: operatorCookie } = await loginOperator(env.base, 'teller@avcu.demo');
  const alerts = await api(env.base, '/api/operator/loan-alerts?status=pending', { cookie: operatorCookie });
  assert.equal(alerts.status, 200);
  const alert = alerts.data.alerts.find(item => item.applicationId === submitted.data.application.id);
  assert.ok(alert, 'submission creates a persistent operations alert');
  const ack = await api(env.base, `/api/operator/loan-alerts/${alert.id}/acknowledge`, {
    method: 'POST', cookie: operatorCookie, body: {}
  });
  assert.equal(ack.status, 200);
  assert.equal(ack.data.alert.status, 'acknowledged');

  const info = await api(env.base, `/api/operator/approvals/${submitted.data.application.approvalId}/decide`, {
    method: 'POST', cookie: operatorCookie,
    body: { action: 'request_info', reason: 'Please provide a little more detail about the requested amount.' }
  });
  assert.equal(info.status, 200);
  const waiting = await api(env.base, '/api/loans/applications', { cookie: memberCookie });
  assert.equal(waiting.data.applications[0].status, 'information_required');

  const response = await api(env.base, `/api/loans/applications/${submitted.data.application.id}/information`, {
    method: 'POST', cookie: memberCookie,
    body: { response: 'This is additional synthetic detail to support the application review.' }
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.application.status, 'submitted');

  const unauthorizedFinal = await api(env.base, `/api/operator/approvals/${submitted.data.application.approvalId}/decide`, {
    method: 'POST', cookie: operatorCookie,
    body: { action: 'approve', reason: 'Operator cannot make a final loan decision.' }
  });
  assert.equal(unauthorizedFinal.status, 403);

  const { cookie: managerCookie } = await loginOperator(env.base, 'manager@avcu.demo');
  const approved = await api(env.base, `/api/operator/approvals/${submitted.data.application.approvalId}/decide`, {
    method: 'POST', cookie: managerCookie,
    body: { action: 'approve', reason: 'Approved for application workflow testing only.' }
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.approval.status, 'approved');

  const history = await api(env.base, '/api/loans/applications', { cookie: memberCookie });
  assert.equal(history.data.applications[0].status, 'approved');
  assert.equal(history.data.applications[0].decisionReason, 'Approved for application workflow testing only.');

  const { rows: loans } = await query('SELECT count(*)::int AS count FROM loan_applications WHERE id = $1', [submitted.data.application.id]);
  assert.equal(loans[0].count, 1, 'approval records the application only; no loan balance or disbursement is created');
});


test('funding pool participation stays disabled until authorized provider controls exist', async t => {
  const env = await startTestServer();
  t.after(() => env.close());
  const { cookie } = await loginMember(env.base);
  const catalogue = await api(env.base, '/funding-pools', { cookie });
  assert.equal(catalogue.status, 200);
  assert.equal(catalogue.data.liveContributionsEnabled, false);
  assert.deepEqual(catalogue.data.pools, []);

  const attempt = await api(env.base, '/funding-pools/00000000-0000-4000-8000-000000000001/contributions', {
    method: 'POST', cookie, body: { amountCents: 10000 }
  });
  assert.equal(attempt.status, 503);
  assert.equal(attempt.data.liveContributionsEnabled, false);
  assert.equal(attempt.data.code, 'funding_provider_not_authorized');
});
