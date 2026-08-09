import { requireTaskLlmApiKey } from '../../config/taskLlmConfig.js';
import { llmCredentialError } from './openAiErrors.js';

let mistralQueue = Promise.resolve();

export async function fetchLlmResponse(config, body) {
  requireTaskLlmApiKey(config);
  const provider = config.provider;
  const { endpoint, payload } = providerRequest(provider, config, body);
  const execute = () => fetchWithRateLimitRetry(config, endpoint, payload);
  return provider === 'mistral' ? withMistralTurn(execute) : execute();
}

async function fetchWithRateLimitRetry(config, endpoint, payload) {
  const retries = Math.max(0, Math.min(6, Number(process.env.LLM_RATE_LIMIT_RETRIES ?? 3)));
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetch(config.baseUrl + endpoint, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + config.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (response.status === 401 || response.status === 403) throw llmCredentialError(config.provider);
      if (response.status !== 429 || attempt === retries) return response;
      await response.body?.cancel().catch(() => {});
      await delay(rateLimitDelayMs(response, attempt));
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('LLM request timed out after ' + config.timeoutMs + 'ms.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error('LLM rate-limit retries were exhausted.');
}

async function withMistralTurn(callback) {
  const previous = mistralQueue.catch(() => {});
  let release;
  mistralQueue = new Promise((resolve) => { release = resolve; });
  try {
    await previous;
    return await callback();
  } finally {
    release();
  }
}

function rateLimitDelayMs(response, attempt) {
  const retryAfter = String(response.headers.get('retry-after') || '').trim();
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, Math.max(0, seconds * 1000));
  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) return Math.min(60_000, Math.max(0, dateMs - Date.now()));
  const base = Math.max(1, Number(process.env.LLM_RATE_LIMIT_BACKOFF_MS || 5000));
  return Math.min(60_000, base * (2 ** attempt));
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function readLlmResponse(response, config) {
  const data = await response.json();
  return { text: extractLlmText(data, config.provider), usage: data.usage, raw: data };
}

export async function readLlmStream(response, config, onToken, onUsage) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        const event = JSON.parse(payload);
        const delta = config.provider === 'mistral'
          ? mistralContentText(event.choices?.[0]?.delta?.content)
          : event.type === 'response.output_text.delta' ? String(event.delta || '') : '';
        if (delta) {
          output += delta;
          onToken?.(delta);
        }
        if (event.usage) onUsage?.(event.usage);
        if (config.provider === 'openai' && event.type === 'response.completed') {
          onUsage?.(event.response?.usage);
          const finalText = extractLlmText(event.response || {}, 'openai');
          if (finalText && finalText.length > output.length) {
            const tail = finalText.slice(output.length);
            output = finalText;
            onToken?.(tail);
          }
        }
      }
    }
  }
  return output;
}

export function extractLlmText(data, provider = 'openai') {
  if (provider === 'mistral') return mistralContentText(data?.choices?.[0]?.message?.content);
  return data?.output_text || data?.output?.flatMap((item) => item.content || []).map((part) => part.text || '').join('\n') || '';
}

function providerRequest(provider, config, body = {}) {
  if (provider === 'mistral') {
    return {
      endpoint: '/chat/completions',
      payload: withoutUndefined({
        model: config.model,
        messages: toMistralMessages(body.input),
        temperature: config.temperature,
        max_tokens: config.maxOutputTokens,
        stream: Boolean(body.stream),
        stream_options: body.stream ? { include_usage: true } : undefined,
        response_format: body.jsonMode === false ? undefined : { type: 'json_object' }
      })
    };
  }
  return {
    endpoint: '/responses',
    payload: withoutUndefined({
      model: config.model,
      temperature: config.temperature,
      max_output_tokens: config.maxOutputTokens,
      ...body,
      store: false
    })
  };
}

function toMistralMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [{ role: 'user', content: String(input || '') }];
  return input.map((message) => ({
    role: message.role || 'user',
    content: Array.isArray(message.content)
      ? message.content.map(toMistralContent).filter(Boolean)
      : String(message.content || '')
  }));
}

function toMistralContent(part) {
  if (part?.type === 'input_text' || part?.type === 'text') return { type: 'text', text: String(part.text || '') };
  if (part?.type === 'input_image' || part?.type === 'image_url') return { type: 'image_url', image_url: part.image_url };
  return null;
}

function mistralContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => typeof part === 'string' ? part : part?.text || '').join('');
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
