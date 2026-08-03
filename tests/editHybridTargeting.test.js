import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithRequestLlmContext } from '../context/requestLlmContext.js';
import { applyEditVerification, applyNaturalLanguageEdit } from '../services/edit/editAgent.js';
import { buildEditInteractionIndex, rankInteractionTargets } from '../services/edit/editInteractionIndex.js';
import { resolveEditTargets } from '../services/edit/editTargeting.js';
import { selectSemanticEditTargets } from '../services/edit/intentRouter.js';
import { buildDependencyGraph } from '../services/review/dependencyGraph.js';
import { boundAgentPrompt, MAX_EDIT_PROMPT_CHARS } from '../services/ai/langGraphAgent.js';

const apiKey = 'sk-test-' + 'h'.repeat(32);

function project() {
  const generatedFiles = [
    { path: 'package.json', language: 'json', content: JSON.stringify({ scripts: { dev: 'vite' }, dependencies: { react: '^18.3.1' } }) },
    { path: 'index.html', language: 'html', content: '<div id="root"></div>' },
    { path: 'src/main.jsx', language: 'jsx', content: "import App from './App.jsx'; export default App;" },
    { path: 'src/App.jsx', language: 'jsx', content: "import Home from './pages/Home.jsx'; import Gallery from './pages/Gallery.jsx'; export default function App(){ return <><Home /><Gallery /></> }" },
    { path: 'src/pages/Home.jsx', language: 'jsx', content: "import { Link } from 'react-router-dom'; export default function Home(){ return <Link to='/gallery'>Explore Gallery</Link> }" },
    { path: 'src/pages/Gallery.jsx', language: 'jsx', content: 'export default function Gallery(){ return <main>Gallery</main> }' }
  ];
  return {
    projectId: 'hybrid-edit-project', name: 'Hybrid Edit', qualityMode: 'standard', generatedFiles,
    blueprint: { routes: [{ path: '/', component: 'Home' }, { path: '/gallery', component: 'Gallery' }], fileList: [] },
    dependencyGraph: buildDependencyGraph(generatedFiles), fileSnapshots: [], reviewHistory: [], verifiedFixCandidates: [],
    pendingEditClarification: null, operationStatus: 'preview_ready', async save() {}
  };
}

