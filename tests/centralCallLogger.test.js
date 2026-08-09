import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withCallLog, withProjectCallLog } from '../services/observability/centralCallLogger.js';
import { buildProjectTraceContext, normalizeOpenAiUsage } from '../services/observability/langfuseTracing.js';
import { runCodeGenerationGraph } from '../services/ai/langGraphAgent.js';
import { runWithRequestLlmContext } from '../context/requestLlmContext.js';

test('central logger records nested call lifecycle and redacts sensitive metadata', async () => {
  const logPath = path.join(os.tmpdir(), 'forgeai-call-log-' + process.pid + '.jsonl');
  process.env.AI_CALL_LOG_PATH = logPath;
  await rm(logPath, { force: true });

  await withCallLog({ type: 'agent_call', operation: 'outer', provider: 'langgraph' }, () =>
    withCallLog({
      type: 'ai_call', operation: 'inner', provider: 'mock',
      metadata: { prompt: 'do not store me', promptLength: 15 }
    }, async () => 'ok')
  );

  const events = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map((event) => event.event), ['started', 'started', 'completed', 'completed']);
  assert.equal(events[1].parentCallId, events[0].callId);
  assert.deepEqual(events[1].metadata.prompt, { redacted: true, length: 15 });
  assert.equal(events[2].metadata.promptLength, 15);
  await rm(logPath, { force: true });
  delete process.env.AI_CALL_LOG_PATH;
});

test('Langfuse usage normalization records counts without request content', () => {
  assert.deepEqual(normalizeOpenAiUsage({
    input_tokens: 120,
    output_tokens: 45,
    total_tokens: 165,
    input: 'must not be copied',
    output: 'must not be copied'
  }), {
    input: 120,
    output: 45
  });
  assert.deepEqual(normalizeOpenAiUsage(null), {});
});


test('project tracing builds one stable Langfuse session and nested local lifecycle', async () => {
  const context = buildProjectTraceContext({
    projectId: 'project-123',
    operation: 'project_generation',
    qualityMode: 'deep',
    metadata: { batchCount: 7 }
  });
  assert.equal(context.sessionId, 'project:project-123');
  assert.equal(context.traceName, 'forgeai.project_generation');
  assert.deepEqual(context.metadata, {
    projectId: 'project-123',
    operation: 'project_generation',
    qualityMode: 'deep',
    batchCount: '7'
  });

  const logPath = path.join(os.tmpdir(), 'forgeai-project-trace-' + process.pid + '.jsonl');
  const previousLogPath = process.env.AI_CALL_LOG_PATH;
  const previousEnabled = process.env.LANGFUSE_ENABLED;
  process.env.AI_CALL_LOG_PATH = logPath;
  process.env.LANGFUSE_ENABLED = 'false';
  await rm(logPath, { force: true });
  try {
    await withProjectCallLog({
      projectId: 'project-123',
      operation: 'project_generation',
      qualityMode: 'deep',
      metadata: { batchCount: 7 }
    }, () => withCallLog({
      type: 'ai_call',
      operation: 'code_generation',
      provider: 'mock',
      metadata: { phase: 'pages_and_features', batchNumber: 4 }
    }, async () => 'ok'));

    const events = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map((event) => event.event), ['started', 'started', 'completed', 'completed']);
    assert.equal(events[0].operation, 'project_generation');
    assert.equal(events[0].metadata.projectId, 'project-123');
    assert.equal(events[1].parentCallId, events[0].callId);
    assert.equal(events[1].metadata.phase, 'pages_and_features');
    assert.equal(events[1].metadata.batchNumber, 4);
  } finally {
    await rm(logPath, { force: true });
    if (previousLogPath === undefined) delete process.env.AI_CALL_LOG_PATH;
    else process.env.AI_CALL_LOG_PATH = previousLogPath;
    if (previousEnabled === undefined) delete process.env.LANGFUSE_ENABLED;
    else process.env.LANGFUSE_ENABLED = previousEnabled;
  }
});

test('invalid structured model output is logged as a failed generation attempt before retry', async () => {
  const logPath = path.join(os.tmpdir(), 'forgeai-structured-error-' + process.pid + '.jsonl');
  const previousLogPath = process.env.AI_CALL_LOG_PATH;
  const previousEnabled = process.env.LANGFUSE_ENABLED;
  const previousFetch = globalThis.fetch;
  process.env.AI_CALL_LOG_PATH = logPath;
  process.env.LANGFUSE_ENABLED = 'false';
  await rm(logPath, { force: true });
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    const output = requestCount === 1
      ? '{}'
      : JSON.stringify({
          files: [{ path: 'src/pages/Home.jsx', language: 'jsx', content: 'export default function Home() { return <main>Home</main>; }' }],
          contracts: [],
          warnings: []
        });
    return new Response(JSON.stringify({
      output_text: output,
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await runWithRequestLlmContext({
      openAiApiKey: 'sk-test-' + 'z'.repeat(32),
      qualityMode: 'standard'
    }, () => runCodeGenerationGraph({
      specification: { projectName: 'Trace Test' },
      blueprint: { fileList: [{ path: 'src/pages/Home.jsx', dependsOn: [] }], routes: [] },
      previousFiles: [],
      targetFiles: ['src/pages/Home.jsx'],
      contracts: [],
      warnings: [],
      fallback: { files: [], contracts: [], warnings: [] },
      agentName: 'Page Agent',
      phase: 'pages_and_features',
      batchNumber: 4,
      dependencyContext: {}
    }));

    assert.equal(requestCount, 2);
    assert.equal(result.files[0].path, 'src/pages/Home.jsx');
    const events = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
    const attempts = events.filter((event) => event.type === 'ai_call' && event.operation === 'code_generation');
    assert.deepEqual(attempts.map((event) => event.event), ['started', 'failed', 'started', 'completed']);
    assert.equal(attempts[0].metadata.batchNumber, 4);
    assert.equal(attempts[1].error.name, 'Error');
  } finally {
    globalThis.fetch = previousFetch;
    await rm(logPath, { force: true });
    if (previousLogPath === undefined) delete process.env.AI_CALL_LOG_PATH;
    else process.env.AI_CALL_LOG_PATH = previousLogPath;
    if (previousEnabled === undefined) delete process.env.LANGFUSE_ENABLED;
    else process.env.LANGFUSE_ENABLED = previousEnabled;
  }
});
