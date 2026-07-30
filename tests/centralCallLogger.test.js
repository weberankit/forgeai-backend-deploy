import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withCallLog } from '../services/observability/centralCallLogger.js';
import { normalizeOpenAiUsage } from '../services/observability/langfuseTracing.js';

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
    promptTokens: 120,
    completionTokens: 45,
    totalTokens: 165
  });
  assert.deepEqual(normalizeOpenAiUsage(null), {});
});
