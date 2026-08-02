import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRepairableProject, runFixLoop } from '../services/review/fixAgent.js';
import { runQualityReview } from '../services/review/reviewAgent.js';

function validProject() {
  return {
    projectId: 'runtime-repair-project',
    expandedSpec: { projectName: 'Repair Test' },
    blueprint: { fileList: [], routes: [] },
    generatedFiles: [
      { path: 'package.json', language: 'json', content: JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' }, dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1', vite: '^5.4.2' } }) },
      { path: 'index.html', language: 'html', content: '<div id="root"></div>' },
      { path: 'src/main.jsx', language: 'jsx', content: "import App from './App.jsx'; export default App;" },
      { path: 'src/App.jsx', language: 'jsx', content: "export default function App(){ return <main>Ready</main> }" }
    ],
    dependencyGraph: {},
    generationWarnings: [],
    lastChangedFiles: ['src/App.jsx'],
    fileSnapshots: [],
    reviewHistory: [],
    verifiedFixCandidates: [],
    async save() {}
  };
}

test('preview repair rejects an empty persisted project before calling an agent', () => {
  assert.throws(
    () => assertRepairableProject({ generatedFiles: [] }),
    (error) => error.status === 409 && /no persisted generated files/i.test(error.message)
  );
});

test('runtime evidence creates a repair finding even when its message lacks the word error', async () => {
  const review = await runQualityReview({
    project: validProject(),
    runtimeOutput: 'Cannot read properties of undefined',
    runtimeEvidence: { errorType: 'browser_runtime', source: '/src/App.jsx' }
  });
  assert.equal(review.status, 'failed');
  assert.ok(review.findings.some((finding) => finding.category === 'runtime'));
});

test('runtime repair reports no progress instead of accepting identical fallback files', async () => {
  const project = validProject();
  const result = await runFixLoop(project, {
    runtimeOutput: 'TypeError: Cannot read properties of undefined',
    runtimeEvidence: { errorType: 'browser_runtime', source: '/src/App.jsx', lastChangedFiles: ['src/App.jsx'] },
    maxAttempts: 2
  });
  assert.equal(result.status, 'no_progress');
  assert.equal(result.appliedChanges.length, 0);
  assert.equal(project.operationStatus, 'human_escalation');
  assert.equal(project.fileSnapshots.length, 0);
  assert.equal(project.verifiedFixCandidates.length, 0);
});
