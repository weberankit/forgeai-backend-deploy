import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProjectSymbols } from '../services/review/symbolValidation.js';
import { runDeterministicRepairs } from '../services/generation/deterministicRepair.js';
import { assertDisjointWriteSets, buildProjectManifest } from '../services/generation/projectManifest.js';
import { buildAgentExecutionStages, buildGenerationBatches } from '../services/generation/generationBatches.js';
import { validateGenerationBatch } from '../services/generation/generatedFileValidation.js';
import { validateRouteIntegration } from '../services/review/routeValidation.js';
import { runSmokeRenderTests } from '../services/review/testingAgent.js';
import { expandSpecification, planFrontendProject } from '../services/ai/aiClient.js';
import { buildCodeGenerationPrompt } from '../services/ai/prompts/codeGenerationPrompt.js';
import { buildExpansionPrompt } from '../services/ai/prompts/expansionPrompt.js';
import { buildPlanningPrompt } from '../services/ai/prompts/planningPrompt.js';
import { validateBlueprint, validateExpansionSpec } from '../services/ai/parseStructuredResponse.js';

test('code generation prompt preserves the standard implementation workflow', () => {
  const prompt = buildCodeGenerationPrompt({
    specification: {}, blueprint: {}, previousFiles: [], targetFiles: ['src/App.jsx'], contracts: [], warnings: [], dependencyContext: {}
  });
  assert.match(prompt, /STANDARD IMPLEMENTATION WORKFLOW/);
  assert.match(prompt, /1\. ARCHITECTURE LOCK/);
  assert.match(prompt, /2\. DEPENDENCY RESOLUTION/);
  assert.match(prompt, /3\. PROVIDER\/CONTEXT CHECK/);
  assert.match(prompt, /4\. COMPLETENESS CHECK/);
  assert.match(prompt, /ScrollRestoration/);
  assert.match(prompt, /only the final JSON output should be returned/);
  assert.match(prompt, /dependency list is locked/);
  assert.doesNotMatch(prompt, /You may add a browser-compatible npm dependency/);
});

test('expansion prompt always asks at least one useful initial clarification', () => {
  const prompt = buildExpansionPrompt({ prompt: 'Build a customer portal.' });
  assert.match(prompt, /blockingQuestions must contain at least one concise, useful product or UX clarification question/);
  assert.match(prompt, /never return an empty list, even when reasonable defaults exist/);
  assert.match(prompt, /Include every additional question that would materially help shape/);
  assert.match(prompt, /return blockingQuestions as an empty array so planning can continue/);
});

test('planning prompt keeps npm packages outside the internal file dependency graph', () => {
  const prompt = buildPlanningPrompt({ specification: {}, clarification: '' });
  assert.match(prompt, /imports and dependsOn must contain only exact internal generated-file paths/);
  assert.match(prompt, /Never put react, react-dom, react-router-dom, lucide-react/);
  assert.match(prompt, /List npm packages only in requiredDependencies/);
});

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

