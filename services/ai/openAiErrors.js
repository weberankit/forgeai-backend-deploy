export const OPENAI_API_KEY_REQUIRED = 'OPENAI_API_KEY_REQUIRED';
export const OPENAI_API_KEY_INVALID = 'OPENAI_API_KEY_INVALID';
export const LLM_API_KEY_REQUIRED = 'LLM_API_KEY_REQUIRED';
export const LLM_API_KEY_INVALID = 'LLM_API_KEY_INVALID';

export function openAiCredentialError(
  message = 'OpenAI rejected this API key. Check the key and try again.'
) {
  const error = new Error(message);
  error.status = 401;
  error.code = OPENAI_API_KEY_INVALID;
  return error;
}

export function isOpenAiCredentialError(error) {
  return isLlmCredentialError(error);
}

export function llmCredentialError(provider = 'openai') {
  if (provider === 'openai') return openAiCredentialError();
  const error = new Error('The configured LLM provider rejected this API key. Check the key and try again.');
  error.status = 401;
  error.code = LLM_API_KEY_INVALID;
  return error;
}

export function isLlmCredentialError(error) {
  return [OPENAI_API_KEY_REQUIRED, OPENAI_API_KEY_INVALID, LLM_API_KEY_REQUIRED, LLM_API_KEY_INVALID].includes(error?.code);
}
