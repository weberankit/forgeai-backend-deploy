import { runWithRequestLlmContext, getRequestOpenAiApiKey } from '../context/requestLlmContext.js';
import { httpError } from '../utils/httpError.js';
import {
  OPENAI_API_KEY_INVALID,
  OPENAI_API_KEY_REQUIRED
} from '../services/ai/openAiErrors.js';

const API_KEY_HEADER = 'x-openai-api-key';
const MAX_API_KEY_LENGTH = 512;

export function withRequestOpenAiCredentials(req, res, next) {
  const rawValue = req.get(API_KEY_HEADER);
  const openAiApiKey = typeof rawValue === 'string' ? rawValue.trim() : '';
  runWithRequestLlmContext({ openAiApiKey }, next);
}

export function requireOpenAiApiKey(req, res, next) {
  const apiKey = getRequestOpenAiApiKey();
  if (!apiKey) {
    return next(httpError(
      401,
      'Add your OpenAI API key in Settings to use AI features.',
      OPENAI_API_KEY_REQUIRED
    ));
  }
  if (apiKey.length < 20 || apiKey.length > MAX_API_KEY_LENGTH || /\s/.test(apiKey)) {
    return next(httpError(
      401,
      'The OpenAI API key format is invalid.',
      OPENAI_API_KEY_INVALID
    ));
  }
  next();
}
