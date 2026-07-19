import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProjectPath } from '../services/generation/pathSafety.js';
import { topologicalSortFiles } from '../services/generation/topologicalSort.js';
import { buildAgentExecutionStages, buildGenerationBatches } from '../services/generation/generationBatches.js';
import { validateGeneratedFiles, validateGenerationBatch } from '../services/generation/generatedFileValidation.js';
import { runSmokeRenderTests } from '../services/review/testingAgent.js';
import { runQualityReview } from '../services/review/reviewAgent.js';
import { generateProjectFiles, repairGenerationBatch } from '../services/generation/codeGenerationService.js';
import { applyNaturalLanguageEdit } from '../services/edit/editAgent.js';
import { explainProjectQuestion } from '../services/explain/explainAgent.js';
import { buildDependencyGraph } from '../services/review/dependencyGraph.js';
import { repairMissingRelativeImports } from '../services/generation/importRepair.js';
import { resolveEditTargets } from '../services/edit/editTargeting.js';
import { routeChatIntent } from '../services/edit/intentRouter.js';
import { resolveRuntimeRepairTargets } from '../services/review/fixAgent.js';
import { appendVerifiedFixMemoryRecord, buildErrorSignature, buildKnownPitfallsPrompt, retrieveVerifiedFixes } from '../services/memory/verifiedFixMemory.js';

test('rejects unsafe generated paths', () => {
  assert.throws(() => normalizeProjectPath('../secret.js'));
  assert.equal(normalizeProjectPath('src/App.jsx'), 'src/App.jsx');
});

test('topologically sorts blueprint files', () => {
  const sorted = topologicalSortFiles([
    { path: 'src/App.jsx', dependsOn: ['src/components/Card.jsx'] },
    { path: 'src/components/Card.jsx', dependsOn: [] }
  ]);
  assert.deepEqual(sorted.map((file) => file.path), ['src/components/Card.jsx', 'src/App.jsx']);
});

test('extracts AST import and render graph', () => {
  const graph = buildDependencyGraph([
    { path: 'src/App.jsx', content: "import HomePage from './pages/HomePage.jsx'; export default function App(){ return <HomePage /> }" },
    { path: 'src/pages/HomePage.jsx', content: "export default function HomePage(){ return <section /> }" }
  ]);
  assert.deepEqual(graph['src/App.jsx'].imports, ['src/pages/HomePage.jsx']);
  assert.deepEqual(graph['src/App.jsx'].renders, ['HomePage']);
  assert.deepEqual(graph['src/pages/HomePage.jsx'].importedBy, ['src/App.jsx']);
});

test('runtime repair targets an exact stack file and its dependency neighbors', () => {
  const files = [
    { path: 'src/App.jsx', content: "import ProductPage from './pages/ProductPage.jsx'; export default function App(){ return <ProductPage /> }" },
    { path: 'src/pages/ProductPage.jsx', content: 'export default function ProductPage(){ return <main>{products.length}</main> }' },
    { path: 'src/pages/AboutPage.jsx', content: 'export default function AboutPage(){ return <main>About</main> }' }
  ];
  const project = { generatedFiles: files, dependencyGraph: buildDependencyGraph(files) };
  const targets = resolveRuntimeRepairTargets(project, 'ReferenceError: products is not defined\n at ProductPage.jsx:42:18');
  assert.ok(targets.includes('src/pages/ProductPage.jsx'));
  assert.ok(targets.includes('src/App.jsx'));
  assert.ok(!targets.includes('src/pages/AboutPage.jsx'));
});

