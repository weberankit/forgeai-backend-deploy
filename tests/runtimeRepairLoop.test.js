import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRepairVerification, assertRepairableProject, resolveRuntimeRepairTargets, runFixLoop } from '../services/review/fixAgent.js';
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

function mongooseLikeFile(data) {
  const document = { toObject: () => ({ ...data }) };
  for (const key of Object.keys(data)) Object.defineProperty(document, key, { enumerable: false, get: () => data[key] });
  return document;
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

test('runtime repair cannot pass an unresolved preview failure with zero applied changes', async () => {
  const project = validProject();
  const result = await runFixLoop(project, {
    runtimeOutput: 'src/components/DataTable.jsx: tailwindMerge is not exported by tailwind-merge',
    runtimeEvidence: {},
    maxAttempts: 2
  });
  assert.equal(result.status, 'no_progress');
  assert.equal(result.appliedChanges.length, 0);
  assert.equal(project.operationStatus, 'human_escalation');
  assert.equal(result.attempts.length, 2);
});

test('runtime repair fixes an existing invalid tailwind-merge import without an LLM response', async () => {
  const project = validProject();
  project.generatedFiles.push({
    path: 'src/components/ui/DataTable.jsx',
    language: 'jsx',
    content: "import { tailwindMerge } from 'tailwind-merge'; export const cn = (...values) => tailwindMerge(values);"
  });
  const result = await runFixLoop(project, {
    runtimeOutput: 'Vite build failed: tailwindMerge is not exported by tailwind-merge',
    runtimeEvidence: { errorType: 'build', source: '/src/components/ui/DataTable.jsx' },
    maxAttempts: 2
  });

  assert.equal(result.status, 'verification_required');
  assert.deepEqual(result.appliedChanges, ['src/components/ui/DataTable.jsx']);
  assert.match(project.generatedFiles.find((file) => file.path === 'src/components/ui/DataTable.jsx').content, /twMerge as tailwindMerge/);
});

test('runtime repair preserves Mongoose subdocument fields while cloning and validating files', async () => {
  const project = validProject();
  project.generatedFiles.push({
    path: 'src/components/ui/DataTable.jsx',
    language: 'jsx',
    content: "import { tailwindMerge } from 'tailwind-merge'; export const cn = (...values) => tailwindMerge(values);"
  });
  project.generatedFiles = project.generatedFiles.map(mongooseLikeFile);

  const result = await runFixLoop(project, {
    runtimeOutput: 'Vite build failed: tailwindMerge is not exported by tailwind-merge',
    runtimeEvidence: { errorType: 'build', source: '/src/components/ui/DataTable.jsx' }
  });

  assert.equal(result.status, 'verification_required');
  assert.equal(project.generatedFiles.some((file) => !file.path), false);
  assert.equal(project.fileSnapshots[0].files.some((file) => !file.path), false);
  assert.match(project.generatedFiles.find((file) => file.path === 'src/components/ui/DataTable.jsx').content, /twMerge as tailwindMerge/);
});

test('runtime target selection prioritizes every file named by Vite error lines', () => {
  const project = validProject();
  project.generatedFiles.push(
    { path: 'src/index.css', language: 'css', content: '@tailwind base;\n@import url("https://fonts.example/font.css");' },
    { path: 'src/layouts/ResponsiveGrid.jsx', language: 'jsx', content: "import PropTypes from 'prop-types'; export default function ResponsiveGrid(){ return <div /> }" }
  );
  const output = [
    'transforming index.html and src/main.jsx',
    'warning: @import must precede all other statements in src/index.css',
    'error during build: Could not resolve "prop-types" from "src/layouts/ResponsiveGrid.jsx"'
  ].join('\n');
  const targets = resolveRuntimeRepairTargets(project, output, { errorType: 'build' }, 2);
  assert.deepEqual(new Set(targets), new Set(['src/index.css', 'src/layouts/ResponsiveGrid.jsx']));
});

test('failed WebContainer verification records the patch and rolls back persisted files', async () => {
  const project = validProject();
  project.generatedFiles.push({ path: 'src/components/ui/DataTable.jsx', language: 'jsx', content: "import { tailwindMerge } from 'tailwind-merge'; export const cn = (...values) => tailwindMerge(values);" });
  const repair = await runFixLoop(project, {
    runtimeOutput: 'Vite build failed: tailwindMerge is not exported by tailwind-merge',
    runtimeEvidence: { errorType: 'build', source: '/src/components/ui/DataTable.jsx' }
  });
  const verification = applyRepairVerification(project, {
    buildPassed: false,
    previewPassed: false,
    changedFiles: repair.appliedChanges,
    error: 'Vite build failed after proposed repair.'
  });

  assert.equal(verification.status, 'failed');
  assert.equal(verification.rolledBack, true);
  assert.match(verification.verificationResult.failedChanges[0].content, /twMerge as tailwindMerge/);
  assert.match(project.generatedFiles.find((file) => file.path === 'src/components/ui/DataTable.jsx').content, /\{ tailwindMerge \}/);
  assert.equal(project.operationStatus, 'repair_verification_failed');
});

test('successful WebContainer verification is the only final repair pass', async () => {
  const project = validProject();
  project.operationStatus = 'fix_applied';
  project.lastChangedFiles = ['src/App.jsx'];
  const verification = applyRepairVerification(project, {
    buildPassed: true,
    previewPassed: true,
    changedFiles: ['src/App.jsx']
  });
  assert.equal(verification.status, 'passed');
  assert.equal(verification.rolledBack, false);
  assert.equal(project.operationStatus, 'repair_verified');
  assert.ok(project.lastSuccessfulPreviewAt instanceof Date);
});
