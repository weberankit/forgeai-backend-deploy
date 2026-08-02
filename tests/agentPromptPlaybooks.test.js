import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodeGenerationPrompt } from '../services/ai/prompts/codeGenerationPrompt.js';
import { buildExpansionPrompt } from '../services/ai/prompts/expansionPrompt.js';
import { buildGenerationRepairPrompt } from '../services/ai/prompts/generationRepairPrompt.js';
import { GENERATION_AGENT_NAMES } from '../services/ai/prompts/generationAgentPlaybooks.js';
import { buildPlanningPrompt } from '../services/ai/prompts/planningPrompt.js';

const generationInput = {
  specification: {},
  blueprint: {},
  previousFiles: [],
  targetFiles: ['src/example.js'],
  contracts: [],
  warnings: [],
  dependencyContext: {}
};

test('every generation role receives a concrete scoped behavioral playbook', () => {
  assert.deepEqual(GENERATION_AGENT_NAMES, [
    'Project Setup Agent',
    'Component Agent',
    'Layout Agent',
    'Page Agent',
    'Styling Agent',
    'Frontend Manager Agent'
  ]);

  for (const agentName of GENERATION_AGENT_NAMES) {
    const prompt = buildCodeGenerationPrompt({ ...generationInput, agentName });
    assert.match(prompt, new RegExp('CURRENT AGENT PLAYBOOK: ' + agentName));
    assert.match(prompt, /Mission:/);
    assert.match(prompt, /Required behavior:/);
    assert.match(prompt, /Ownership boundaries:/);
    assert.match(prompt, /Concrete React app example:/);
    assert.match(prompt, /bookstore React app/);
  }
});

test('dynamic preview repair receives a root-cause and no-repeat playbook', () => {
  const prompt = buildGenerationRepairPrompt({
    ...generationInput,
    generatedFiles: [],
    validationError: 'BookCard is not defined',
    agentName: 'Dynamic Preview Repair Agent',
    phase: 'runtime_and_import_repair'
  });
  assert.match(prompt, /CURRENT AGENT PLAYBOOK: Dynamic Preview Repair Agent/);
  assert.match(prompt, /Do not return identical file contents/);
  assert.match(prompt, /Do not delete the BookCard rendering/);
});

test('generation repair preserves the failed role playbook', () => {
  const prompt = buildGenerationRepairPrompt({
    ...generationInput,
    targetFiles: ['src/pages/CatalogPage.jsx'],
    generatedFiles: [],
    validationError: 'missing export',
    agentName: 'Page Agent',
    phase: 'pages_and_features'
  });
  assert.match(prompt, /Preserve the failed agent's ownership and behavioral contract/);
  assert.match(prompt, /CURRENT AGENT PLAYBOOK: Page Agent/);
  assert.match(prompt, /searchable book grid/);
});

test('expansion and planning prompts demonstrate concrete React pipeline behavior', () => {
  const expansion = buildExpansionPrompt({ prompt: 'Create a React app' });
  const planning = buildPlanningPrompt({ specification: {}, clarification: '' });
  assert.match(expansion, /create a bookstore React app/);
  assert.match(expansion, /concrete pages, routes, features, data/);
  assert.match(planning, /BookCard import must point to its exact planned file/);
  assert.match(planning, /frontend-only limitation in acceptanceCriteria/);
});