test('runtime repair uses AST symbols and bounded app/page fallback without a filename', () => {
  const files = [
    { path: 'src/App.jsx', content: "import CartPage from './pages/CartPage.jsx'; export default function App(){ return <CartPage /> }" },
    { path: 'src/pages/CartPage.jsx', content: 'export default function CartPage(){ return <main>{cartItems.map(String)}</main> }' },
    { path: 'src/pages/AboutPage.jsx', content: 'export default function AboutPage(){ return <main>About</main> }' }
  ];
  const project = { generatedFiles: files, dependencyGraph: buildDependencyGraph(files) };
  const symbolTargets = resolveRuntimeRepairTargets(project, 'ReferenceError: cartItems is not defined');
  assert.ok(symbolTargets.includes('src/pages/CartPage.jsx'));
  const fallbackTargets = resolveRuntimeRepairTargets(project, 'TypeError: Cannot read properties of undefined');
  assert.ok(fallbackTargets.includes('src/App.jsx'));
  assert.ok(fallbackTargets.length <= 8);
});

test('targets generated page files for hero visual edits', () => {
  const project = { generatedFiles: [
    { path: 'src/pages/HomePage.jsx', content: '<section className="bg-slate-950" />' },
    { path: 'src/App.jsx', content: 'import HomePage from "./pages/HomePage.jsx"' }
  ], dependencyGraph: {} };
  const result = resolveEditTargets(project, 'Make the hero section darker');
  assert.equal(result.needsClarification, false);
  assert.ok(result.targets.includes('src/pages/HomePage.jsx'));
});

test('builds generalized verified fix signature', () => {
  const signature = buildErrorSignature({ category: 'build', message: 'Missing default export', file: 'src/pages/HomePage.jsx' });
  assert.match(signature, /build/);
  assert.match(signature, /jsx/);
});

test('retrieves verified fix memory as known pitfalls by similar context', async () => {
  const previousMemoryFile = process.env.VERIFIED_FIX_MEMORY_FILE;
  process.env.VERIFIED_FIX_MEMORY_FILE = '/tmp/verified-fix-memory-test-' + Date.now() + '.json';
  await appendVerifiedFixMemoryRecord({
    id: 'memory-test-default-export',
    pattern: 'Missing default export in React module',
    context: 'smoke_render | src/pages/HomePage.jsx',
    failure: 'Renderable page module is missing a default export.',
    errorSignature: 'smoke_render | missing default export | jsx',
    errorCategory: 'smoke_render',
    technologies: ['React', 'Vite', 'JavaScript'],
    fix_applied: 'Export the page component as default and keep imports aligned.',
    changedFileTypes: ['jsx'],
    verificationEvidence: ['static validation passed'],
    verified: true,
    embedding: []
  });

  const matches = await retrieveVerifiedFixes({
    category: 'smoke_render',
    technologies: ['React', 'Vite'],
    message: 'page render failed because HomePage has missing default export',
    file: 'src/pages/HomePage.jsx'
  });
  const prompt = buildKnownPitfallsPrompt(matches);
  assert.equal(matches[0].pattern, 'Missing default export in React module');
  assert.match(prompt, /Known fix/);
  assert.match(prompt, /default/);

  if (previousMemoryFile === undefined) delete process.env.VERIFIED_FIX_MEMORY_FILE;
  else process.env.VERIFIED_FIX_MEMORY_FILE = previousMemoryFile;
});


test('builds dependency-ordered frontend agent generation DAG', () => {
  const batches = buildGenerationBatches({
    routes: [{ path: '/', component: 'HomePage' }],
    fileList: [
      { path: 'src/components/Button.jsx', dependsOn: [] },
      { path: 'src/layouts/Shell.jsx', dependsOn: ['src/components/Button.jsx'] },
      { path: 'src/pages/HomePage.jsx', dependsOn: ['src/layouts/Shell.jsx'] }
    ]
  });
  const stages = buildAgentExecutionStages(batches);

  assert.deepEqual(stages.map((stage) => stage.phase), [
    'project_setup',
    'component_registry',
    'layout_and_routing',
    'page_and_styling',
    'integration'
  ]);
  assert.equal(stages[3].parallel, true);
  assert.deepEqual(stages[3].batches.map((batch) => batch.agentName).sort(), ['Page Agent', 'Styling Agent']);
  assert.equal(stages[0].batches[0].agentName, 'Project Setup Agent');
  assert.equal(stages[1].batches[0].agentName, 'Component Agent');
  assert.equal(stages[2].batches[0].agentName, 'Layout Agent');
  assert.equal(stages[4].batches[0].agentName, 'Frontend Manager Agent');
});


