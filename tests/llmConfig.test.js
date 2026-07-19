import assert from 'node:assert/strict';
import test from 'node:test';
import { getTaskLlmConfig } from '../config/taskLlmConfig.js';

test('task LLM profiles remain authoritative over legacy environment model settings', () => {
  const previous = { ...process.env };
  process.env.LLM_PROVIDER = 'openai';
  process.env.LLM_MODEL = 'wrong-global-model';
  process.env.OPENAI_MODEL = 'wrong-legacy-model';
  process.env.LLM_CODE_GENERATION_MODEL = 'wrong-task-env-model';
  try {
    assert.equal(getTaskLlmConfig('expansion').model, 'gpt-4.1-mini');
    assert.equal(getTaskLlmConfig('expansion').temperature, 0.2);
    assert.equal(getTaskLlmConfig('code_generation').model, 'gpt-5.2');
    assert.equal(getTaskLlmConfig('code_generation').temperature, undefined);
    assert.equal(getTaskLlmConfig('code_generation').maxRetries, 2);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
