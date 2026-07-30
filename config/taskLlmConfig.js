import { LLM_PROFILES, getLlmProfile } from './llmProfiles.js';
import { getRequestLlmQualityMode, getRequestOpenAiApiKey } from '../context/requestLlmContext.js';
import { normalizeLlmQualityMode } from './llmQualityMode.js';
import { httpError } from '../utils/httpError.js';
import { OPENAI_API_KEY_REQUIRED } from '../services/ai/openAiErrors.js';

export function getTaskLlmConfig(task) {
  const qualityMode = normalizeLlmQualityMode(getRequestLlmQualityMode(), 'standard');
  const profile = getLlmProfile(task, qualityMode);
  if (!profile) throw new Error('Unknown LLM task: ' + task + '. Expected: ' + Object.keys(LLM_PROFILES).join(', '));
  const requestApiKey = getRequestOpenAiApiKey();
  const provider = requestApiKey ? 'openai' : 'mock';

  return {
    task,
    qualityMode,
    description: profile.description,
    provider,
    apiKey: requestApiKey,
    baseUrl: String(process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: profile.model,
    temperature: profile.temperature,
    maxOutputTokens: profile.maxOutputTokens,
    timeoutMs: profile.timeoutMs,
    maxRetries: profile.maxRetries,
    imageDetail: process.env.LLM_VISION_IMAGE_DETAIL || process.env.LLM_IMAGE_DETAIL || process.env.OPENAI_IMAGE_DETAIL || 'auto'
  };
}

export function listTaskLlmConfigs() {
  return Object.keys(LLM_PROFILES).map(getTaskLlmConfig);
}

export function requireTaskLlmApiKey(config) {
  if (config.provider === 'openai' && !config.apiKey) {
    throw httpError(
      401,
      'Add your OpenAI API key in Settings to use AI features.',
      OPENAI_API_KEY_REQUIRED
    );
  }
  return config.apiKey;
}

