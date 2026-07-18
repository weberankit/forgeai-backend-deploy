import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProjectSymbols } from '../services/review/symbolValidation.js';
import { runDeterministicRepairs } from '../services/generation/deterministicRepair.js';
import { assertDisjointWriteSets, buildProjectManifest } from '../services/generation/projectManifest.js';
import { buildGenerationBatches } from '../services/generation/generationBatches.js';
import { expandSpecification, planFrontendProject } from '../services/ai/aiClient.js';

test('deterministically removes duplicate declarations and redundant named exports', () => {
  const source = "export const categories = [];\nexport const categories = [];\nexport { categories };\n";
  const result = runDeterministicRepairs([], [{ path: 'src/data/mockData.js', content: source }], null);
  assert.equal((result.files[0].content.match(/const categories/g) || []).length, 1);
  assert.equal(validateProjectSymbols(result.files).passed, true);
  assert.ok(result.repairs.some((repair) => repair.code === 'DUPLICATE_DECLARATION'));
  assert.ok(result.repairs.some((repair) => repair.code === 'DUPLICATE_NAMED_EXPORT'));
});

test('symbol validation detects named/default mismatch and undefined JSX components', () => {
  const result = validateProjectSymbols([
    { path: 'src/data/mockData.js', content: 'export default [];\n' },
    { path: 'src/pages/HomePage.jsx', content: "import { categories } from '../data/mockData'; export default function HomePage(){ return <MissingCard items={categories} /> }" }
  ]);
  assert.ok(result.errors.some((error) => error.code === 'MISSING_NAMED_EXPORT' && error.symbol === 'categories'));
  assert.ok(result.errors.some((error) => error.code === 'UNDEFINED_RENDERED_COMPONENT' && error.symbol === 'MissingCard'));
});

test('deterministic path repair uses only one unambiguous generated target', () => {
  const result = runDeterministicRepairs([], [
    { path: 'src/components/Card.jsx', content: 'export default function Card(){ return <div /> }' },
    { path: 'src/pages/HomePage.jsx', content: "import Card from '../wrong/Card'; export default function HomePage(){ return <Card /> }" }
  ], null);
  assert.match(result.files.find((file) => file.path === 'src/pages/HomePage.jsx').content, /\.\.\/components\/Card/);
  assert.equal(result.validation.passed, true);
});

test('manifest gives each generated path one owner and parallel writes cannot overlap', () => {
  const batches = buildGenerationBatches({ fileList: [{ path: 'src/hooks/useTheme.js', dependsOn: [] }] });
  const manifest = buildProjectManifest({}, batches);
  assert.equal(manifest.files['src/hooks/useTheme.js'].owner, 'Component Agent');
  assert.throws(() => assertDisjointWriteSets([
    { agentName: 'Page Agent', files: ['src/shared.js'] },
    { agentName: 'Styling Agent', files: ['src/shared.js'] }
  ]), /Parallel write-set conflict/);
});

test('ambiguous relative paths are not guessed by deterministic repair', () => {
  const original = "import Card from '../wrong/Card'; export default function HomePage(){ return <Card /> }";
  const result = runDeterministicRepairs([], [
    { path: 'src/components/Card.jsx', content: 'export default function Card(){ return <div /> }' },
    { path: 'src/features/Card.jsx', content: 'export default function Card(){ return <div /> }' },
    { path: 'src/pages/HomePage.jsx', content: original }
  ], null);
  assert.equal(result.files.find((file) => file.path === 'src/pages/HomePage.jsx').content, original);
  assert.ok(result.validation.errors.some((error) => error.code === 'MISSING_RELATIVE_MODULE'));
});


test('prompt-aware fallback blueprint preserves requested landing-page features and runnable App path', async () => {
  const previousProvider = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = 'mock';
  const spec = await expandSpecification({ prompt: 'Build a SaaS landing page with pricing FAQ and contact sections' });
  const blueprint = await planFrontendProject({ specification: spec });
  assert.equal(spec.routes[0].component, 'LandingPage');
  assert.ok(spec.coreFeatures.some((feature) => /pricing/i.test(feature)));
  assert.ok(spec.coreFeatures.some((feature) => /faq/i.test(feature)));
  assert.ok(blueprint.fileList.some((file) => file.path === 'src/App.jsx'));
  assert.equal(blueprint.fileList.some((file) => file.path === 'src/app/App.jsx'), false);
  assert.ok(blueprint.fileList.some((file) => file.path === 'src/pages/LandingPage.jsx'));
  assert.equal(blueprint.routes[0].path, '/');
  if (previousProvider === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = previousProvider;
});
