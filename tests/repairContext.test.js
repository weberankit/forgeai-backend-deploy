import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGenerationRepairPrompt } from '../services/ai/prompts/generationRepairPrompt.js';
import { buildFocusedRepairContext, MAX_REPAIR_CONTEXT_CHARS } from '../services/review/repairContext.js';
import { runStaticValidation } from '../services/review/staticValidation.js';
import { boundAgentPrompt, MAX_EDIT_PROMPT_CHARS, MAX_REPAIR_PROMPT_CHARS } from '../services/ai/langGraphAgent.js';

test('repair context includes exact targets and direct contracts without the whole project', () => {
  const targetContent = "import { tailwindMerge } from 'tailwind-merge'; export default function DataTable(){ return tailwindMerge('table'); }";
  const project = {
    expandedSpec: { projectName: 'Dashboard', pages: [{ name: 'Home', route: '/' }], oversized: 'x'.repeat(50_000) },
    blueprint: {
      routes: [{ path: '/', component: 'Home' }],
      fileList: [
        { path: 'src/components/ui/DataTable.jsx', responsibility: 'Render data', dependsOn: [] },
        { path: 'src/pages/Home.jsx', responsibility: 'Home page', dependsOn: ['src/components/ui/DataTable.jsx'] }
      ]
    },
    generatedFiles: [
      { path: 'package.json', language: 'json', content: JSON.stringify({ dependencies: { 'tailwind-merge': '^2.6.0', react: '^18.3.1' } }) },
      { path: 'src/components/ui/DataTable.jsx', language: 'jsx', content: targetContent },
      { path: 'src/pages/Home.jsx', language: 'jsx', content: "import DataTable from '../components/ui/DataTable'; export default function Home(){ return <DataTable />; }" },
      ...Array.from({ length: 20 }, (_, index) => ({ path: 'src/unrelated/File' + index + '.js', language: 'js', content: 'export const value' + index + " = '" + 'u'.repeat(4_000) + "';" }))
    ],
    dependencyGraph: {},
    generationWarnings: []
  };
  const validation = runStaticValidation(project.generatedFiles);
  const review = {
    runtimeOutput: 'Vite build failed: tailwindMerge is not exported by tailwind-merge',
    runtimeEvidence: { errorType: 'build', source: '/src/components/ui/DataTable.jsx' },
    findings: [{ id: 'REV-001', severity: 'blocker', file: 'src/components/ui/DataTable.jsx', description: 'Invalid package export' }]
  };
  const context = buildFocusedRepairContext({
    project,
    review,
    targetPaths: ['src/components/ui/DataTable.jsx'],
    validation,
    previousAttempt: { validationError: 'Previous patch still imported tailwindMerge.', changes: [{ path: 'src/components/ui/DataTable.jsx', content: targetContent }] }
  });
  const prompt = buildGenerationRepairPrompt({
    specification: context.specification,
    blueprint: context.blueprint,
    previousFiles: context.supportingFiles,
    targetFiles: context.targetPaths,
    generatedFiles: context.targetFiles,
    validationError: review.runtimeOutput,
    contracts: [], warnings: [], agentName: 'Dynamic Preview Repair Agent', phase: 'runtime_and_import_repair',
    dependencyContext: context.dependencyContext, attempt: 2
  });

  assert.equal(context.targetFiles[0].content, targetContent);
  assert.ok(context.supportingFiles.some((file) => file.path === 'package.json'));
  assert.ok(context.supportingFiles.some((file) => file.path === 'src/pages/Home.jsx'));
  assert.equal(context.supportingFiles.some((file) => file.path.startsWith('src/unrelated/')), false);
  assert.deepEqual(context.dependencyContext.allowedFiles, ['src/components/ui/DataTable.jsx']);
  assert.match(JSON.stringify(context.dependencyContext.previousRepair), /Previous patch/);
  assert.ok(context.stats.contextChars < MAX_REPAIR_CONTEXT_CHARS);
  assert.ok(prompt.length < MAX_REPAIR_CONTEXT_CHARS);
});

test('oversized repair files are explicitly bounded under the complete prompt cap', () => {
  const oversized = 'export default function Huge(){ return null; }\n' + 'x'.repeat(80_000);
  const project = {
    expandedSpec: { projectName: 'Huge' },
    blueprint: { routes: [], fileList: [{ path: 'src/Huge.jsx', responsibility: 'Large generated module', dependsOn: [] }] },
    generatedFiles: [
      { path: 'package.json', language: 'json', content: '{"dependencies":{"react":"^18.3.1"}}' },
      { path: 'src/Huge.jsx', language: 'jsx', content: oversized }
    ],
    dependencyGraph: {}
  };
  const review = { runtimeOutput: 'Build failed in src/Huge.jsx', runtimeEvidence: { errorType: 'build', stack: 's'.repeat(20_000) }, findings: [] };
  const validation = runStaticValidation(project.generatedFiles);
  const context = buildFocusedRepairContext({ project, review, targetPaths: ['src/Huge.jsx'], validation });
  const prompt = buildGenerationRepairPrompt({
    specification: context.specification, blueprint: context.blueprint, previousFiles: context.supportingFiles,
    targetFiles: context.targetPaths, generatedFiles: context.targetFiles, validationError: review.runtimeOutput,
    contracts: [], warnings: [], agentName: 'Dynamic Preview Repair Agent', phase: 'runtime_and_import_repair', dependencyContext: context.dependencyContext, attempt: 1
  });
  assert.equal(context.targetFiles[0].truncated, true);
  assert.ok(prompt.length < MAX_REPAIR_CONTEXT_CHARS);
});

test('the actual repair request and retry are capped after the complete prompt is assembled', () => {
  const oversized = 'repair instructions\n' + 'x'.repeat(90_000);
  const bounded = boundAgentPrompt('generation_repair', oversized);
  assert.equal(bounded.length, MAX_REPAIR_PROMPT_CHARS);
  assert.match(bounded, /Optional trailing repair context removed/);
  assert.equal(boundAgentPrompt('edit', oversized).length, MAX_EDIT_PROMPT_CHARS);
});