test('ignores package-like blueprint file entries during generation planning', () => {
  const batches = buildGenerationBatches({
    routes: [{ path: '/', component: 'HomePage' }],
    fileList: [
      { path: 'jszip', dependsOn: [] },
      { path: 'src/components/Card.jsx', dependsOn: ['jszip'] }
    ]
  });
  const allFiles = batches.flatMap((batch) => batch.files);
  assert.equal(allFiles.includes('jszip'), false);
  assert.equal(allFiles.includes('tsconfig.json'), false);
  assert.equal(allFiles.includes('src/components/Card.jsx'), true);
});


test('breaks circular blueprint dependencies during generation planning', () => {
  const batches = buildGenerationBatches({
    routes: [{ path: '/', component: 'HomePage' }],
    fileList: [
      { path: 'src/routes/AppRouter.jsx', dependsOn: ['src/pages/HomePage.jsx'] },
      { path: 'src/pages/HomePage.jsx', dependsOn: ['src/routes/AppRouter.jsx'] }
    ]
  });
  const allFiles = batches.flatMap((batch) => batch.files);
  assert.equal(allFiles.includes('src/routes/AppRouter.jsx'), true);
  assert.equal(allFiles.includes('src/pages/HomePage.jsx'), true);
});


test('keeps supported frontend packages and removes unsupported package dependencies from generated package json', () => {
  const files = validateGenerationBatch([
    {
      path: 'package.json',
      language: 'json',
      content: JSON.stringify({
        scripts: { dev: 'vite' },
        dependencies: {
          react: '^18.3.1',
          '@stripe/react-stripe-js': '^2.8.0',
          'react-beautiful-dnd': '^13.1.1',
          express: '^4.21.0'
        }
      })
    }
  ], ['package.json']);
  const pkg = JSON.parse(files[0].content);
  assert.equal(pkg.dependencies.react, '^18.3.1');
  assert.equal(pkg.dependencies['@stripe/react-stripe-js'], '^2.8.0');
  assert.equal(pkg.dependencies['react-beautiful-dnd'], '^13.1.1');
  assert.equal(pkg.dependencies.express, undefined);
  assert.deepEqual(pkg.aiFrontendEngineer.removedUnsupportedDependencies, ['express']);
});


test('smoke render testing agent catches undefined rendered components', () => {
  const result = runSmokeRenderTests([
    { path: 'src/components/Card.jsx', content: 'export default function Card(){ return <MissingWidget /> }' }
  ]);
  assert.equal(result.passed, false);
  assert.equal(result.errors[0].code, 'smoke_undefined_render_symbol');
  assert.equal(result.errors[0].file, 'src/components/Card.jsx');
});

test('quality review includes smoke render findings', async () => {
  const project = {
    generatedFiles: [
      { path: 'package.json', content: JSON.stringify({ scripts: { dev: 'vite' }, dependencies: { react: '^18.3.1' } }) },
      { path: 'index.html', content: '<div id="root"></div>' },
      { path: 'src/main.jsx', content: "import App from './App.jsx';" },
      { path: 'src/App.jsx', content: 'export default function App(){ return <MissingWidget /> }' }
    ]
  };
  const review = await runQualityReview({ project });
  assert.equal(review.status, 'failed');
  assert.ok(review.findings.some((finding) => finding.category === 'smoke_render'));
  assert.ok(review.staticValidation.smokeRenderTest.errors.length > 0);
});


test('allows named exports for shared component smoke tests', () => {
  const result = runSmokeRenderTests([
    { path: 'src/components/shared/Header.jsx', content: 'export function Header(){ return <header /> }' }
  ]);
  assert.equal(result.passed, true);
});

