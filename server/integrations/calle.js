import { createHash } from 'node:crypto';

const BASE_URL = 'https://api.heycall-e.com';
const TIMEOUT_MS = 20_000;

export class CalleIntegrationError extends Error {
  constructor(message, code, { status = 502, retryable = false } = {}) {
    super(message);
    this.name = 'CalleIntegrationError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function requireApiKey() {
  const apiKey = process.env.CALLE_API_KEY;
  if (!apiKey || apiKey.length < 12) {
    throw new CalleIntegrationError('CALL-E API credentials are not configured', 'callee_credentials_missing', { status: 503 });
  }
  return apiKey;
}

function requireDispatchEnabled() {
  if (process.env.ECHO_CALL_DISPATCH_ENABLED !== 'true') {
    throw new CalleIntegrationError('ECHO voice dispatch is disabled', 'echo_dispatch_disabled', { status: 503 });
  }
}

function assertEligible(preflight) {
  // This object must be assembled by trusted AVCU server code, never from request input.
  const required = [
    'phoneVerified', 'consentActive', 'notDoNotCall', 'withinCallingWindow',
    'callerIdApproved', 'recordingDisclosureApproved', 'retentionApproved', 'complianceApproved'
  ];
  if (!preflight || required.some(key => preflight[key] !== true)) {
    throw new CalleIntegrationError('ECHO call did not pass every dispatch preflight gate', 'echo_preflight_blocked', { status: 403 });
  }
}

function assertPhone(phone) {
  if (typeof phone !== 'string' || !/^\+[1-9][0-9]{7,14}$/.test(phone)) {
    throw new CalleIntegrationError('A verified E.164 recipient is required', 'invalid_recipient', { status: 400 });
  }
}

function stableKey(eventKey) {
  if (typeof eventKey !== 'string' || eventKey.length < 8 || eventKey.length > 500) {
    throw new CalleIntegrationError('A stable AVCU event key is required', 'invalid_event_key', { status: 400 });
  }
  return `avcu-echo-${createHash('sha256').update(eventKey).digest('hex')}`;
}

async function request(path, { method = 'GET', apiKey, body, idempotencyKey } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const response = await fetch(`${BASE_URL}${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal, redirect: 'error'
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* handled as an invalid provider response below */ }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status === 503 || response.status >= 500;
      throw new CalleIntegrationError(
        `CALL-E request rejected (HTTP ${response.status})`,
        typeof payload?.code === 'string' ? payload.code : 'callee_http_error',
        { status: response.status === 429 ? 429 : 502, retryable }
      );
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new CalleIntegrationError('CALL-E returned an invalid response', 'callee_invalid_response');
    }
    return payload;
  } catch (error) {
    if (error instanceof CalleIntegrationError) throw error;
    if (error.name === 'AbortError') {
      throw new CalleIntegrationError('CALL-E request timed out; recover using the same idempotency key', 'callee_timeout', { retryable: true });
    }
    throw new CalleIntegrationError('CALL-E network request failed; outcome may be unknown', 'callee_network_error', { retryable: true });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Creates one generic, privacy-preserving AVCU notification call.
 * The call must not reveal amounts, account data, counterparties, or transaction
 * references. A stable event key prevents duplicate calls on worker retries.
 */
export async function createCalleEchoCall({ phone, eventKey, preflight }) {
  assertEligible(preflight);
  assertPhone(phone);
  requireDispatchEnabled();
  const apiKey = requireApiKey();
  const idempotencyKey = stableKey(eventKey);
  const result = await request('/v2/calls', {
    method: 'POST',
    apiKey,
    idempotencyKey,
    body: {
      task: [
        'You are ECHO, an automated AI assistant calling on behalf of American Vanguard Credit Union (AVCU).',
        'Politely tell the recipient only that AVCU has a secure account notification for them and they should sign in to the official AVCU app or contact AVCU using the number on their card or official website.',
        'Do not state or imply any transaction amount, balance, account number, transaction status, merchant, sender, recipient, or other private banking detail.',
        'Do not ask for or accept a password, PIN, CVV, one-time passcode, or full card/account number.',
        'If the person says this is the wrong number, apologize, end the call, and do not disclose anything else.',
        'If voicemail answers, leave only the same generic message. If asked for sensitive details, direct them to the authenticated AVCU channel.',
        'Do not make promises, provide financial advice, or initiate any banking action. End politely.'
      ].join(' '),
      phone,
      region: 'US',
      locale: 'en-US',
      result_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['outcome'],
        properties: {
          outcome: {
            type: 'string',
            enum: ['person_reached', 'voicemail', 'wrong_number', 'declined', 'no_answer', 'unknown']
          }
        }
      },
      metadata: {
        source: 'avcu-echo',
        event_fingerprint: createHash('sha256').update(eventKey).digest('hex')
      }
    }
  });
  if (typeof result.id !== 'string' || !result.id) {
    throw new CalleIntegrationError('CALL-E accepted no usable call resource ID; do not submit a new logical call', 'callee_missing_resource_id');
  }
  return {
    resourceId: result.id,
    status: typeof result.status === 'string' ? result.status : 'accepted',
    resultStatus: typeof result.result_status === 'string' ? result.result_status : 'pending'
  };
}

/** Read an existing provider call. This function can never create or redial. */
export async function getCalleEchoCall(resourceId) {
  if (typeof resourceId !== 'string' || !/^[A-Za-z0-9_-]{6,200}$/.test(resourceId)) {
    throw new CalleIntegrationError('A valid CALL-E resource ID is required', 'invalid_provider_call_id', { status: 400 });
  }
  const apiKey = requireApiKey();
  const result = await request(`/v2/calls/${encodeURIComponent(resourceId)}`, { apiKey });
  return {
    resourceId: result.id,
    status: result.status,
    callOutcome: result.call_outcome ?? null,
    resultStatus: result.result_status,
    result: result.result ?? null,
    error: result.error ?? null,
    transcript: Array.isArray(result.transcript) ? result.transcript : []
  };
}
