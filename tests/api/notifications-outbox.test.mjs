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
