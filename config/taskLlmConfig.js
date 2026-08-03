import { LLM_PROFILES, getLlmProfile } from './llmProfiles.js';
import { getRequestLlmApiKey, getRequestLlmQualityMode } from '../context/requestLlmContext.js';
import { normalizeLlmQualityMode } from './llmQualityMode.js';
import { httpError } from '../utils/httpError.js';
import { LLM_API_KEY_REQUIRED, OPENAI_API_KEY_REQUIRED } from '../services/ai/openAiErrors.js';
import { getConfiguredLlmProvider, getLlmBaseUrl, getServerLlmApiKey } from './llmProvider.js';

export function getTaskLlmConfig(task, context = {}) {
  const qualityMode = normalizeLlmQualityMode(getRequestLlmQualityMode(), 'standard');
  const configuredProvider = getConfiguredLlmProvider();
  const profile = getLlmProfile(task, qualityMode, context, configuredProvider);
  if (!profile) throw new Error('Unknown LLM task: ' + task + '. Expected: ' + Object.keys(LLM_PROFILES).join(', '));
  const requestApiKey = getRequestLlmApiKey();
  const serverApiKey = getServerLlmApiKey(configuredProvider);
  const apiKey = requestApiKey || serverApiKey;
  const provider = apiKey ? configuredProvider : 'mock';

  return {
    task,
    qualityMode,
    phase: context.phase,
    agentName: context.agentName,
    description: profile.description,
    provider,
    configuredProvider,
    credentialSource: requestApiKey ? 'request' : serverApiKey ? 'server' : 'none',
    apiKey,
    baseUrl: getLlmBaseUrl(configuredProvider),
    model: profile.model,
    temperature: profile.temperature,
    maxOutputTokens: profile.maxOutputTokens,
    timeoutMs: profile.timeoutMs,
    maxRetries: profile.maxRetries,
    imageDetail: process.env.LLM_VISION_IMAGE_DETAIL || process.env.LLM_IMAGE_DETAIL || process.env.OPENAI_IMAGE_DETAIL || 'auto'
  };
}

export function listTaskLlmConfigs() {
  return Object.keys(LLM_PROFILES).map((task) => getTaskLlmConfig(task));
}

export function requireTaskLlmApiKey(config) {
  if (config.provider !== 'mock' && !config.apiKey) {
    throw httpError(
      401,
      'Add an API key for the configured LLM provider to use AI features.',
      config.configuredProvider === 'openai' ? OPENAI_API_KEY_REQUIRED : LLM_API_KEY_REQUIRED
    );
  }
  return config.apiKey;
}