test('symbol and smoke validation accept JSX components bound through aliased props or local scope', () => {
  const files = [
    { path: 'src/components/DataCard.jsx', content: "export default function DataCard({ icon: Icon }) { return <Icon aria-hidden='true' />; }" },
    { path: 'src/components/IconList.jsx', content: "export default function IconList({ items }) { return items.map((item) => { const Icon = item.icon; return <Icon key={item.id} />; }); }" }
  ];
  assert.equal(validateProjectSymbols(files).passed, true);
  assert.equal(runSmokeRenderTests(files).passed, true);
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

test('batch validation scopes errors to generated targets and allows staged sibling context', () => {
  const existing = [
    { path: 'src/pages/BrokenPeer.jsx', content: "import Missing from '../components/Missing.jsx'; export default function BrokenPeer(){ return <Missing /> }" },
    { path: 'src/pages/HomePage.css', content: '.home { color: inherit; }' }
  ];
  assert.doesNotThrow(() => validateGenerationBatch([
    { path: 'src/pages/HomePage.jsx', language: 'jsx', content: "import './HomePage.css'; export default function HomePage(){ return <main className='home' /> }" }
  ], ['src/pages/HomePage.jsx'], existing));
  assert.throws(() => validateGenerationBatch([
    { path: 'src/pages/HomePage.jsx', language: 'jsx', content: "import Missing from '../components/Missing.jsx'; export default function HomePage(){ return <Missing /> }" }
  ], ['src/pages/HomePage.jsx'], existing), /Relative imports? do(?:es)? not resolve|Missing relative import/);
});

test('component batches are split into parallelizable chunks for faster multi-agent generation', () => {
  const fileList = Array.from({ length: 13 }, (_, index) => ({ path: 'src/components/Widget' + index + '.jsx', dependsOn: [] }));
  const batches = buildGenerationBatches({ routes: [{ path: '/', component: 'HomePage' }], fileList });
  const stages = buildAgentExecutionStages(batches);
  const componentStage = stages.find((stage) => stage.batches.filter((batch) => batch.agentName === 'Component Agent').length >= 3);
  assert.equal(componentStage.parallel, true);
  const componentBatches = componentStage.batches.filter((batch) => batch.agentName === 'Component Agent');
  assert.ok(componentBatches.length >= 3);
  assert.ok(componentBatches.every((batch) => batch.files.length <= 6));
});

test('blueprint contract rejects missing files and dependency cycles before generation', () => {
  const base = {
    stackManifest: {
      router: { mode: 'browser_router', ownerFile: 'src/App.jsx' },
      state: { mode: 'react_local_state', ownerFile: null },
      styling: { mode: 'tailwind', ownerFile: 'src/index.css' },
      dataFetching: { mode: 'local_mock_data', ownerFile: null },
      providers: []
    },
    requiredDependencies: [], folderStructure: [], routes: [{ path: '/', component: 'HomePage' }], reduxSlices: [], sharedComponentContracts: [], mockDataRequirements: [], localStorageBehavior: [], implementationPhases: [], acceptanceCriteria: []
  };
  const contract = (path, dependsOn = []) => ({ path, responsibility: path, dependsOn, imports: [], exports: ['default'], consumers: [], props: [], providerRequirements: [] });
  assert.equal(validateBlueprint({ ...base, fileList: [contract('src/pages/HomePage.jsx', ['src/components/Missing.jsx'])] }).valid, false);
  assert.match(validateBlueprint({ ...base, fileList: [contract('src/pages/HomePage.jsx', ['src/App.jsx']), contract('src/App.jsx', ['src/pages/HomePage.jsx'])] }).message, /circular blueprint dependency/);
});

test('expansion contract requires pages and routes to remain synchronized', () => {
  const result = validateExpansionSpec({ projectName: 'Test', projectSummary: 'Test', targetUsers: [], pages: [{ name: 'Home', route: '/' }], routes: [{ path: '/different', component: 'HomePage' }], sharedComponents: [], coreFeatures: [], dataRequirements: [], reduxRequirements: [], localStorageRequirements: [], responsiveRequirements: [], accessibilityRequirements: [], designDirection: [], assumptions: [], blockingQuestions: [] });
  assert.equal(result.valid, false);
  assert.match(result.message, /same route paths/);
});

test('deterministic repair rewrites default data import when previous module only has a named export', () => {
  const result = runDeterministicRepairs([
    { path: 'src/data/categories.js', content: "export const categories = ['Fiction', 'History'];\n" }
  ], [
    { path: 'src/components/CategoryFilter.jsx', content: "import categories from '../data/categories.js'; export default function CategoryFilter(){ return <select>{categories.map((category) => <option key={category}>{category}</option>)}</select> }" }
  ]);
  const filter = result.files.find((file) => file.path === 'src/components/CategoryFilter.jsx');
  assert.match(filter.content, /import \{ categories \} from '\.\.\/data\/categories\.js';/);
  assert.equal(result.validation.passed, true);
});

test('deterministic repair adds default export when generated data module is imported as default', () => {
  const result = runDeterministicRepairs([], [
    { path: 'src/data/categories.js', content: "export const categories = ['Fiction', 'History'];\n" },
    { path: 'src/components/CategoryFilter.jsx', content: "import categories from '../data/categories.js'; export default function CategoryFilter(){ return <select>{categories.map((category) => <option key={category}>{category}</option>)}</select> }" }
  ]);
  const data = result.files.find((file) => file.path === 'src/data/categories.js');
  assert.match(data.content, /export default categories;/);
  assert.equal(result.validation.passed, true);
});

test('deterministic repair aligns named component import to default export', () => {
  const result = runDeterministicRepairs([
    { path: 'src/components/BookCard.jsx', content: 'export default function BookCard(){ return <article /> }\n' }
  ], [
    { path: 'src/pages/LandingPage.jsx', content: "import { BookCard } from '../components/BookCard.jsx'; export default function LandingPage(){ return <BookCard /> }" }
  ]);
  const page = result.files.find((file) => file.path === 'src/pages/LandingPage.jsx');
  assert.match(page.content, /import BookCard from '\.\.\/components\/BookCard\.jsx';/);
  assert.equal(result.validation.passed, true);
});

test('manifest contract repairs and enforces a page default export before integration', () => {
  const manifest = { files: { 'src/pages/LandingPage.jsx': { expectedExports: ['default'] } } };
  const namedOnly = [{ path: 'src/pages/LandingPage.jsx', language: 'jsx', content: 'export function LandingPage(){ return <main />; }' }];
  assert.throws(() => validateGenerationBatch(namedOnly, ['src/pages/LandingPage.jsx'], [], manifest), /planned default export/);
  const repaired = runDeterministicRepairs([], namedOnly, manifest);
  assert.match(repaired.files[0].content, /export default LandingPage;/);
  assert.doesNotThrow(() => validateGenerationBatch(repaired.files, ['src/pages/LandingPage.jsx'], [], manifest));
});

test('prompt-aware fallback treats selling books as a bookstore landing page', async () => {
  const previousProvider = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = 'mock';
  const spec = await expandSpecification({ prompt: 'Create a landing page for selling books' });
  const blueprint = await planFrontendProject({ specification: spec });
  assert.equal(spec.routes[0].component, 'LandingPage');
  assert.ok(spec.coreFeatures.some((feature) => /book|catalog/i.test(feature)));
  assert.ok(spec.sharedComponents.some((component) => /CategoryFilter|FeaturedBooks/i.test(component)));
  assert.ok(blueprint.fileList.some((file) => file.path === 'src/pages/LandingPage.jsx'));
  if (previousProvider === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = previousProvider;
});

test('route validation does not fail shared header navigation before App routes exist', () => {
  const result = validateRouteIntegration([
    { path: 'src/components/Header.jsx', content: "import { Link } from 'react-router-dom'; const navigation = [{ label: 'Home', path: '/' }]; export default function Header(){ return <header><Link to='/'>Home</Link></header> }" }
  ]);
  assert.equal(result.passed, true);
  assert.equal(result.skippedNavigationValidation, true);
});

test('route validation deduplicates repeated unregistered navigation errors once routes exist', () => {
  const result = validateRouteIntegration([
    { path: 'src/App.jsx', content: "import { Route, Routes } from 'react-router-dom'; function CatalogPage(){ return <main /> } export default function App(){ return <Routes><Route path='/catalog' element={<CatalogPage />} /></Routes> }" },
    { path: 'src/components/Header.jsx', content: "import { Link } from 'react-router-dom'; const navigation = [{ label: 'Home', path: '/' }]; export default function Header(){ return <header><Link to='/'>Home</Link></header> }" }
  ]);
  assert.equal(result.errors.filter((error) => error.code === 'unregistered_navigation' && /: \/$/.test(error.message)).length, 1);
});

test('deterministic repair adds root route when generated navigation links to root', () => {
  const result = runDeterministicRepairs([], [
    { path: 'src/App.jsx', content: "import { Route, Routes } from 'react-router-dom'; function CatalogPage(){ return <main /> } export default function App(){ return <Routes><Route path='/catalog' element={<CatalogPage />} /></Routes> }" },
    { path: 'src/components/Header.jsx', content: "import { Link } from 'react-router-dom'; const navigation = [{ label: 'Home', path: '/' }]; export default function Header(){ return <header><Link to='/'>Home</Link></header> }" }
  ]);
  const app = result.files.find((file) => file.path === 'src/App.jsx');
  assert.match(app.content, /<Route path="\/" element=\{<CatalogPage \/>\}/);
  assert.equal(validateRouteIntegration(result.files).passed, true);
  assert.ok(result.repairs.some((repair) => repair.code === 'MISSING_ROOT_ROUTE'));
});

test('deterministic repair defines missing IconComponent rendered by generated feature sections', () => {
  const result = runDeterministicRepairs([], [
    { path: 'src/components/FeaturesSection.jsx', content: "export default function FeaturesSection(){ return <section><IconComponent className='h-5 w-5' title='Feature' /></section> }" }
  ]);
  const file = result.files.find((item) => item.path === 'src/components/FeaturesSection.jsx');
  assert.match(file.content, /function IconComponent/);
  assert.equal(validateProjectSymbols(result.files).passed, true);
  assert.ok(result.repairs.some((repair) => repair.code === 'UNDEFINED_RENDERED_COMPONENT' && repair.file === 'src/components/FeaturesSection.jsx'));
});

test('deterministic repair defines generic missing rendered components without hiding imported components', () => {
  const result = runDeterministicRepairs([], [
    { path: 'src/components/FeatureGrid.jsx', content: "import ExistingCard from './ExistingCard.jsx'; export default function FeatureGrid(){ return <div><ExistingCard /><FeatureCard title='Fast' /></div> }" },
    { path: 'src/components/ExistingCard.jsx', content: "export default function ExistingCard(){ return <article /> }" }
  ]);
  const file = result.files.find((item) => item.path === 'src/components/FeatureGrid.jsx');
  assert.match(file.content, /function FeatureCard/);
  assert.doesNotMatch(file.content, /function ExistingCard/);
  assert.equal(validateProjectSymbols(result.files).passed, true);
});

test('deterministic repair removes duplicate Redux action exports from destructured cart slice actions', () => {
  const source = `
import { createSlice } from '@reduxjs/toolkit';

const cartSlice = createSlice({
  name: 'cart',
  initialState: { items: [] },
  reducers: {
    addItem(state, action) { state.items.push(action.payload); },
    updateQuantity(state) { return state; },
    removeItem(state) { return state; },
    clearCart(state) { state.items = []; }
  }
});

export const { clearCart, addItem, updateQuantity, removeItem } = cartSlice.actions;
export default cartSlice.reducer;
export { clearCart };
export { addItem };
export { updateQuantity };
export { removeItem };
`;
  const result = runDeterministicRepairs([], [{ path: 'src/redux/cartSlice.js', content: source }]);
  const file = result.files.find((item) => item.path === 'src/redux/cartSlice.js');
  assert.equal((file.content.match(/export \{ clearCart \}/g) || []).length, 0);
  assert.equal((file.content.match(/export \{ addItem \}/g) || []).length, 0);
  assert.equal((file.content.match(/export \{ updateQuantity \}/g) || []).length, 0);
  assert.equal((file.content.match(/export \{ removeItem \}/g) || []).length, 0);
  assert.equal(validateProjectSymbols(result.files).passed, true);
  assert.ok(result.repairs.some((repair) => repair.code === 'DUPLICATE_NAMED_EXPORT'));
});

test('deterministic repair removes duplicate selector declarations with same name', () => {
  const source = `
export const selectSelectedBatDetailsSelector = (state) => state.bats.selected;
export const selectSelectedBatDetailsSelector = (state) => state.bats.selectedDetails;
export const selectOtherBatSelector = (state) => state.bats.other;
`;
  const result = runDeterministicRepairs([], [{ path: 'src/redux/batSlice.js', content: source }]);
  const file = result.files.find((item) => item.path === 'src/redux/batSlice.js');
  assert.equal((file.content.match(/export const selectSelectedBatDetailsSelector/g) || []).length, 1);
  assert.equal((file.content.match(/selectOtherBatSelector/g) || []).length, 1);
  assert.equal(validateProjectSymbols(result.files).passed, true);
  assert.ok(result.repairs.some((repair) => repair.code === 'DUPLICATE_DECLARATION'));
});
