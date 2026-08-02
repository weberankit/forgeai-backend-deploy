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

test('deep quality mode uses the centralized deep profiles without overspending on utility tasks', async () => {
  const deep = await runWithRequestLlmContext({ openAiApiKey: 'sk-test-' + 'd'.repeat(32), qualityMode: 'deep' }, async () => ({
    expansion: getTaskLlmConfig('expansion'),
    planning: getTaskLlmConfig('planning'),
    generation: getTaskLlmConfig('code_generation'),
    repair: getTaskLlmConfig('generation_repair'),
    edit: getTaskLlmConfig('edit'),
    intent: getTaskLlmConfig('intent')
  }));
  assert.equal(deep.generation.model, LLM_QUALITY_PROFILES.deep.code_generation.model);
  assert.equal(deep.repair.model, LLM_QUALITY_PROFILES.deep.generation_repair.model);
  assert.equal(deep.edit.model, LLM_QUALITY_PROFILES.deep.edit.model);
  assert.equal(deep.edit.maxOutputTokens, LLM_QUALITY_PROFILES.deep.edit.maxOutputTokens);
  assert.equal(deep.expansion.model, LLM_QUALITY_PROFILES.deep.expansion.model);
  assert.equal(deep.planning.model, LLM_QUALITY_PROFILES.deep.planning.model);
  assert.equal(deep.intent.model, LLM_QUALITY_PROFILES.deep.intent.model);
  assert.equal(deep.generation.qualityMode, 'deep');
});


test('code generation selects models and token limits by quality mode and agent phase', async () => {
  const phases = ['project_setup', 'component_registry', 'layout_and_routing', 'pages_and_features', 'styling_system', 'integration'];
  const standard = await runWithRequestLlmContext({ qualityMode: 'standard' }, async () => Object.fromEntries(
    phases.map((phase) => [phase, getTaskLlmConfig('code_generation', { phase, agentName: phase })])
  ));
  const deep = await runWithRequestLlmContext({ qualityMode: 'deep' }, async () => Object.fromEntries(
    phases.map((phase) => [phase, getTaskLlmConfig('code_generation', { phase, agentName: phase })])
  ));

  assert.equal(standard.project_setup.model, 'gpt-4.1-mini');
  assert.equal(standard.project_setup.maxOutputTokens, 6000);
  assert.equal(standard.pages_and_features.model, 'gpt-5.4-mini');
  assert.equal(standard.integration.maxOutputTokens, 8000);
  assert.equal(deep.project_setup.model, 'gpt-4.1-mini');
  assert.equal(deep.component_registry.model, 'gpt-5.4-mini');
  assert.equal(deep.layout_and_routing.model, 'gpt-5.2');
  assert.equal(deep.pages_and_features.model, 'gpt-5.2');
  assert.equal(deep.styling_system.model, 'gpt-5.2');
  assert.equal(deep.integration.model, 'gpt-5.4-mini');
  assert.equal(deep.layout_and_routing.phase, 'layout_and_routing');
  assert.equal(deep.layout_and_routing.agentName, 'layout_and_routing');
});
