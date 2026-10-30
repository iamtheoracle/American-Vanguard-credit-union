import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalleEchoCall, getCalleEchoCall } from '../server/integrations/calle.js';

const preflight = {
  phoneVerified: true,
  consentActive: true,
  notDoNotCall: true,
  withinCallingWindow: true,
  callerIdApproved: true,
  recordingDisclosureApproved: true,
  retentionApproved: true,
  complianceApproved: true
};

const originalFetch = globalThis.fetch;
const originalDispatch = process.env.ECHO_CALL_DISPATCH_ENABLED;
const originalKey = process.env.CALLE_API_KEY;

test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalDispatch === undefined) delete process.env.ECHO_CALL_DISPATCH_ENABLED;
  else process.env.ECHO_CALL_DISPATCH_ENABLED = originalDispatch;
  if (originalKey === undefined) delete process.env.CALLE_API_KEY;
  else process.env.CALLE_API_KEY = originalKey;
});

test('CALL-E adapter refuses dispatch when the feature gate is off', async () => {
  process.env.ECHO_CALL_DISPATCH_ENABLED = 'false';
  process.env.CALLE_API_KEY = 'test-only-not-a-real-key';
  await assert.rejects(
    createCalleEchoCall({ phone: '+14155550123', eventKey: 'transaction:123:status:posted', preflight }),
    error => error.code === 'echo_dispatch_disabled'
  );
});

test('CALL-E adapter blocks a call when any trusted preflight gate is missing', async () => {
  process.env.ECHO_CALL_DISPATCH_ENABLED = 'true';
  process.env.CALLE_API_KEY = 'test-only-not-a-real-key';
  await assert.rejects(
    createCalleEchoCall({ phone: '+14155550123', eventKey: 'transaction:123:status:posted', preflight: { ...preflight, consentActive: false } }),
    error => error.code === 'echo_preflight_blocked'
  );
});

test('CALL-E adapter rejects malformed E.164 recipients before network access', async () => {
  process.env.ECHO_CALL_DISPATCH_ENABLED = 'true';
  process.env.CALLE_API_KEY = 'test-only-not-a-real-key';
  await assert.rejects(
    createCalleEchoCall({ phone: '4155550123', eventKey: 'transaction:123:status:posted', preflight }),
    error => error.code === 'invalid_recipient'
  );
});

test('CALL-E create uses v2, stable idempotency, and a generic privacy-safe task', async () => {
  process.env.ECHO_CALL_DISPATCH_ENABLED = 'true';
  process.env.CALLE_API_KEY = 'test-only-not-a-real-key';
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ id: 'call_123456', status: 'queued', result_status: 'pending' }), {
      status: 202, headers: { 'Content-Type': 'application/json' }
    });
  };

  const input = { phone: '+14155550123', eventKey: 'transaction:123:status:posted', preflight };
  const first = await createCalleEchoCall(input);
  const second = await createCalleEchoCall(input);

  assert.equal(first.resourceId, 'call_123456');
  assert.equal(captured.url, 'https://api.heycall-e.com/v2/calls');
  assert.equal(captured.options.headers['Idempotency-Key'], 'avcu-echo-' + (await import('node:crypto')).createHash('sha256').update(input.eventKey).digest('hex'));
  assert.equal(captured.body.phone, input.phone);
  assert.equal(captured.body.task.includes('Do not state or imply any transaction amount'), true);
  assert.equal(captured.body.task.includes('transaction:123'), false);
  assert.equal(first.resourceId, second.resourceId);
});

test('CALL-E read recovers an existing call even when new dispatch is disabled', async () => {
  process.env.ECHO_CALL_DISPATCH_ENABLED = 'false';
  process.env.CALLE_API_KEY = 'test-only-not-a-real-key';
  let calledUrl;
  globalThis.fetch = async (url, options) => {
    calledUrl = url;
    assert.equal(options.method, 'GET');
    return new Response(JSON.stringify({
      id: 'call_123456', status: 'completed', call_outcome: 'answered',
      result_status: 'available', result: { outcome: 'person_reached' }, transcript: []
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const call = await getCalleEchoCall('call_123456');
  assert.equal(calledUrl, 'https://api.heycall-e.com/v2/calls/call_123456');
  assert.equal(call.resultStatus, 'available');
});
