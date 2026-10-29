import { query } from './db.js';

const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function base64Url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
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
    `Subject: ${subject.replace(/[\r\n]/g, ' ')}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    text
  ].join('\r\n');
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
 * Stores an in-app notification and attempts email delivery. Email credentials
 * are environment-only. Missing credentials are recorded as skipped, never
 * reported as sent. Callers should await this best-effort operation after the
 * business transaction has committed.
 */
export async function notifyMember({ memberId, eventType, title, body, subject = title, emailText = body }) {
  const { rows } = await query('SELECT email FROM members WHERE id = $1', [memberId]);
  const recipient = rows[0]?.email;
  if (!recipient) return { status: 'skipped', reason: 'member_email_unavailable' };

  await query('INSERT INTO notifications (member_id, title, body) VALUES ($1,$2,$3)',
    [memberId, title, body]);

  let status = 'skipped';
  let providerMessageId = null;
  let errorCode = null;
  if (configured()) {
    try {
      providerMessageId = await sendGmail({ to: recipient, subject, text: emailText });
      status = 'sent';
    } catch (error) {
      status = 'failed';
      errorCode = String(error.code || 'email_delivery_failed').slice(0, 100);
      // Do not log tokens, credentials, message bodies, or recipient details.
      console.error('[avcu] email delivery failed:', errorCode);
    }
  }

  await query(
    `INSERT INTO email_delivery_log (member_id, recipient, event_type, subject, status, provider_message_id, error_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [memberId, recipient, eventType, subject, status, providerMessageId, errorCode]);
  return { status };
}

export function gmailConfigured() {
  return configured();
}
