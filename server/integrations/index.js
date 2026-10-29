import crypto from 'node:crypto';
import { POLICY } from '../policy.js';

/**
 * Central integration layer. Real partner credentials are never present in
 * code; adapters read configuration from the environment only. When no partner
 * is authorized, the clearly-separated sandbox adapters run instead and every
 * response they produce is labeled as sandbox data.
 *
 * The outbound wrapper adds: timeouts, bounded retries, error classification,
 * a per-adapter circuit breaker, and structured logging.
 */

export class IntegrationError extends Error {
  constructor(message, code, { status = 502, adapter, retryable = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.adapter = adapter;
    this.retryable = retryable;
  }
}

const CLASSIFY = {
  AbortError: () => new IntegrationError('Upstream timed out', 'timeout', { retryable: true }),
  TypeError: () => new IntegrationError('Network unreachable', 'network_error', { retryable: true }),
  ECONNRESET: () => new IntegrationError('Connection reset', 'network_error', { retryable: true })
};

function classify(error, adapter) {
  if (error instanceof IntegrationError) return error;
  const maker = CLASSIFY[error.name] || CLASSIFY[error.code];
  if (maker) return maker();
  return new IntegrationError(`Upstream error: ${error.message}`, 'provider_error', { adapter });
}

const breakers = new Map(); // adapter -> {failures, openedAt}

function circuitState(adapter) {
  const b = breakers.get(adapter);
  if (!b) return 'closed';
  if (b.openedAt && Date.now() - b.openedAt > POLICY.CIRCUIT_COOLDOWN_MS) {
    breakers.delete(adapter);
    return 'closed';
  }
  return b.failures >= POLICY.CIRCUIT_THRESHOLD ? 'open' : 'closed';
}

function recordFailure(adapter) {
  const b = breakers.get(adapter) || { failures: 0, openedAt: null };
  b.failures += 1;
  if (b.failures >= POLICY.CIRCUIT_THRESHOLD) b.openedAt = Date.now();
  breakers.set(adapter, b);
}

function recordSuccess(adapter) {
  breakers.delete(adapter);
}

export function breakerStatus(adapter) {
  return circuitState(adapter);
}

/**
 * Bounded outbound call. Retries only when the classified error is retryable
 * and the caller supplied an idempotency key, so uncertain money movement is
 * never retried automatically.
 */
export async function outbound(adapterName, fn, { idempotencyKey = null, timeoutMs = POLICY.INTEGRATION_TIMEOUT_MS } = {}) {
  if (circuitState(adapterName) === 'open') {
    throw new IntegrationError(`${adapterName} circuit open; manual processing required`, 'circuit_open', { adapter: adapterName });
  }
  let lastError = null;
  for (let attempt = 1; attempt <= POLICY.INTEGRATION_MAX_RETRIES; attempt += 1) {
    try {
      const result = await withTimeout(fn(attempt), timeoutMs);
      recordSuccess(adapterName);
      return result;
    } catch (error) {
      lastError = classify(error, adapterName);
      if (!lastError.retryable || !idempotencyKey || attempt === POLICY.INTEGRATION_MAX_RETRIES) break;
    }
  }
  if (lastError.retryable) recordFailure(adapterName);
  else recordFailure(adapterName);
  throw lastError;
}

function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => setTimeout(() => {
      const e = new Error('Timed out');
      e.name = 'AbortError';
      reject(e);
    }, ms))
  ]);
}

// ---- Sandbox adapters --------------------------------------------------------
export function sandboxFailureMode() {
  return process.env.AVCU_SANDBOX_FAIL || 'none'; // none | card | payments | all
}

const DELAY_MS = Number(process.env.AVCU_SANDBOX_DELAY_MS || 25);

export const cardIssuerAdapter = {
  name: 'card-issuer',
  mode: 'sandbox',
  async health() {
    if (['card', 'all'].includes(sandboxFailureMode())) return { status: 'down', detail: { reason: 'sandbox failure injection' } };
    return { status: 'healthy', detail: { mode: 'sandbox' } };
  },
  /** Sandbox card authorization. Declines frozen cards; never moves money. */
  async authorize({ providerRef, frozen, amountCents, merchant }) {
    if (['card', 'all'].includes(sandboxFailureMode())) {
      throw new IntegrationError('Card issuer unavailable (sandbox)', 'provider_error', { adapter: 'card-issuer' });
    }
    if (frozen) return { outcome: 'declined', reason: 'card_frozen', sandbox: true };
    if (amountCents > POLICY.CARD_PURCHASE_MAX_CENTS) return { outcome: 'declined', reason: 'amount_limit', sandbox: true };
    return { outcome: 'approved', authorizationId: `sbx-auth-${providerRef}-${Date.now()}`, merchant, sandbox: true };
  }
};

export const paymentsAdapter = {
  name: 'payments',
  mode: 'sandbox',
  async health() {
    if (['payments', 'all'].includes(sandboxFailureMode())) return { status: 'down', detail: { reason: 'sandbox failure injection' } };
    return { status: 'healthy', detail: { mode: 'sandbox' } };
  },
  /** Sandbox bill payment submission. Returns a pending external state only. */
  async submitPayment({ amountCents, payee, idempotencyKey }) {
    if (['payments', 'all'].includes(sandboxFailureMode())) {
      throw new IntegrationError('Payment rail unavailable (sandbox)', 'provider_error', { adapter: 'payments' });
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
    return { outcome: 'submitted', sandbox: true, providerPaymentId: `sbx-pay-${idempotencyKey || Date.now()}`, amountCents, payee };
  }
};

export const ADAPTERS = { 'card-issuer': cardIssuerAdapter, payments: paymentsAdapter };

export async function integrationHealth() {
  const out = [];
  for (const adapter of Object.values(ADAPTERS)) {
    const state = await adapter.health();
    const circuit = circuitState(adapter.name);
    out.push({ name: adapter.name, mode: adapter.mode, ...state, circuit });
  }
  return out;
}

export function verifyWebhookSignature({ secret, body, signature, timestamp }) {
  const tolerance = POLICY.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS * 1000;
  if (typeof secret !== 'string' || secret.length === 0) return false;
  if (typeof timestamp !== 'string' || !/^\\d+$/.test(timestamp)) return false;
  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(Date.now() - timestampMs) > tolerance) return false;
  if (typeof signature !== 'string' || !/^(?:sha256=)?[a-f0-9]{64}$/.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${body}`).digest();
  const supplied = Buffer.from(signature.replace(/^sha256=/, ''), 'hex');
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

export function webhookSecret(provider) {
  const specific = process.env[`AVCU_WEBHOOK_SECRET_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  if (specific) return specific;
  // Production never falls back to a shared or documented development secret.
  if (process.env.NODE_ENV === 'production') return null;
  return process.env.AVCU_WEBHOOK_SECRET_SANDBOX || 'avcu-dev-webhook-secret';
}
