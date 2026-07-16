import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProjectPath } from '../services/generation/pathSafety.js';
import { topologicalSortFiles } from '../services/generation/topologicalSort.js';
import { buildDependencyGraph } from '../services/review/dependencyGraph.js';
import { resolveEditTargets } from '../services/edit/editTargeting.js';
import { buildErrorSignature } from '../services/memory/verifiedFixMemory.js';

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
