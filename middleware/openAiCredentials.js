import { runWithRequestLlmContext, getRequestLlmApiKey } from '../context/requestLlmContext.js';
import { normalizeLlmQualityMode } from '../config/llmQualityMode.js';
import { getConfiguredLlmProvider, getServerLlmApiKey } from '../config/llmProvider.js';
import { httpError } from '../utils/httpError.js';
import {
  LLM_API_KEY_INVALID,
  LLM_API_KEY_REQUIRED,
  OPENAI_API_KEY_INVALID,
  OPENAI_API_KEY_REQUIRED
} from '../services/ai/openAiErrors.js';

const GENERIC_API_KEY_HEADER = 'x-llm-api-key';
const LEGACY_OPENAI_API_KEY_HEADER = 'x-openai-api-key';
const QUALITY_MODE_HEADER = 'x-llm-quality-mode';
const MAX_API_KEY_LENGTH = 512;

export function withRequestOpenAiCredentials(req, res, next) {
  const rawValue = req.get(GENERIC_API_KEY_HEADER) || req.get(LEGACY_OPENAI_API_KEY_HEADER);
  const llmApiKey = typeof rawValue === 'string' ? rawValue.trim() : '';
  const rawQualityMode = req.get(QUALITY_MODE_HEADER);
  let qualityMode = '';
  try {
    qualityMode = normalizeLlmQualityMode(rawQualityMode, '');
    const provider = getConfiguredLlmProvider();
    runWithRequestLlmContext({ llmApiKey, openAiApiKey: llmApiKey, provider, qualityMode }, next);
  } catch (error) {
    return next(httpError(400, error.message, error.message.includes('provider') ? 'INVALID_LLM_PROVIDER' : 'INVALID_LLM_QUALITY_MODE'));
  }
}

export function requireOpenAiApiKey(req, res, next) {
  const provider = getConfiguredLlmProvider();
  const apiKey = getRequestLlmApiKey() || getServerLlmApiKey(provider);
  const requiredCode = provider === 'openai' ? OPENAI_API_KEY_REQUIRED : LLM_API_KEY_REQUIRED;
  const invalidCode = provider === 'openai' ? OPENAI_API_KEY_INVALID : LLM_API_KEY_INVALID;
  if (!apiKey) {
    return next(httpError(
      401,
      'Add an API key for ' + providerLabel(provider) + ' in Settings or configure an allowed server key.',
      requiredCode
    ));
  }
  if (apiKey.length < 20 || apiKey.length > MAX_API_KEY_LENGTH || /\s/.test(apiKey)) {
    return next(httpError(401, 'The ' + providerLabel(provider) + ' API key format is invalid.', invalidCode));
  }
  next();
}

export const withRequestLlmCredentials = withRequestOpenAiCredentials;
export const requireLlmApiKey = requireOpenAiApiKey;

function providerLabel(provider) {
  return provider === 'mistral' ? 'Mistral' : 'OpenAI';
}
