import { randomUUID } from 'node:crypto';
import { query, withTx } from './db.js';

const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 10;

function base64Url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\\+/g, '-').replace(/\\//g, '_');
}

function configured() {
  return Boolean(process.env.AVCU_GMAIL_CLIENT_ID && process.env.AVCU_GMAIL_CLIENT_SECRET &&
    process.env.AVCU_GMAIL_REFRESH_TOKEN && process.env.AVCU_GMAIL_FROM);
}

async function accessToken() {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.AVCU_GMAIL_CLIENT_ID,
      client_secret: process.env.AVCU_GMAIL_CLIENT_SECRET,
      refresh_token: process.env.AVCU_GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    }),
    signal: AbortSignal.timeout(8000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const error = new Error('Gmail OAuth token refresh failed');
    error.code = data.error || 'gmail_oauth_failed';
    throw error;
  }
  return data.access_token;
}

async function sendGmail({ to, subject, text }) {
  const token = await accessToken();
  const raw = [
    `From: American Vantoris Credit Union <${process.env.AVCU_GMAIL_FROM}>`,
    `To: ${to}`,
    `Subject: ${subject.replace(/[\\r\\n]/g, ' ')}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    text
  ].join('\\r\\n');
  const response = await fetch(API_BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: base64Url(raw) }),
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('Gmail message send failed');
    error.code = data.error?.status || 'gmail_send_failed';
    throw error;
  }
  return data.id || null;
}

/**
 * Persist in-app and email work before delivery. Callers should pass a stable
 * eventKey derived from the business record and state transition for dedupe.
 */
export async function queueMemberNotification(client, {
  memberId, eventType, title, body, subject = title, emailText = body,
  eventKey = `${eventType}:${memberId}:${randomUUID()}`
}) {
  if (typeof memberId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(memberId)) {
    return { status: 'skipped', reason: 'invalid_member_id' };
  }
  const { rows } = await client.query('SELECT email FROM members WHERE id = $1 FOR SHARE', [memberId]);
  const recipient = rows[0]?.email;
  if (!recipient) return { status: 'skipped', reason: 'member_email_unavailable' };

  const inserted = await client.query(
    `INSERT INTO notification_outbox
      (event_key, member_id, event_type, recipient, title, body, email_subject, email_text)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING id`,
    [eventKey, memberId, eventType, recipient, title, body, subject, emailText]);
  if (inserted.rows.length) {
    await client.query('INSERT INTO notifications (member_id, title, body) VALUES ($1,$2,$3)',
      [memberId, title, body]);
    return { status: 'queued', outboxId: inserted.rows[0].id, duplicate: false };
  }
  const existing = await client.query('SELECT id, status FROM notification_outbox WHERE event_key = $1', [eventKey]);
  return { status: 'queued', outboxId: existing.rows[0]?.id ?? null, duplicate: true };
}

export async function notifyMember(options) {
  return withTx(client => queueMemberNotification(client, options));
}
export async function queueOperationsEmail(client, {
  eventKey, eventType, title, body, subject = title,
  recipient = process.env.AVCU_OPERATIONS_EMAIL
}) {
  const email = String(recipient || '').trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { status: 'skipped', reason: 'operations_email_not_configured' };
  }
  const { rows } = await client.query(
    `INSERT INTO notification_outbox
      (event_key, member_id, event_type, recipient, title, body, email_subject, email_text)
     VALUES ($1,NULL,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING id`,
    [eventKey, eventType, email, title, body, subject, body]);
  if (rows.length) return { status: 'queued', outboxId: rows[0].id, duplicate: false };
  const existing = await client.query('SELECT id, status FROM notification_outbox WHERE event_key = $1', [eventKey]);
  return { status: 'queued', outboxId: existing.rows[0]?.id ?? null, duplicate: true };
}


/**
 * Claims due events with SKIP LOCKED so multiple app instances can share the
 * queue. A crash leaves a recoverable processing lease; retries are bounded.
 */
export async function processNotificationOutbox() {
  const claimed = await withTx(async client => {
    await client.query(
      `UPDATE notification_outbox
       SET status = 'retry', locked_at = NULL, next_attempt_at = now(), updated_at = now()
       WHERE status = 'processing' AND locked_at < now() - interval '2 minutes'`);
    const { rows } = await client.query(
      `SELECT * FROM notification_outbox
       WHERE status IN ('pending','retry') AND next_attempt_at <= now()
       ORDER BY id
       LIMIT $1
       FOR UPDATE SKIP LOCKED`, [BATCH_SIZE]);
    for (const row of rows) {
      await client.query(
        `UPDATE notification_outbox
         SET status = 'processing', attempts = attempts + 1, locked_at = now(), updated_at = now()
         WHERE id = $1`, [row.id]);
      row.attempts = Number(row.attempts) + 1;
    }
    return rows;
  });

  for (const row of claimed) {
    let status = 'skipped';
    let providerMessageId = null;
    let errorCode = null;
    if (configured()) {
      try {
        providerMessageId = await sendGmail({ to: row.recipient, subject: row.email_subject, text: row.email_text });
        status = 'sent';
      } catch (error) {
        errorCode = String(error.code || 'email_delivery_failed').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 100) || 'email_delivery_failed';
        status = row.attempts >= MAX_ATTEMPTS ? 'failed' : 'retry';
        console.error('[avcu] email delivery failed:', errorCode);
      }
    }

    const delaySeconds = Math.min(3600, 30 * (2 ** Math.max(0, row.attempts - 1)));
    await withTx(async client => {
      await client.query(
        `UPDATE notification_outbox
         SET status = $2, provider_message_id = $3, last_error_code = $4,
             next_attempt_at = CASE WHEN $2 = 'retry' THEN now() + ($5 * interval '1 second') ELSE next_attempt_at END,
             locked_at = NULL, updated_at = now(),
             sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END
         WHERE id = $1 AND status = 'processing'`,
        [row.id, status, providerMessageId, errorCode, delaySeconds]);
      const deliveryLogStatus = status === 'retry' ? 'failed' : status;
      await client.query(
        `INSERT INTO email_delivery_log (member_id, recipient, event_type, subject, status, provider_message_id, error_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [row.member_id, row.recipient, row.event_type, row.email_subject, deliveryLogStatus, providerMessageId, errorCode]);
      if (row.event_type === 'auth.password_reset' && status !== 'retry') {
        if (status !== 'sent') {
          const resetId = String(row.event_key || '').startsWith('password-reset:')
            ? String(row.event_key).slice('password-reset:'.length) : '';
          if (/^[0-9a-f-]{36}$/i.test(resetId)) {
            await client.query(
              'UPDATE password_reset_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL',
              [resetId]);
          }
        }
        await client.query(
          `UPDATE notification_outbox SET body = '', email_text = '' WHERE id = $1`, [row.id]);
      }
    });
  }
  return { processed: claimed.length };
}

let workerTimer = null;
let workerRunning = false;

export function startNotificationWorker({ intervalMs = 3000 } = {}) {
  if (workerTimer) return stopNotificationWorker;
  const tick = async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      await processNotificationOutbox();
    } catch (error) {
      console.error('[avcu] notification outbox worker failed:', String(error.code || error.name || 'worker_error'));
    } finally {
      workerRunning = false;
    }
  };
  void tick();
  workerTimer = setInterval(tick, intervalMs);
  workerTimer.unref?.();
  return stopNotificationWorker;
}

export function stopNotificationWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}

export function gmailConfigured() {
  return configured();
}
