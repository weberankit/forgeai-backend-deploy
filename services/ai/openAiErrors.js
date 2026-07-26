export const OPENAI_API_KEY_REQUIRED = 'OPENAI_API_KEY_REQUIRED';
export const OPENAI_API_KEY_INVALID = 'OPENAI_API_KEY_INVALID';

export function openAiCredentialError(
  message = 'OpenAI rejected this API key. Check the key and try again.'
) {
  const error = new Error(message);
  error.status = 401;
  error.code = OPENAI_API_KEY_INVALID;
  return error;
}

export function isOpenAiCredentialError(error) {
  return error?.code === OPENAI_API_KEY_REQUIRED || error?.code === OPENAI_API_KEY_INVALID;
}
