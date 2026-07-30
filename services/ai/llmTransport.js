import { requireTaskLlmApiKey } from '../../config/taskLlmConfig.js';
import { openAiCredentialError } from './openAiErrors.js';

export async function fetchLlmResponse(config, body) {
  requireTaskLlmApiKey(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.baseUrl + '/responses', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        max_output_tokens: config.maxOutputTokens,
        ...body,
        store: false
      }),
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403) {
      throw openAiCredentialError();
    }
    return response;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('LLM request timed out after ' + config.timeoutMs + 'ms.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
