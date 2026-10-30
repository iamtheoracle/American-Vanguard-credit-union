import test from 'node:test';
import assert from 'node:assert/strict';
import { understandMessage, scoreUnderstanding } from '../server/ai/understanding.js';
import { runUnderstandingBenchmark, evaluatePlatformGates, runPlatformBenchmark } from '../server/ai/benchmark.js';
import { generateText, generateWithTools, streamText, modelGatewayStatus } from '../server/ai/gateway.js';
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
  const nullMetric = runPlatformBenchmark({ platformMetrics: {
    unauthorizedExecutionCount: null, crossMemberMemoryLeakCount: 0, duplicateSideEffectCount: 0,
    promptInjectionEscapeCount: 0, sensitiveDisclosureCount: 0, humanHandoffFailureCount: 0,
    understandingScore: 1, providerFallbackSuccessRate: 1, p95LatencyMs: 1000
  } });
  assert.equal(nullMetric.passed, false);
  assert.ok(nullMetric.missingMetrics.includes('unauthorizedExecutionCount'));
  const complete = runPlatformBenchmark({ platformMetrics: {
    unauthorizedExecutionCount: 0, crossMemberMemoryLeakCount: 0, duplicateSideEffectCount: 0,
    promptInjectionEscapeCount: 0, sensitiveDisclosureCount: 0, humanHandoffFailureCount: 0,
    understandingScore: 1, providerFallbackSuccessRate: 1, p95LatencyMs: 1000
  } });
  assert.equal(complete.passed, true);
});

test('ordinary greetings do not trigger unnecessary clarification', () => {
  assert.equal(understandMessage('Hi, can you help me?').clarificationRequired, false);
  assert.equal(understandMessage('Please connect me to a human representative').clarificationRequired, false);
});


test('gateway requests provider-native structured function calls and normalizes arguments', async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.OPENROUTER_API_KEY;
  try {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    let requestBody;
    globalThis.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: {
        content: 'Preparing your request.',
        tool_calls: [{ id: 'call_123', type: 'function', function: {
          name: 'create_support_case', arguments: '{"subject":"Need a person","body":"Please call me"}'
        } }]
      } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const result = await generateWithTools({
      provider: 'openrouter', fallbacks: [],
      messages: [{ role: 'user', content: 'Connect me to support' }],
      tools: [{ name: 'create_support_case', description: 'Create a support case', parameters: {
        type: 'object', properties: { subject: { type: 'string' } }, required: ['subject'], additionalProperties: false
      } }]
    });
    assert.equal(requestBody.tool_choice, 'auto');
    assert.equal(requestBody.tools[0].function.name, 'create_support_case');
    assert.equal(result.toolCalls[0].name, 'create_support_case');
    assert.deepEqual(result.toolCalls[0].input, { subject: 'Need a person', body: 'Please call me' });
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
  }
});

test('gateway rejects malformed provider tool arguments instead of passing them to execution', async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.OPENROUTER_API_KEY;
  try {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: {
      tool_calls: [{ id: 'call_bad', function: { name: 'create_support_case', arguments: 'not-json' } }]
    } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(generateWithTools({
      provider: 'openrouter', fallbacks: [],
      messages: [{ role: 'user', content: 'Do something' }],
      tools: [{ name: 'create_support_case', description: 'Create a support case', parameters: { type: 'object' } }]
    }), error => error.code === 'provider_invalid_tool_arguments');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
  }
});


test('gateway streams provider-native text deltas over SSE', async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.OPENAI_API_KEY;
  try {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.stream, true);
      return new Response([
        'data: {"choices":[{"delta":{"content":"Hello "}}]}\\n\\n',
        'data: {"choices":[{"delta":{"content":"member."}}]}\\n\\n',
        'data: [DONE]\\n\\n'
      ].join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const chunks = [];
    for await (const chunk of streamText({
      provider: 'openai', fallbacks: [],
      messages: [{ role: 'user', content: 'Say hello' }]
    })) chunks.push(chunk.delta);
    assert.deepEqual(chunks, ['Hello ', 'member.']);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  }
});

test('streaming fallback occurs only before the first token', async () => {
  const oldFetch = globalThis.fetch;
  const oldOpenAi = process.env.OPENAI_API_KEY;
  const oldGroq = process.env.GROQ_API_KEY;
  try {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.GROQ_API_KEY = 'test-groq-key';
    let calls = 0;
    globalThis.fetch = async url => {
      calls += 1;
      if (String(url).includes('api.openai.com')) return new Response('unavailable', { status: 503 });
      return new Response('data: {"choices":[{"delta":{"content":"fallback"}}]}\\n\\ndata: [DONE]\\n\\n', {
        status: 200, headers: { 'Content-Type': 'text/event-stream' }
      });
    };
    const chunks = [];
    for await (const chunk of streamText({
      provider: 'openai', fallbacks: ['groq'],
      messages: [{ role: 'user', content: 'Say fallback' }]
    })) chunks.push(chunk.delta);
    assert.deepEqual(chunks, ['fallback']);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldOpenAi === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAi;
    if (oldGroq === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = oldGroq;
  }
});


test('Anthropic native tool-use blocks normalize into validated tool-call records', async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.tools[0].name, 'create_support_case');
      return new Response(JSON.stringify({ content: [
        { type: 'text', text: 'I can connect you.' },
        { type: 'tool_use', id: 'toolu_123', name: 'create_support_case', input: { subject: 'Member assistance' } }
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const result = await generateWithTools({
      provider: 'anthropic', fallbacks: [],
      messages: [{ role: 'user', content: 'Connect me to support' }],
      tools: [{ name: 'create_support_case', description: 'Create a case', parameters: { type: 'object', properties: {}, required: [] } }]
    });
    assert.equal(result.toolCalls[0].id, 'toolu_123');
    assert.deepEqual(result.toolCalls[0].input, { subject: 'Member assistance' });
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldKey;
  }
});

test('Gemini function declarations use Gemini schema types and normalize functionCall parts', async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.tools[0].functionDeclarations[0].parameters.type, 'OBJECT');
      assert.equal(request.tools[0].functionDeclarations[0].parameters.properties.subject.type, 'STRING');
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [
        { functionCall: { name: 'create_support_case', args: { subject: 'Member assistance' } } }
      ] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const result = await generateWithTools({
      provider: 'gemini', fallbacks: [],
      messages: [{ role: 'user', content: 'Connect me to support' }],
      tools: [{ name: 'create_support_case', description: 'Create a case', parameters: {
        type: 'object', properties: { subject: { type: 'string', minLength: 3 } },
        required: ['subject'], additionalProperties: false
      } }]
    });
    assert.equal(result.toolCalls[0].name, 'create_support_case');
    assert.deepEqual(result.toolCalls[0].input, { subject: 'Member assistance' });
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
  }
});
