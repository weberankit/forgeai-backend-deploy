import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getRequestOpenAiApiKey,
  runWithRequestLlmContext
} from '../context/requestLlmContext.js';
import { getTaskLlmConfig } from '../config/taskLlmConfig.js';
import { fetchLlmResponse } from '../services/ai/llmTransport.js';
import { validateOpenAiKey } from '../controllers/llmController.js';
import projectRoutes from '../routes/projectRoutes.js';

const firstKey = 'sk-test-' + 'a'.repeat(32);
const secondKey = 'sk-test-' + 'b'.repeat(32);

test('request OpenAI keys stay isolated across concurrent async work', async () => {
  const [first, second] = await Promise.all([
    runWithRequestLlmContext({ openAiApiKey: firstKey }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        contextKey: getRequestOpenAiApiKey(),
        config: getTaskLlmConfig('expansion')
      };
    }),
    runWithRequestLlmContext({ openAiApiKey: secondKey }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return {
        contextKey: getRequestOpenAiApiKey(),
        config: getTaskLlmConfig('planning')
      };
    })
  ]);

  assert.equal(first.contextKey, firstKey);
  assert.equal(first.config.apiKey, firstKey);
  assert.equal(first.config.provider, 'openai');
  assert.equal(second.contextKey, secondKey);
  assert.equal(second.config.apiKey, secondKey);
  assert.equal(second.config.provider, 'openai');
  assert.equal(getRequestOpenAiApiKey(), '');
});

test('multipart expansion routes restore API-key context after upload parsing', () => {
  for (const path of ['/expand/stream', '/expand']) {
    const route = projectRoutes.stack.find((layer) => layer.route?.path === path)?.route;
    assert.ok(route, 'Expected route ' + path);
    const handlers = route.stack.map((layer) => layer.handle.name);
    const uploadIndex = handlers.indexOf('multerMiddleware');
    const contextIndex = handlers.indexOf('withRequestOpenAiCredentials');
    const controllerIndex = handlers.indexOf(path.endsWith('/stream') ? 'expandProjectStream' : 'expandProject');

    assert.ok(uploadIndex >= 0, 'Expected multipart parser on ' + path);
    assert.ok(contextIndex > uploadIndex, 'Expected API-key context restoration after multipart parsing on ' + path);
    assert.ok(controllerIndex > contextIndex, 'Expected expansion controller after API-key context restoration on ' + path);
  }
});

test('server environment API keys are not selected as user credentials', () => {
  const previousProvider = process.env.LLM_PROVIDER;
  const previousLlmKey = process.env.LLM_API_KEY;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.LLM_PROVIDER = 'openai';
  process.env.LLM_API_KEY = 'server-llm-key';
  process.env.OPENAI_API_KEY = 'server-openai-key';
  try {
    const config = getTaskLlmConfig('expansion');
    assert.equal(config.provider, 'mock');
    assert.equal(config.apiKey, '');
  } finally {
    restoreEnv('LLM_PROVIDER', previousProvider);
    restoreEnv('LLM_API_KEY', previousLlmKey);
    restoreEnv('OPENAI_API_KEY', previousOpenAiKey);
  }
});

test('OpenAI authentication failures expose a safe credential error code', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } });
  try {
    await assert.rejects(
      fetchLlmResponse({
        provider: 'openai',
        task: 'expansion',
        apiKey: firstKey,
        baseUrl: 'https://api.openai.test/v1',
        model: 'test-model',
        timeoutMs: 1_000
      }, { input: 'test' }),
      (error) => error.code === 'OPENAI_API_KEY_INVALID'
        && error.status === 401
        && !error.message.includes(firstKey)
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('key validation uses the request key and prevents response caching', async () => {
  const previousFetch = globalThis.fetch;
  let authorization = '';
  globalThis.fetch = async (url, options) => {
    authorization = options.headers.Authorization;
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const responseHeaders = new Map();
  let payload;
  let forwardedError;
  const res = {
    setHeader: (name, value) => responseHeaders.set(name.toLowerCase(), value),
    json: (value) => {
      payload = value;
    }
  };
  try {
    await runWithRequestLlmContext(
      { openAiApiKey: firstKey },
      () => validateOpenAiKey({}, res, (error) => {
        forwardedError = error;
      })
    );
    assert.equal(forwardedError, undefined);
    assert.equal(authorization, 'Bearer ' + firstKey);
    assert.deepEqual(payload, { valid: true });
    assert.equal(responseHeaders.get('cache-control'), 'no-store');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
