import { getRequestOpenAiApiKey } from '../context/requestLlmContext.js';
import { httpError } from '../utils/httpError.js';
import { OPENAI_API_KEY_INVALID } from '../services/ai/openAiErrors.js';

const VALIDATION_TIMEOUT_MS = 10_000;

export async function validateOpenAiKey(req, res, next) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
  res.setHeader('Cache-Control', 'no-store');
  try {
    const apiKey = getRequestOpenAiApiKey();
    const baseUrl = String(process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const response = await fetch(baseUrl + '/models', {
      headers: { Authorization: 'Bearer ' + apiKey },
      signal: controller.signal
    });

    if (response.status === 401 || response.status === 403) {
      throw httpError(
        401,
        'OpenAI rejected this API key. Check the key and try again.',
        OPENAI_API_KEY_INVALID
      );
    }
    if (!response.ok) {
      throw httpError(502, 'OpenAI could not validate the API key right now. Try again.');
    }

    res.json({ valid: true });
  } catch (error) {
    if (error.name === 'AbortError') {
      next(httpError(504, 'OpenAI key validation timed out. Try again.'));
      return;
    }
    next(error);
  } finally {
    clearTimeout(timeout);
  }
}
