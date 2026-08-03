const SUPPORTED_LLM_PROVIDERS = new Set(['openai', 'mistral']);

export function normalizeLlmProvider(value, fallback = 'openai') {
  const provider = String(value || fallback).trim().toLowerCase();
  if (!SUPPORTED_LLM_PROVIDERS.has(provider)) {
    throw new Error('Unsupported LLM provider: ' + provider + '. Expected openai or mistral.');
  }
  return provider;
}

export function getConfiguredLlmProvider() {
  return normalizeLlmProvider(process.env.LLM_PROVIDER, 'openai');
}

export function serverLlmKeyEnabled() {
  return process.env.ALLOW_SERVER_LLM_KEY === 'true' && Boolean(getServerLlmApiKey());
}

export function getServerLlmApiKey(provider = getConfiguredLlmProvider()) {
  if (process.env.ALLOW_SERVER_LLM_KEY !== 'true') return '';
  const providerKey = provider === 'mistral' ? process.env.MISTRAL_API_KEY : process.env.OPENAI_API_KEY;
  return String(process.env.LLM_API_KEY || providerKey || '').trim();
}

export function getLlmBaseUrl(provider = getConfiguredLlmProvider()) {
  const providerOverride = provider === 'mistral' ? process.env.MISTRAL_BASE_URL : process.env.OPENAI_BASE_URL;
  const fallback = provider === 'mistral' ? 'https://api.mistral.ai/v1' : 'https://api.openai.com/v1';
  return String(process.env.LLM_BASE_URL || providerOverride || fallback).replace(/\/+$/, '');
}

export function getLlmProviderStatus() {
  const provider = getConfiguredLlmProvider();
  return {
    provider,
    serverKeyEnabled: serverLlmKeyEnabled(),
    acceptsSessionKey: true
  };
}
