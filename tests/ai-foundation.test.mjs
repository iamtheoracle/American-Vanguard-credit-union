import test from 'node:test';
import assert from 'node:assert/strict';
import { understandMessage, scoreUnderstanding } from '../server/ai/understanding.js';
import { runUnderstandingBenchmark, evaluatePlatformGates } from '../server/ai/benchmark.js';
import { generateText, modelGatewayStatus } from '../server/ai/gateway.js';
import { rememberMemberFact } from '../server/ai/memory.js';
import { executeAiAction } from '../server/ai/execution.js';

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