test('requires default export for page smoke tests', () => {
  const result = runSmokeRenderTests([
    { path: 'src/pages/HomePage.jsx', content: 'export function HomePage(){ return <main /> }' }
  ]);
  assert.equal(result.passed, false);
  assert.equal(result.errors[0].code, 'smoke_missing_default_export');
});




test('repair agent completes omitted generation batch target files', async () => {
  const project = {
    expandedSpec: { projectName: 'Repair App', projectSummary: 'Repair missing css target' },
    blueprint: { routes: [{ path: '/', component: 'HomePage' }], fileList: [] }
  };
  const batch = { batchNumber: 1, agentName: 'Styling Agent', phase: 'page_and_styling', files: ['src/index.css'] };
  const repaired = await repairGenerationBatch({
    project,
    batch,
    generated: { files: [], contracts: [], warnings: [] },
    previousFiles: [],
    contracts: [],
    warnings: [],
    maxAttempts: 3
  });
  assert.ok(repaired.files.some((file) => file.path === 'src/index.css'));
  assert.match(repaired.warnings.join('\n'), /Repair/);
});

test('repairs missing relative route imports before final generation validation', () => {
  const files = repairMissingRelativeImports([
    { path: 'package.json', language: 'json', content: JSON.stringify({ scripts: { dev: 'vite' }, dependencies: { react: '^18.3.1' } }) },
    { path: 'index.html', language: 'html', content: '<div id="root"></div>' },
    { path: 'src/main.jsx', language: 'jsx', content: "import App from './App.jsx';" },
    { path: 'src/App.jsx', language: 'jsx', content: "import AppRoutes from './routes/AppRoutes'; export default function App(){ return <AppRoutes /> }" },
    { path: 'src/pages/HomePage.jsx', language: 'jsx', content: 'export default function HomePage(){ return <main /> }' }
  ]);
  assert.ok(files.some((file) => file.path === 'src/routes/AppRoutes.jsx'));
  assert.doesNotThrow(() => validateGeneratedFiles(files));
});

test('keeps dependency graph synced after generation', async () => {
  const project = {
    expandedSpec: { projectName: 'Graph App', projectSummary: 'Graph test', coreFeatures: ['Dashboard'] },
    blueprint: { routes: [{ path: '/', component: 'HomePage' }], fileList: [] },
    generatedFiles: [],
    generationWarnings: [],
    reviewHistory: [],
    fileSnapshots: [],
    verifiedFixCandidates: [],
    dependencyGraph: {},
    async save() {}
  };
  await generateProjectFiles(project);
  assert.ok(project.dependencyGraph['src/App.jsx']);
  assert.ok(project.dependencyGraph['src/main.jsx']);
  assert.ok(project.dependencyGraph['src/App.jsx'].imports.includes('src/pages/HomePage.jsx'));
});



test('explains a specifically referenced file with function-level detail', async () => {
  const project = {
    generatedFiles: [
      { path: 'src/App.jsx', language: 'jsx', content: "import HomePage from './pages/HomePage.jsx'; function handleCheckout(){ return true; } export default function App(){ return <button onClick={handleCheckout}><HomePage /></button> }" },
      { path: 'src/pages/HomePage.jsx', language: 'jsx', content: 'export default function HomePage(){ return <main /> }' }
    ],
    dependencyGraph: buildDependencyGraph([
      { path: 'src/App.jsx', content: "import HomePage from './pages/HomePage.jsx'; function handleCheckout(){ return true; } export default function App(){ return <button onClick={handleCheckout}><HomePage /></button> }" },
      { path: 'src/pages/HomePage.jsx', content: 'export default function HomePage(){ return <main /> }' }
    ])
  };
  const explanation = await explainProjectQuestion(project, 'explain src/App.jsx in detail');
  assert.equal(explanation.importantFiles[0].path, 'src/App.jsx');
  assert.match(JSON.stringify(explanation), /handleCheckout/);
  assert.ok(explanation.functionDetails.some((item) => item.name === 'handleCheckout'));
});


