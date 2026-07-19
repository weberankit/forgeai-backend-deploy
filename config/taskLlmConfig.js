import { LLM_PROFILES } from './llmProfiles.js';

const supportedProviders = new Set(['mock', 'openai']);

export function getTaskLlmConfig(task) {
  const profile = LLM_PROFILES[task];
  if (!profile) throw new Error('Unknown LLM task: ' + task + '. Expected: ' + Object.keys(LLM_PROFILES).join(', '));
  const provider = String(process.env.LLM_PROVIDER || process.env.AI_PROVIDER || profile.provider).toLowerCase();
  if (!supportedProviders.has(provider)) throw new Error('Unsupported provider for ' + task + ': ' + provider);

  return {
    task,
    description: profile.description,
    provider,
    apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
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
  if (config.provider === 'openai' && !config.apiKey) throw new Error('LLM API key required for task: ' + config.task);
  return config.apiKey;
}

