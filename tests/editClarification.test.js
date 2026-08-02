import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithRequestLlmContext } from '../context/requestLlmContext.js';
import { applyNaturalLanguageEdit } from '../services/edit/editAgent.js';
import { selectSemanticEditTargets } from '../services/edit/intentRouter.js';

const apiKey = 'sk-test-' + 'c'.repeat(32);

function generatedProject(overrides = {}) {
  return {
    projectId: 'edit-clarification-project',
    name: 'Clarification Test',
    generatedFiles: [
      { path: 'package.json', language: 'json', content: JSON.stringify({ scripts: { dev: 'vite' }, dependencies: { react: '^18.3.1' } }) },
      { path: 'index.html', language: 'html', content: '<div id="root"></div>' },
      { path: 'src/main.jsx', language: 'jsx', content: "import App from './App.jsx';" },
      { path: 'src/App.jsx', language: 'jsx', content: "import Home from './pages/Home.jsx'; export default function App(){ return <Home /> }" },
      { path: 'src/pages/Home.jsx', language: 'jsx', content: 'export default function Home(){ return <main><h1>Welcome</h1></main> }' }
    ],
    blueprint: {
      routes: [{ path: '/', component: 'Home' }],
      fileList: [{ path: 'src/pages/Home.jsx', responsibility: 'Render the Home page' }]
    },
    dependencyGraph: {},
    fileSnapshots: [],
    reviewHistory: [],
    verifiedFixCandidates: [],
    operationStatus: 'preview_ready',
    pendingEditClarification: null,
    async save() {},
    ...overrides
  };
}

function mockOpenAi(outputFactory) {
  const previousFetch = globalThis.fetch;
  const inputs = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    inputs.push(String(body.input || ''));
    const output = outputFactory(inputs.at(-1), inputs.length);
    return new Response(JSON.stringify({
      output_text: typeof output === 'string' ? output : JSON.stringify(output),
      usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { inputs, restore: () => { globalThis.fetch = previousFetch; } };
}

test('semantic edit classifier asks a useful question for a broad ambiguous request', async () => {
  const mock = mockOpenAi(() => ({
    understanding: 'The user wants all pages improved but did not provide a concrete design goal.',
    scope: 'whole_project',
    clarity: 'ambiguous',
    needsClarification: true,
    clarificationReason: 'request_too_broad',
    clarificationQuestion: 'Which page should I improve first, and should I focus on styling, layout, content, or mobile responsiveness?',
    requestedTargets: ['all pages'],
    targets: [],
    confidence: 'high'
  }));
  try {
    const result = await runWithRequestLlmContext({ openAiApiKey: apiKey }, () => selectSemanticEditTargets(
      generatedProject(),
      'fix whole pages all ui/ux',
      { targets: ['src/pages/Home.jsx'], confidence: 'low' }
    ));
    assert.equal(result.needsClarification, true);
    assert.equal(result.scope, 'whole_project');
    assert.deepEqual(result.targets, []);
    assert.match(result.clarificationQuestion, /Which page/i);
  } finally {
    mock.restore();
  }
});

test('semantic edit classifier asks before creating a requested page that is missing', async () => {
  const mock = mockOpenAi(() => ({
    understanding: 'The requested Pricing page is not present in the project catalog.',
    scope: 'missing_target',
    clarity: 'ambiguous',
    needsClarification: true,
    clarificationReason: 'target_missing',
    clarificationQuestion: 'The project does not have a Pricing page. Should I create it and add it to the navigation?',
    requestedTargets: ['Pricing page'],
    targets: [],
    confidence: 'high'
  }));
  try {
    const result = await runWithRequestLlmContext({ openAiApiKey: apiKey }, () => selectSemanticEditTargets(
      generatedProject(),
      'edit the Pricing page',
      { targets: ['src/pages/Home.jsx'], confidence: 'low' }
    ));
    assert.equal(result.needsClarification, true);
    assert.equal(result.scope, 'missing_target');
    assert.match(result.clarificationQuestion, /create it/i);
  } finally {
    mock.restore();
  }
});

test('failed edit retries return a safe question and preserve clarification context', async () => {
  const project = generatedProject({
    pendingEditClarification: {
      originalRequest: 'Improve all pages',
      question: 'Which page should I improve first and what should change?'
    }
  });
  const mock = mockOpenAi((input) => {
    if (input.includes('semantic scope and file-selection agent')) {
      return {
        understanding: 'Improve the Home page layout and visual hierarchy.',
        scope: 'focused',
        clarity: 'clear',
        needsClarification: false,
        clarificationReason: '',
        clarificationQuestion: '',
        requestedTargets: ['Home page'],
        targets: ['src/pages/Home.jsx'],
        confidence: 'high'
      };
    }
    return '{"changes":[';
  });
  try {
    const result = await runWithRequestLlmContext({ openAiApiKey: apiKey }, () => applyNaturalLanguageEdit(
      project,
      'Start with the Home page layout and visual hierarchy'
    ));
    assert.equal(result.status, 'needs_clarification');
    assert.equal(result.reason, 'edit_generation_failed');
    assert.doesNotMatch(result.clarification, /invalid JSON|provider|LLM/i);
    assert.match(result.clarification, /Home\.jsx|Home page/i);
    assert.equal(project.pendingEditClarification.originalRequest, 'Improve all pages');
    assert.ok(mock.inputs.some((input) => input.includes('Original edit request: Improve all pages')));
    assert.equal(mock.inputs.filter((input) => input.includes('You are an Edit Agent')).length, 2);
  } finally {
    mock.restore();
  }
});

test('a clarification answer is combined with the original request and applied', async () => {
  const project = generatedProject({
    pendingEditClarification: {
      originalRequest: 'Improve all pages',
      question: 'Which page should I improve first and what should change?'
    }
  });
  const mock = mockOpenAi((input) => {
    if (input.includes('semantic scope and file-selection agent')) {
      return {
        understanding: 'Modernize the Home page typography.',
        scope: 'focused',
        clarity: 'clear',
        needsClarification: false,
        clarificationReason: '',
        clarificationQuestion: '',
        requestedTargets: ['Home page'],
        targets: ['src/pages/Home.jsx'],
        confidence: 'high'
      };
    }
    return {
      changes: [{
        operation: 'update',
        path: 'src/pages/Home.jsx',
        content: 'export default function Home(){ return <main><h1 className="text-5xl font-bold">Welcome</h1></main> }',
        reason: 'Modernized the Home page typography.'
      }],
      warnings: []
    };
  });
  try {
    const result = await runWithRequestLlmContext({ openAiApiKey: apiKey }, () => applyNaturalLanguageEdit(
      project,
      'Start with the Home page and modernize its typography'
    ));
    assert.equal(result.status, 'preview_ready');
    assert.equal(project.pendingEditClarification, null);
    assert.match(project.generatedFiles.find((file) => file.path === 'src/pages/Home.jsx').content, /text-5xl/);
    assert.match(project.lastEditMessage, /Original edit request: Improve all pages/);
  } finally {
    mock.restore();
  }
});
