import { withCallLog } from '../observability/centralCallLogger.js';
import { getTaskLlmConfig } from '../../config/taskLlmConfig.js';
import { fetchLlmResponse } from '../ai/llmTransport.js';
import { buildIntentPrompt } from '../ai/prompts/intentPrompt.js';

const allowedIntents = new Set(['edit', 'explain', 'build', 'unknown']);
const intentCache = new Map();
const INTENT_CACHE_MS = 30_000;

export async function routeChatIntent(message) {
  const text = String(message || '').trim();
  if (!text) return 'unknown';
  const cached = intentCache.get(text);
  if (cached && Date.now() - cached.createdAt < INTENT_CACHE_MS) return cached.intent;
  const config = getTaskLlmConfig('intent');
  if (config.provider === 'openai' && config.apiKey) {
    for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
      try {
        const intent = await classifyWithSmallModel(text, config);
        rememberIntent(text, intent);
        return intent;
      } catch (error) {
        console.warn('Intent classifier failed', { attempt, message: error.message });
      }
    }
  }
  const intent = fallbackIntent(text);
  rememberIntent(text, intent);
  return intent;
}

function rememberIntent(message, intent) {
  intentCache.set(message, { intent, createdAt: Date.now() });
  if (intentCache.size > 200) intentCache.delete(intentCache.keys().next().value);
}

async function classifyWithSmallModel(message, config) {
  const { model } = config;
  const response = await withCallLog({
    type: 'ai_call', operation: 'intent_classification', provider: 'openai', model,
    metadata: { messageLength: message.length }
  }, () => fetchLlmResponse(config, {
      input: buildIntentPrompt(message)
  }));
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error?.message || 'Intent model request failed');
  }
  const data = await response.json();
  const raw = data.output_text || data.output?.flatMap((item) => item.content || []).map((part) => part.text || '').join('\n') || '';
  const parsed = JSON.parse(String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim());
  if (!allowedIntents.has(parsed.intent)) throw new Error('Intent model returned an unsupported intent');
  return parsed.intent;
}

function fallbackIntent(message) {
  const text = message.toLowerCase();
  const words = new Set(text.match(/[a-z]+/g) || []);
  const contains = (values) => values.some((value) => words.has(value));
  if (contains(['edit', 'modify', 'adjust', 'change', 'make', 'add', 'remove', 'update', 'fix', 'style', 'rename', 'replace', 'resize', 'move', 'toggle'])) return 'edit';
  if (contains(['build', 'create', 'generate', 'regenerate'])) return 'build';
  if (contains(['explain', 'why', 'how', 'what', 'where', 'which']) || text.endsWith('?')) return 'explain';
  return 'unknown';
}
