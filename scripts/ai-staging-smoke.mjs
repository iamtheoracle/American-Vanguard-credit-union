import { performance } from 'node:perf_hooks';
import { generateWithTools, streamText } from '../server/ai/gateway.js';
import { activeProvider } from '../server/ai/index.js';

if (process.env.NODE_ENV !== 'staging' || process.env.AVCU_STAGING_APPROVED !== 'true') {
  throw new Error('Refusing live-provider smoke tests: set NODE_ENV=staging and AVCU_STAGING_APPROVED=true explicitly.');
}

const provider = activeProvider();
if (provider === 'sandbox' || provider === 'failing') {
  throw new Error('A real AI provider must be configured for staging smoke tests.');
}

const started = performance.now();
const tools = [{
  name: 'staging_health_check',
  description: 'Return a harmless staging validation marker. This tool is not executed.',
  parameters: {
    type: 'object',
    properties: { marker: { type: 'string' } },
    required: ['marker'],
    additionalProperties: false
  }
}];

const toolResult = await generateWithTools({
  provider,
  messages: [
    { role: 'system', content: 'This is a provider integration test. Call staging_health_check exactly once with marker set to AVCU_STAGING_OK. Do not answer in prose.' },
    { role: 'user', content: 'Run the harmless staging health check.' }
  ],
  tools,
  timeoutMs: 20_000,
  maxTokens: 200
});

if (toolResult.toolCalls.length !== 1 ||
    toolResult.toolCalls[0].name !== 'staging_health_check' ||
    toolResult.toolCalls[0].input?.marker !== 'AVCU_STAGING_OK') {
  throw new Error('Provider native function-calling smoke test failed.');
}

let streamedText = '';
let firstTokenMs = null;
for await (const chunk of streamText({
  provider,
  messages: [
    { role: 'system', content: 'Reply with a short harmless staging confirmation. Do not claim to access member or banking data.' },
    { role: 'user', content: 'Say AVCU staging stream is connected.' }
  ],
  timeoutMs: 20_000,
  maxTokens: 100
})) {
  if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - started);
  streamedText += chunk.delta;
}
if (!streamedText.trim()) throw new Error('Provider streaming smoke test returned no text.');

process.stdout.write(JSON.stringify({
  passed: true,
  provider: toolResult.provider,
  model: toolResult.model,
  toolCallVerified: true,
  streamVerified: true,
  firstTokenMs,
  totalDurationMs: Math.round(performance.now() - started)
}, null, 2) + '\\n');
