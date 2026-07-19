import { requireTaskLlmApiKey } from '../../config/taskLlmConfig.js';

export async function fetchLlmResponse(config, body) {
  requireTaskLlmApiKey(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    return await fetch(config.baseUrl + '/responses', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        max_output_tokens: config.maxOutputTokens,
        ...body
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('LLM request timed out after ' + config.timeoutMs + 'ms.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
