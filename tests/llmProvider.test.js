import assert from 'node:assert/strict';
import test from 'node:test';
import { PROVIDER_LLM_QUALITY_PROFILES } from '../config/llmProfiles.js';
import { getLlmProviderStatus } from '../config/llmProvider.js';
import { getTaskLlmConfig } from '../config/taskLlmConfig.js';
import { runWithRequestLlmContext } from '../context/requestLlmContext.js';
import { fetchLlmResponse, readLlmResponse, readLlmStream } from '../services/ai/llmTransport.js';
import { runCodeGenerationGraph } from '../services/ai/langGraphAgent.js';
import { normalizeOpenAiUsage } from '../services/observability/langfuseTracing.js';

const testKey = 'mistral-test-' + 'm'.repeat(32);

test('Mistral provider selects its standard, deep, and phase-specific models', async () => {
  await withEnvironment({ LLM_PROVIDER: 'mistral', ALLOW_SERVER_LLM_KEY: 'false', LLM_BASE_URL: undefined }, async () => {
    const standard = await runWithRequestLlmContext({ llmApiKey: testKey, qualityMode: 'standard' }, () => ({
      intent: getTaskLlmConfig('intent'),
      setup: getTaskLlmConfig('code_generation', { phase: 'project_setup' }),
      pages: getTaskLlmConfig('code_generation', { phase: 'pages_and_features' })
    }));
    const deep = await runWithRequestLlmContext({ llmApiKey: testKey, qualityMode: 'deep' }, () => getTaskLlmConfig('code_generation', { phase: 'styling_system' }));

    assert.equal(standard.intent.provider, 'mistral');
    assert.equal(standard.intent.model, PROVIDER_LLM_QUALITY_PROFILES.mistral.standard.intent.model);
    assert.equal(standard.setup.model, 'mistral-small-latest');
    assert.equal(standard.pages.model, 'mistral-large-latest');
    assert.equal(deep.model, 'mistral-large-latest');
    assert.equal(standard.intent.baseUrl, 'https://api.mistral.ai/v1');
  });
});

test('server-key mode is explicit and provider status never exposes the secret', async () => {
  await withEnvironment({ LLM_PROVIDER: 'mistral', ALLOW_SERVER_LLM_KEY: 'true', LLM_API_KEY: testKey }, async () => {
    const config = getTaskLlmConfig('planning');
    const status = getLlmProviderStatus();
    assert.equal(config.provider, 'mistral');
    assert.equal(config.credentialSource, 'server');
    assert.deepEqual(status, { provider: 'mistral', serverKeyEnabled: true, acceptsSessionKey: true });
    assert.doesNotMatch(JSON.stringify(status), new RegExp(testKey));
  });
});

test('Mistral transport converts structured text and vision calls to Chat Completions', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return Response.json({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }
    });
  };
  const config = { provider: 'mistral', configuredProvider: 'mistral', apiKey: testKey, baseUrl: 'https://api.mistral.test/v1', model: 'mistral-large-latest', temperature: 0.2, maxOutputTokens: 500, timeoutMs: 1000 };
  try {
    const response = await fetchLlmResponse(config, { input: [{ role: 'user', content: [{ type: 'input_text', text: 'Return JSON' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }] });
    const result = await readLlmResponse(response, config);
    assert.equal(calls[0].url, 'https://api.mistral.test/v1/chat/completions');
    assert.equal(calls[0].body.max_tokens, 500);
    assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
    assert.equal(calls[0].body.messages[0].content[0].type, 'text');
    assert.equal(calls[0].body.messages[0].content[1].type, 'image_url');
    assert.equal(result.text, '{"ok":true}');
    assert.deepEqual(normalizeOpenAiUsage(result.usage), { input: 12, output: 5 });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Mistral transport waits and retries provider rate limits before agent fallback', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ message: 'Rate limit exceeded' }), { status: 429, headers: { 'retry-after': '0' } });
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
  };
  const config = { provider: 'mistral', configuredProvider: 'mistral', apiKey: testKey, baseUrl: 'https://api.mistral.test/v1', model: 'mistral-small-latest', temperature: 0.1, maxOutputTokens: 100, timeoutMs: 1000 };
  try {
    const response = await fetchLlmResponse(config, { input: 'Return JSON' });
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Mistral streaming normalizes deltas and reports usage for Langfuse', async () => {
  const events = [
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '{"files":' } }] }),
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '[]}' } }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } }),
    'data: [DONE]'
  ].join('\n\n') + '\n\n';
  const response = new Response(events, { headers: { 'Content-Type': 'text/event-stream' } });
  const tokens = [];
  let usage;
  const text = await readLlmStream(response, { provider: 'mistral' }, (token) => tokens.push(token), (value) => { usage = value; });
  assert.equal(text, '{"files":[]}');
  assert.deepEqual(tokens, ['{"files":', '[]}']);
  assert.deepEqual(normalizeOpenAiUsage(usage), { input: 20, output: 4 });
});

test('Mistral runs code generation through the existing LangGraph agent pipeline', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    return Response.json({
      choices: [{ message: { content: JSON.stringify({
        files: [{ path: 'src/pages/Home.jsx', language: 'jsx', content: 'export default function Home() { return <main>Portfolio</main>; }' }],
        contracts: [],
        warnings: []
      }) } }],
      usage: { prompt_tokens: 70, completion_tokens: 30, total_tokens: 100 }
    });
  };

  try {
    await withEnvironment({ LLM_PROVIDER: 'mistral', ALLOW_SERVER_LLM_KEY: 'false', LANGFUSE_ENABLED: 'false' }, async () => {
      const result = await runWithRequestLlmContext({ llmApiKey: testKey, qualityMode: 'standard' }, () => runCodeGenerationGraph({
        specification: { projectName: 'Portfolio' },
        blueprint: { fileList: [{ path: 'src/pages/Home.jsx', dependsOn: [] }], routes: [] },
        previousFiles: [],
        targetFiles: ['src/pages/Home.jsx'],
        contracts: [],
        warnings: [],
        fallback: { files: [], contracts: [], warnings: [] },
        agentName: 'Page Agent',
        phase: 'pages_and_features',
        batchNumber: 1,
        dependencyContext: {}
      }));

      assert.equal(result.files[0].path, 'src/pages/Home.jsx');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://api.mistral.ai/v1/chat/completions');
      assert.equal(calls[0].body.model, 'mistral-large-latest');
      assert.match(calls[0].body.messages[0].content, /Portfolio/);
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

async function withEnvironment(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
