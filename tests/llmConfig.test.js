import assert from 'node:assert/strict';
import test from 'node:test';
import { LLM_PROFILES, LLM_QUALITY_PROFILES } from '../config/llmProfiles.js';
import { runWithRequestLlmContext } from '../context/requestLlmContext.js';
import { getTaskLlmConfig } from '../config/taskLlmConfig.js';

test('task LLM profiles remain authoritative over legacy environment model settings', () => {
  const previous = { ...process.env };
  process.env.LLM_PROVIDER = 'openai';
  process.env.LLM_MODEL = 'wrong-global-model';
  process.env.OPENAI_MODEL = 'wrong-legacy-model';
  process.env.LLM_CODE_GENERATION_MODEL = 'wrong-task-env-model';
  try {
    assert.equal(getTaskLlmConfig('expansion').model, LLM_PROFILES.expansion.model);
    assert.equal(getTaskLlmConfig('expansion').temperature, LLM_PROFILES.expansion.temperature);
    assert.equal(getTaskLlmConfig('code_generation').model, LLM_PROFILES.code_generation.model);
    assert.equal(getTaskLlmConfig('code_generation').temperature, LLM_PROFILES.code_generation.temperature);
    assert.equal(getTaskLlmConfig('code_generation').maxRetries, 2);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test('deep quality mode upgrades generation repair and edits without overspending on utility tasks', async () => {
  const deep = await runWithRequestLlmContext({ openAiApiKey: 'sk-test-' + 'd'.repeat(32), qualityMode: 'deep' }, async () => ({
    expansion: getTaskLlmConfig('expansion'),
    planning: getTaskLlmConfig('planning'),
    generation: getTaskLlmConfig('code_generation'),
    repair: getTaskLlmConfig('generation_repair'),
    edit: getTaskLlmConfig('edit'),
    intent: getTaskLlmConfig('intent')
  }));
  assert.equal(deep.generation.model, 'gpt-5.2');
  assert.equal(deep.repair.model, 'gpt-5.2');
  assert.equal(deep.edit.model, 'gpt-5.2');
  assert.equal(deep.edit.maxOutputTokens, 16000);
  assert.equal(deep.expansion.model, LLM_QUALITY_PROFILES.standard.expansion.model);
  assert.equal(deep.planning.model, LLM_QUALITY_PROFILES.standard.planning.model);
  assert.equal(deep.intent.model, 'gpt-4.1-nano');
  assert.equal(deep.generation.qualityMode, 'deep');
});