test('explain agent changes response mode for flow and code requests', async () => {
  const files = [
    { path: 'src/App.jsx', language: 'jsx', content: "import HomePage from './pages/HomePage.jsx'; function handleFilter(){ return true; } export default function App(){ return <HomePage onFilter={handleFilter} /> }" },
    { path: 'src/pages/HomePage.jsx', language: 'jsx', content: 'export default function HomePage(){ return <main /> }' }
  ];
  const project = { generatedFiles: files, dependencyGraph: buildDependencyGraph(files) };
  const flow = await explainProjectQuestion(project, 'create flow for this app');
  const code = await explainProjectQuestion(project, 'explain code in detail');
  assert.equal(flow.mode, 'flow');
  assert.equal(code.mode, 'code');
  assert.match(code.directAnswer, /code-level/);
});

test('classifies direct and conversational edit requests', async () => {
  assert.equal(await routeChatIntent('edit the FAQ'), 'edit');
  assert.equal(await routeChatIntent('Can you modify the FAQ accordion?'), 'edit');
  assert.equal(await routeChatIntent('How does the FAQ work?'), 'explain');
});

test('applies graph-targeted natural language edits with fallback in mock mode', async () => {
  const project = {
    generatedFiles: [
      { path: 'package.json', language: 'json', content: JSON.stringify({ scripts: { dev: 'vite' }, dependencies: { react: '^18.3.1' } }) },
      { path: 'index.html', language: 'html', content: '<div id="root"></div>' },
      { path: 'src/main.jsx', language: 'jsx', content: "import App from './App.jsx';" },
      { path: 'src/App.jsx', language: 'jsx', content: "import HomePage from './pages/HomePage.jsx'; export default function App(){ return <HomePage /> }" },
      { path: 'src/pages/HomePage.jsx', language: 'jsx', content: 'export default function HomePage(){ return <button>Submit</button> }' }
    ],
    dependencyGraph: {
      'src/pages/HomePage.jsx': { importedBy: ['src/App.jsx'], imports: [], renders: [] },
      'src/App.jsx': { importedBy: [], imports: ['src/pages/HomePage.jsx'], renders: ['HomePage'] }
    },
    fileSnapshots: [],
    reviewHistory: [],
    verifiedFixCandidates: [],
    async save() {}
  };
  const result = await applyNaturalLanguageEdit(project, 'change button text to "Buy now"');
  assert.equal(result.status, 'preview_ready');
  assert.match(project.generatedFiles.find((file) => file.path === 'src/pages/HomePage.jsx').content, /Buy now/);
});

test('generation batch repair fixes missing IconComponent before validation can fail', async () => {
  const project = {
    expandedSpec: { projectName: 'Icon Repair App', projectSummary: 'Feature section with icon component' },
    blueprint: { routes: [{ path: '/', component: 'HomePage' }], fileList: [] }
  };
  const batch = { batchNumber: 2, agentName: 'Component Agent', phase: 'component_registry', files: ['src/components/FeaturesSection.jsx'] };
  const repaired = await repairGenerationBatch({
    project,
    batch,
    generated: {
      files: [{ path: 'src/components/FeaturesSection.jsx', language: 'jsx', content: "export default function FeaturesSection(){ return <section><IconComponent className='h-5 w-5' title='Feature' /></section> }" }],
      contracts: [],
      warnings: []
    },
    previousFiles: [],
    contracts: [],
    warnings: [],
    maxAttempts: 1
  });
  const file = repaired.files.find((item) => item.path === 'src/components/FeaturesSection.jsx');
  assert.match(file.content, /function IconComponent/);
  assert.doesNotThrow(() => validateGenerationBatch(repaired.files, batch.files, []));
});
