import { setTimeout as delay } from 'node:timers/promises';

const PROVIDERS = {
  openrouter: { kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', modelEnv: 'OPENROUTER_MODEL', defaultModel: 'openai/gpt-4o-mini' },
  groq: { kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', modelEnv: 'GROQ_MODEL', defaultModel: 'llama-3.3-70b-versatile' },
  openai: { kind: 'openai', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', modelEnv: 'OPENAI_MODEL', defaultModel: 'gpt-4o-mini' },
  compat: { kind: 'openai', baseUrl: null, keyEnv: 'AI_API_KEY', modelEnv: 'AI_MODEL', defaultModel: 'gpt-4o-mini' },
  anthropic: { kind: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY', modelEnv: 'ANTHROPIC_MODEL', defaultModel: 'claude-3-5-haiku-latest' },
  gemini: { kind: 'gemini', keyEnv: 'GEMINI_API_KEY', modelEnv: 'GEMINI_MODEL', defaultModel: 'gemini-2.5-flash' }
};

const circuits = new Map();
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 30_000;

export class ModelGatewayError extends Error {
  constructor(message, code, { retryable = false, provider = null } = {}) {
    super(message);
    this.name = 'ModelGatewayError';
    this.code = code;
    this.retryable = retryable;
    this.provider = provider;
  }
}

function circuitOpen(provider) {
  const state = circuits.get(provider);
  if (!state || state.failures < CIRCUIT_THRESHOLD) return false;
  if (Date.now() - state.openedAt >= CIRCUIT_COOLDOWN_MS) return false;
  return true;
}

function recordSuccess(provider) { circuits.delete(provider); }
function recordFailure(provider) {
  const state = circuits.get(provider) || { failures: 0, openedAt: 0 };
  state.failures += 1;
  if (state.failures >= CIRCUIT_THRESHOLD) state.openedAt = Date.now();
  circuits.set(provider, state);
}

function providerConfig(name) {
  const config = PROVIDERS[name];
  if (!config) throw new ModelGatewayError('Unknown AI provider', 'unknown_provider', { provider: name });
  const key = process.env[config.keyEnv];
  if (!key) throw new ModelGatewayError('AI provider credentials are not configured', 'provider_not_configured', { provider: name });
  return { ...config, baseUrl: config.baseUrl || process.env.AI_BASE_URL?.replace(/\/$/, ''), key, model: process.env[config.modelEnv] || config.defaultModel };
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new ModelGatewayError('AI provider request failed', retryable ? 'provider_unavailable' : 'provider_rejected', { retryable });
    }
    if (!payload || typeof payload !== 'object') throw new ModelGatewayError('AI provider returned malformed data', 'provider_invalid_response');
    return payload;
  } catch (error) {
    if (error instanceof ModelGatewayError) throw error;
    throw new ModelGatewayError(error.name === 'AbortError' ? 'AI provider timed out' : 'AI provider network failure',
      'provider_network_error', { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

async function completeOpenAiCompatible(config, messages, options) {
  const payload = await fetchJson(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, messages, temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 1200 })
  }, options.timeoutMs);
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new ModelGatewayError('AI provider returned no text', 'provider_empty_response');
  return text.trim();
}

async function completeAnthropic(config, messages, options) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const conversation = messages.filter(m => m.role !== 'system');
  const payload = await fetchJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': config.key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, max_tokens: options.maxTokens ?? 1200, system,
      messages: conversation.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })) })
  }, options.timeoutMs);
  const text = Array.isArray(payload.content) ? payload.content.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
  if (!text.trim()) throw new ModelGatewayError('AI provider returned no text', 'provider_empty_response');
  return text.trim();
}

async function completeGemini(config, messages, options) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const contents = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content) }]
  }));
  const payload = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': config.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents,
      generationConfig: { temperature: options.temperature ?? 0.2, maxOutputTokens: options.maxTokens ?? 1200 } })
  }, options.timeoutMs);
  const text = payload?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
  if (typeof text !== 'string' || !text.trim()) throw new ModelGatewayError('AI provider returned no text', 'provider_empty_response');
  return text.trim();
}

