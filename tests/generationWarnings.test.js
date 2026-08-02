import test from 'node:test';
import assert from 'node:assert/strict';
import { Project } from '../models/Project.js';
import { normalizeGenerationWarnings } from '../utils/generationWarnings.js';
import { selectActiveGenerationBatches } from '../services/generation/codeGenerationService.js';

test('structured agent warnings normalize into stable bounded strings', () => {
  const warnings = normalizeGenerationWarnings([
    'Plain warning',
    { path: 'src/App.jsx', message: 'Included a safe not-found experience.' },
    { code: 'FALLBACK_USED' },
    null,
    'Plain warning'
  ]);
  assert.deepEqual(warnings, [
    'Plain warning',
    'src/App.jsx: Included a safe not-found experience.',
    'FALLBACK_USED'
  ]);
});

test('project schema cannot fail when an agent returns object warnings', () => {
  const project = new Project({
    projectId: 'warning-shape-project',
    chatId: 'warning-shape-chat',
    visitorId: 'warning-shape-visitor',
    name: 'Warning Shape',
    originalPrompt: 'Create a warning shape regression test',
    generationWarnings: [
      'Deterministic repair completed.',
      { path: 'src/App.jsx', message: 'Included a safe not-found experience.' }
    ]
  });
  assert.equal(project.validateSync(), undefined);
  assert.deepEqual(project.generationWarnings, [
    'Deterministic repair completed.',
    'src/App.jsx: Included a safe not-found experience.'
  ]);
});

test('failed generation resumes from its preserved batch checkpoint', () => {
  const batches = [1, 2, 3, 4, 5, 6, 7, 8].map((batchNumber) => ({ batchNumber, files: ['file-' + batchNumber] }));
  assert.deepEqual(
    selectActiveGenerationBatches(batches, { failedBatch: 7 }).map((batch) => batch.batchNumber),
    [7, 8]
  );
});
