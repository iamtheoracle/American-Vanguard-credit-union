import test from 'node:test';
import assert from 'node:assert/strict';
import { understandMessage, scoreUnderstanding } from '../server/ai/understanding.js';
import { runUnderstandingBenchmark, evaluatePlatformGates, runPlatformBenchmark } from '../server/ai/benchmark.js';
import { generateText, modelGatewayStatus } from '../server/ai/gateway.js';
import { rememberMemberFact } from '../server/ai/memory.js';
import { executeAiAction } from '../server/ai/execution.js';
import { transferRequiresApproval } from '../server/services-member.js';

test('understanding detects ambiguous high-risk requests and asks clarification', () => {
  const result = understandMessage('Move $500 for me');
  assert.equal(result.intent, 'transfer_request');
  assert.equal(result.risk, 'high');
  assert.equal(result.clarificationRequired, true);
});

test('understanding treats negated action as requiring confirmation', () => {
  const result = understandMessage('Do not transfer the money');
  assert.equal(result.negated, true);
  assert.equal(result.clarificationRequired, true);
});

test('understanding benchmark emits component metrics', () => {
  const result = runUnderstandingBenchmark();
  assert.equal(result.caseCount, 7);
  assert.ok(result.metrics.intentAccuracy >= 0);
  assert.ok(result.metrics.riskAccuracy >= 0);
});

test('platform gates fail closed for any critical safety failure', () => {
  const metrics = {
    unauthorizedExecutionCount: 0, crossMemberMemoryLeakCount: 0, duplicateSideEffectCount: 0,
    promptInjectionEscapeCount: 0, sensitiveDisclosureCount: 0, humanHandoffFailureCount: 0,
    understandingScore: 0.9, providerFallbackSuccessRate: 0.99, p95LatencyMs: 1200
  };
  assert.equal(evaluatePlatformGates(metrics).passed, true);
  assert.equal(evaluatePlatformGates({ ...metrics, sensitiveDisclosureCount: 1 }).passed, false);
});

test('gateway rejects invalid messages before any provider call', async () => {
  await assert.rejects(generateText({ messages: [{ role: 'system', content: 3 }], provider: 'openai' }),
    error => error.code === 'invalid_messages');
});

test('gateway status reports configuration without exposing credentials', () => {
  const status = modelGatewayStatus();
  assert.ok(status.every(item => !Object.hasOwn(item, 'key') && !Object.hasOwn(item, 'secret')));
});

test('memory requires explicit user confirmation and blocks secrets', async () => {
  await assert.rejects(rememberMemberFact({ memberId: '00000000-0000-0000-0000-000000000001', fact: 'Prefers short answers', confirmed: false }),
    error => error.code === 'memory_consent_required');
  await assert.rejects(rememberMemberFact({ memberId: '00000000-0000-0000-0000-000000000001', fact: 'My password is secret', confirmed: true }),
    error => error.code === 'memory_restricted_content');
});

test('execution broker rejects unlisted actions and missing authentication before database use', async () => {
  await assert.rejects(executeAiAction({ member: null, action: 'account.read', idempotencyKey: 'request-key-1234', request: {}, execute: async () => ({}) }),
    error => error.code === 'ai_auth_required');
  await assert.rejects(executeAiAction({ member: { id: 'x', status: 'verified' }, action: 'system.shell', idempotencyKey: 'request-key-1234', request: {}, execute: async () => ({}) }),
    error => error.code === 'ai_action_not_allowed');
});

test('all AI-originated transfers require approval, even below the normal threshold', () => {
  assert.equal(transferRequiresApproval({ amountCents: 100, aiContext: true }), true);
  assert.equal(transferRequiresApproval({ amountCents: 250000, aiContext: false }), false);
  assert.equal(transferRequiresApproval({ amountCents: 250001, aiContext: false }), true);
});

test('provider gateway falls back after a retryable provider outage', async () => {
  const oldFetch = globalThis.fetch;
  const oldOpenRouter = process.env.OPENROUTER_API_KEY;
  const oldGroq = process.env.GROQ_API_KEY;
  try {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.GROQ_API_KEY = 'test-groq-key';
    let count = 0;
    globalThis.fetch = async (url) => {
      count += 1;
      if (String(url).includes('openrouter')) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Fallback response' } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    };
    const result = await generateText({
      provider: 'openrouter', fallbacks: ['groq'],
      messages: [{ role: 'user', content: 'Hello' }]
    });
    assert.equal(result.provider, 'groq');
    assert.equal(result.text, 'Fallback response');
    assert.equal(count, 2);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldOpenRouter;
    if (oldGroq === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = oldGroq;
  }
});

test('full-platform benchmark requires every real control metric and fails closed when missing', () => {
  const missing = runPlatformBenchmark({ platformMetrics: {} });
  assert.equal(missing.passed, false);
  assert.ok(missing.missingMetrics.length > 0);
  const complete = runPlatformBenchmark({ platformMetrics: {
    unauthorizedExecutionCount: 0, crossMemberMemoryLeakCount: 0, duplicateSideEffectCount: 0,
    promptInjectionEscapeCount: 0, sensitiveDisclosureCount: 0, humanHandoffFailureCount: 0,
    understandingScore: 1, providerFallbackSuccessRate: 1, p95LatencyMs: 1000
  } });
  assert.equal(complete.passed, true);
});