async function callProvider(name, messages, options) {
  if (circuitOpen(name)) throw new ModelGatewayError('Provider circuit is open', 'provider_circuit_open', { retryable: true, provider: name });
  const config = providerConfig(name);
  try {
    const text = config.kind === 'anthropic' ? await completeAnthropic(config, messages, options)
      : config.kind === 'gemini' ? await completeGemini(config, messages, options)
      : await completeOpenAiCompatible(config, messages, options);
    recordSuccess(name);
    return { provider: name, model: config.model, text };
  } catch (error) {
    if (error.retryable) recordFailure(name);
    if (error instanceof ModelGatewayError) { error.provider = name; throw error; }
    throw new ModelGatewayError('Provider execution failed', 'provider_execution_failed', { retryable: true, provider: name });
  }
}

/** Provider-independent text completion with ordered, bounded failover. */
export async function generateText({ messages, provider, fallbacks, timeoutMs = 10_000, maxTokens, temperature } = {}) {
  if (!Array.isArray(messages) || !messages.length || messages.some(m =>
    !m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) {
    throw new ModelGatewayError('Valid chat messages are required', 'invalid_messages');
  }
  const primary = provider || process.env.AVCU_AI_PROVIDER || 'openrouter';
  const fallbackList = Array.isArray(fallbacks) ? fallbacks
    : String(process.env.AVCU_AI_FALLBACKS || 'groq,gemini,anthropic').split(',').map(s => s.trim()).filter(Boolean);
  const order = [...new Set([primary, ...fallbackList.filter(p => p !== primary)])].slice(0, 4);
  const errors = [];
  for (const name of order) {
    try {
      return await callProvider(name, messages, { timeoutMs, maxTokens, temperature });
    } catch (error) {
      errors.push({ provider: name, code: error.code || 'provider_error', retryable: Boolean(error.retryable) });
      if (!error.retryable) continue;
      await delay(25);
    }
  }
  throw new ModelGatewayError('All configured AI providers failed', 'all_providers_failed', { retryable: true,
    provider: errors.map(e => e.provider).join(',') });
}

/** Safe operational snapshot: never exposes secrets, prompts, or user data. */
export function modelGatewayStatus() {
  return Object.entries(PROVIDERS).map(([name, config]) => ({
    provider: name,
    configured: Boolean(process.env[config.keyEnv]),
    circuit: circuits.get(name)?.failures >= CIRCUIT_THRESHOLD ? 'open-or-cooling' : 'closed'
  }));
}

export function resetGatewayCircuitsForTests() { circuits.clear(); }


function normalizeToolArguments(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || raw.length > 16_000) throw new ModelGatewayError('Provider returned invalid tool arguments', 'provider_invalid_tool_arguments');
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    throw new ModelGatewayError('Provider returned malformed tool arguments', 'provider_invalid_tool_arguments');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ModelGatewayError('Provider tool arguments must be an object', 'provider_invalid_tool_arguments');
  }
  return parsed;
}

function openAiToolRequest(tools) {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: true
    }
  }));
}

/**
 * Provider-native function calling. Only structured calls are returned;
 * callers must still validate every name and argument against their own
 * server-side allowlist before execution.
 */