function mockProvider(factory) {
  const previous = globalThis.fetch;
  const inputs = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const input = String(body.input || '');
    inputs.push(input);
    const output = factory(input, inputs.length);
    return new Response(JSON.stringify({ output_text: typeof output === 'string' ? output : JSON.stringify(output), usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { inputs, restore: () => { globalThis.fetch = previous; } };
}

test('explicit no-clarification survives an ambiguous confidence label and keeps the AST button owner', async () => {
  const value = project();
  const fallback = resolveEditTargets(value, 'gllery button isnotworking');
  const mock = mockProvider(() => ({
    understanding: 'The Gallery button is not working.', scope: 'focused', clarity: 'ambiguous', needsClarification: false,
    clarificationReason: '', clarificationQuestion: '', requestedTargets: ['Gallery button'], targets: ['src/pages/Gallery.jsx'], confidence: 'medium'
  }));
  try {
    const result = await runWithRequestLlmContext({ openAiApiKey: apiKey }, () => selectSemanticEditTargets(value, 'gllery button isnotworking', fallback));
    assert.equal(result.needsClarification, false);
    assert.ok(result.editableTargets.includes('src/pages/Home.jsx'));
    assert.equal(mock.inputs.length, 1);
  } finally { mock.restore(); }
});

test('AST interaction index finds controls declared through configuration arrays', () => {
  const index = buildEditInteractionIndex([{ path: 'src/components/Nav.jsx', content: "const actions=[{label:'Open Gallery',path:'/gallery'}]; export default function Nav(){ return actions.map((item)=><button>{item.label}</button>) }" }]);
  const ranked = rankInteractionTargets(index, 'gllery control does not open');
  assert.equal(ranked[0].path, 'src/components/Nav.jsx');
  assert.ok(ranked[0].interactions.routes.includes('/gallery'));
});

test('a specifically named new page is creatable without asking whether it exists', () => {
  const result = resolveEditTargets(project(), 'Add a pricing page');
  assert.equal(result.creationIntent, true);
  assert.deepEqual(result.creatableFiles, ['src/pages/Pricing.jsx']);
  assert.equal(result.requestedRoute, '/pricing');
});

test('a named new page is created together with its integration file', async () => {
  const value = project();
  const mock = mockProvider((input) => {
    if (input.includes('semantic scope and file-selection agent')) return { understanding: 'Create Pricing page', scope: 'create', clarity: 'clear', needsClarification: false, targets: ['src/App.jsx'], confidence: 'high' };
    return {
      changes: [
        { operation: 'create', path: 'src/pages/Pricing.jsx', content: 'export default function Pricing(){ return <main><h1>Pricing</h1></main> }', reason: 'Created Pricing page' },
        { operation: 'update', path: 'src/App.jsx', content: "import Home from './pages/Home.jsx'; import Gallery from './pages/Gallery.jsx'; import Pricing from './pages/Pricing.jsx'; export default function App(){ return <><Home /><Gallery /><Pricing /></> }", reason: 'Integrated Pricing page' }
      ],
      warnings: []
    };
  });
  try {
    const result = await runWithRequestLlmContext({ openAiApiKey: apiKey }, () => applyNaturalLanguageEdit(value, 'Add a pricing page'));
    assert.equal(result.status, 'edit_verification_pending');
    assert.ok(value.generatedFiles.some((file) => file.path === 'src/pages/Pricing.jsx'));
    assert.match(value.generatedFiles.find((file) => file.path === 'src/App.jsx').content, /Pricing/);
  } finally { mock.restore(); }
});

test('invalid edit output is retried with validation feedback before anything is saved', async () => {
  const value = project();
  let editAttempt = 0;
  const mock = mockProvider((input) => {
    if (input.includes('semantic scope and file-selection agent')) return { understanding: 'Change Home heading', scope: 'focused', clarity: 'clear', needsClarification: false, targets: ['src/pages/Home.jsx'], confidence: 'high' };
    editAttempt += 1;
    return editAttempt === 1
      ? { changes: [{ operation: 'update', path: 'src/pages/Home.jsx', content: "import { Link } from 'react-router-dom'; export const Home = () => <Link to='/gallery'>Broken Gallery</Link>", reason: 'First attempt' }], warnings: [] }
      : { changes: [{ operation: 'update', path: 'src/pages/Home.jsx', content: "import { Link } from 'react-router-dom'; export default function Home(){ return <Link to='/gallery'>Corrected Gallery</Link> }", reason: 'Corrected export' }], warnings: [] };
  });
  try {
    const result = await runWithRequestLlmContext({ openAiApiKey: apiKey }, () => applyNaturalLanguageEdit(value, 'Change the Home heading'));
    assert.equal(result.status, 'edit_verification_pending');
    assert.equal(editAttempt, 2);
    assert.match(value.generatedFiles.find((file) => file.path === 'src/pages/Home.jsx').content, /Corrected/);
    assert.ok(mock.inputs.some((input) => input.includes('Previous edit failed validation')));
    const verified = applyEditVerification(value, { buildPassed: true, previewPassed: true, changedFiles: result.changes.map((change) => change.path) });
    assert.equal(verified.status, 'passed');
    assert.equal(value.operationStatus, 'preview_ready');
  } finally { mock.restore(); }
});

test('failed browser verification restores the snapshot instead of keeping an invalid edit', () => {
  const value = project();
  const original = value.generatedFiles.map((file) => ({ ...file }));
  value.fileSnapshots.push({ snapshotId: 'before-edit', operationType: 'edit', files: original });
  value.generatedFiles = value.generatedFiles.map((file) => file.path === 'src/pages/Home.jsx' ? { ...file, content: 'broken edit' } : file);
  value.lastChangedFiles = ['src/pages/Home.jsx'];
  value.operationStatus = 'edit_verification_pending';
  const result = applyEditVerification(value, { buildPassed: false, previewPassed: false, changedFiles: ['src/pages/Home.jsx'], error: 'Vite build failed' });
  assert.equal(result.status, 'failed');
  assert.equal(result.rolledBack, true);
  assert.match(value.generatedFiles.find((file) => file.path === 'src/pages/Home.jsx').content, /Explore Gallery/);
  assert.equal(value.operationStatus, 'edit_verification_failed');
});

test('complete edit prompts are capped after assembly', () => {
  const prompt = boundAgentPrompt('edit', 'x'.repeat(90_000));
  assert.equal(prompt.length, MAX_EDIT_PROMPT_CHARS);
  assert.match(prompt, /Optional trailing context removed/);
});
