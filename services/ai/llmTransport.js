import { requireTaskLlmApiKey } from '../../config/taskLlmConfig.js';
import { llmCredentialError } from './openAiErrors.js';

export async function fetchLlmResponse(config, body) {
  requireTaskLlmApiKey(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const provider = config.provider;
  const { endpoint, payload } = providerRequest(provider, config, body);
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
    if (response.status === 401 || response.status === 403) throw llmCredentialError(provider);
    return response;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('LLM request timed out after ' + config.timeoutMs + 'ms.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

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