async function callProviderWithTools(name, messages, tools, options) {
  if (circuitOpen(name)) throw new ModelGatewayError('Provider circuit is open', 'provider_circuit_open', { retryable: true, provider: name });
  const config = providerConfig(name);
  try {
    let result;
    if (config.kind === 'anthropic') {
      const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\\n');
      const conversation = messages.filter(m => m.role !== 'system');
      const payload = await fetchJson('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': config.key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model, max_tokens: options.maxTokens ?? 1200, system,
          messages: conversation.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
          tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }))
        })
      }, options.timeoutMs);
      const blocks = Array.isArray(payload.content) ? payload.content : [];
      result = {
        text: blocks.filter(x => x.type === 'text').map(x => x.text || '').join('\\n').trim(),
        toolCalls: blocks.filter(x => x.type === 'tool_use').map(x => ({
          id: x.id, name: x.name, input: normalizeToolArguments(x.input)
        }))
      };
    } else if (config.kind === 'gemini') {
      const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\\n');
      const contents = messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content) }]
      }));
      const payload = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': config.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] }, contents,
          tools: [{ functionDeclarations: tools.map(tool => ({
            name: tool.name, description: tool.description, parameters: tool.parameters
          })) }],
          toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
          generationConfig: { temperature: options.temperature ?? 0.2, maxOutputTokens: options.maxTokens ?? 1200 }
        })
      }, options.timeoutMs);
      const parts = payload?.candidates?.[0]?.content?.parts || [];
      result = {
        text: parts.filter(part => typeof part.text === 'string').map(part => part.text).join('\\n').trim(),
        toolCalls: parts.filter(part => part.functionCall).map((part, index) => ({
          id: `gemini-${index}`, name: part.functionCall.name,
          input: normalizeToolArguments(part.functionCall.args)
        }))
      };
    } else {
      const payload = await fetchJson(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model, messages,
          tools: openAiToolRequest(tools), tool_choice: 'auto',
          temperature: options.temperature ?? 0.2, max_tokens: options.maxTokens ?? 1200
        })
      }, options.timeoutMs);
      const message = payload?.choices?.[0]?.message || {};
      result = {
        text: typeof message.content === 'string' ? message.content.trim() : '',
        toolCalls: (Array.isArray(message.tool_calls) ? message.tool_calls : []).map(call => ({
          id: call.id, name: call.function?.name,
          input: normalizeToolArguments(call.function?.arguments)
        }))
      };
    }
    if (!result.text && !result.toolCalls.length) throw new ModelGatewayError('AI provider returned no content or tool calls', 'provider_empty_response');
    recordSuccess(name);
    return { provider: name, model: config.model, ...result };
  } catch (error) {
    if (error.retryable) recordFailure(name);
    if (error instanceof ModelGatewayError) { error.provider = name; throw error; }
    throw new ModelGatewayError('Provider tool-call execution failed', 'provider_tool_call_failed', { retryable: true, provider: name });
  }
}

export async function generateWithTools({ messages, tools, provider, fallbacks, timeoutMs = 10_000, maxTokens, temperature } = {}) {
  if (!Array.isArray(messages) || !messages.length || messages.some(m =>
    !m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) {
    throw new ModelGatewayError('Valid chat messages are required', 'invalid_messages');
  }
  if (!Array.isArray(tools) || !tools.length || tools.length > 32 ||
      tools.some(tool => !tool || !/^[a-z][a-z0-9_]{1,63}$/.test(tool.name || '') ||
        typeof tool.description !== 'string' || !tool.parameters || tool.parameters.type !== 'object')) {
    throw new ModelGatewayError('Valid function tool definitions are required', 'invalid_tools');
  }
  const primary = provider || process.env.AVCU_AI_PROVIDER || 'openrouter';
  const fallbackList = Array.isArray(fallbacks) ? fallbacks
    : String(process.env.AVCU_AI_FALLBACKS || 'groq,gemini,anthropic').split(',').map(s => s.trim()).filter(Boolean);
  const order = [...new Set([primary, ...fallbackList.filter(p => p !== primary)])].slice(0, 4);
  for (const name of order) {
    try {
      return await callProviderWithTools(name, messages, tools, { timeoutMs, maxTokens, temperature });
    } catch (error) {
      if (!error.retryable) continue;
      await delay(25);
    }
  }
  throw new ModelGatewayError('All configured AI providers failed', 'all_providers_failed', { retryable: true, provider: order.join(',') });
}
