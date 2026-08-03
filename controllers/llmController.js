import { getTaskLlmConfig } from '../config/taskLlmConfig.js';
import { getLlmProviderStatus } from '../config/llmProvider.js';
import { httpError } from '../utils/httpError.js';
import { LLM_API_KEY_INVALID, OPENAI_API_KEY_INVALID } from '../services/ai/openAiErrors.js';

const VALIDATION_TIMEOUT_MS = 10_000;

export function getLlmConfig(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.json(getLlmProviderStatus());
}

export async function validateOpenAiKey(req, res, next) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
  res.setHeader('Cache-Control', 'no-store');
  try {
    const config = getTaskLlmConfig('intent');
    const providerName = config.configuredProvider === 'mistral' ? 'Mistral' : 'OpenAI';
    const response = await fetch(config.baseUrl + '/models', {
      headers: { Authorization: 'Bearer ' + config.apiKey },
      signal: controller.signal
    });

    if (response.status === 401 || response.status === 403) {
      throw httpError(
        401,
        providerName + ' rejected this API key. Check the key and try again.',
        config.configuredProvider === 'openai' ? OPENAI_API_KEY_INVALID : LLM_API_KEY_INVALID
      );
    }
    if (!response.ok) throw httpError(502, providerName + ' could not validate the API key right now. Try again.');
    res.json({ valid: true });
  } catch (error) {
    if (error.name === 'AbortError') {
      next(httpError(504, 'LLM provider key validation timed out. Try again.'));
      return;
    }
    next(error);
  } finally {
    clearTimeout(timeout);
  }
}

export const validateLlmKey = validateOpenAiKey;
