import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, loginMember } from './helpers.mjs';
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
