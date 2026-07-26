import { runExpansionGraph, runPlanningGraph } from './langGraphAgent.js';

export async function expandSpecification({ prompt, imageDescription, websiteContext, onToken }) {
  return runExpansionGraph({
    prompt,
    imageDescription,
    websiteContext,
    fallback: mockExpansion(prompt, imageDescription, websiteContext),
    onToken
  });
}

export async function planFrontendProject({ specification, clarification, onToken }) {
  const planned = await runPlanningGraph({ specification, clarification, fallback: mockBlueprint(specification), onToken });
  return normalizeBlueprint(planned, specification);
}

function titleFromPrompt(prompt) {
  const cleaned = String(prompt || '').replace(/build|create|make|frontend|react|application|app/gi, '').trim();
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 5);
  return words.length ? words.map((word) => word[0]?.toUpperCase() + word.slice(1)).join(' ') : 'Frontend Project';
}

function mockExpansion(prompt, imageDescription, websiteContext) {
  const lower = String(prompt || '').toLowerCase();
  const projectName = titleFromPrompt(prompt);
  const domain = websiteContext?.pages?.length ? inferWebsiteDomain(websiteContext) : inferDomain(lower);
  return {
    projectName,
    projectSummary: 'A frontend-only React application for: ' + prompt,
    targetUsers: domain.targetUsers,
    pages: domain.routes.map((route) => ({ name: route.component.replace(/Page$/, ''), route: route.path, purpose: route.purpose })),
    routes: domain.routes.map(({ path, component }) => ({ path, component })),
    sharedComponents: domain.components,
    coreFeatures: domain.features,
    dataRequirements: ['Use realistic local mock data for ' + projectName, 'No generated backend or database'],
    reduxRequirements: ['Use shared state only when multiple screens need the same interactive data'],
    localStorageRequirements: ['Persist useful user preferences and draft UI state'],
    responsiveRequirements: ['Mobile-first layout', 'Usable tablet and desktop layouts', 'Touch-friendly controls'],
    accessibilityRequirements: ['Semantic landmarks', 'Keyboard accessible controls', 'Visible focus states', 'Accessible form labels'],
    designDirection: [domain.design, 'Polished production-quality spacing and typography', imageDescription ? 'Reflect the uploaded reference image' : 'Derive a coherent visual system from the request'],
    assumptions: [
      'The generated app is frontend-only',
      'External services are represented by safe browser mocks',
      ...(websiteContext ? ['Selected website pages are used in ' + websiteContext.mode + ' mode.'] : [])
    ],
    blockingQuestions: []
  };
}

function inferWebsiteDomain(websiteContext) {
  const routes = [...new Map(websiteContext.pages.map((page, index) => {
    const rawPath = new URL(page.url).pathname || '/';
    const path = rawPath === '/' ? '/' : rawPath.replace(/\/+$/, '');
    const name = path === '/'
      ? 'HomePage'
      : path.split('/').filter(Boolean).map((part) => part.replace(/[^a-z0-9]+/gi, ' ').split(' ').filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join('')).join('') + 'Page';
    return [path, { path, component: name, purpose: page.title || 'Recreate selected website page ' + (index + 1) }];
  })).values()];
  return {
    targetUsers: ['Visitors of the referenced website experience'],
    routes,
    components: ['AppShell', 'SiteHeader', 'ResponsiveNavigation', 'ContentSection', 'SiteFooter'],
    features: ['Selected page navigation', 'Responsive cloned layouts', 'Reference-derived content sections'],
    design: websiteContext.mode === 'reference'
      ? 'A distinct visual system inspired by the selected website pages'
      : 'A close visual and structural recreation of the selected website pages'
  };
}

function inferDomain(prompt) {
  if (/book|bookstore|novel|author|reading|library|sell.*book|book.*sell/.test(prompt)) return {
    targetUsers: ['Book buyers', 'Readers', 'Collectors'],
    routes: [{ path: '/', component: 'LandingPage', purpose: 'Bookstore landing and purchase discovery' }],
    components: ['Navbar', 'BookHero', 'FeaturedBooks', 'CategoryFilter', 'AuthorSpotlight', 'Testimonials', 'NewsletterSignup', 'Footer'],
    features: ['Bookstore hero call to action', 'Featured book catalog', 'Category filtering', 'Author spotlight', 'Reader testimonials', 'Newsletter signup'],
    design: 'Warm editorial bookstore landing page focused on selling books'
  };
  if (/landing|saas|marketing|pricing/.test(prompt)) return {
    targetUsers: ['Prospective customers', 'Product buyers'],
    routes: [{ path: '/', component: 'LandingPage', purpose: 'Marketing landing experience' }],
    components: ['Navbar', 'Hero', 'FeatureGrid', 'PricingSection', 'FAQSection', 'ContactSection', 'Footer'],
    features: ['Hero call to action', 'Feature presentation', 'Pricing plans', 'FAQ accordion', 'Contact form'],
    design: 'High-conversion modern landing page'
  };
  if (/kanban|task|project management|trello/.test(prompt)) return {
    targetUsers: ['Project teams', 'Task owners'],
    routes: [{ path: '/', component: 'BoardPage', purpose: 'Interactive task board' }, { path: '/settings', component: 'SettingsPage', purpose: 'Board preferences' }],
    components: ['AppShell', 'Sidebar', 'BoardColumn', 'TaskCard', 'TaskDialog'],
    features: ['Task columns', 'Drag and drop interactions', 'Task creation and editing', 'Filters', 'Persistent board state'],
    design: 'Focused productivity workspace'
  };
  if (/shop|store|ecommerce|e-commerce|product/.test(prompt)) return {
    targetUsers: ['Shoppers', 'Store customers'],
    routes: [{ path: '/', component: 'StorePage', purpose: 'Product discovery' }, { path: '/cart', component: 'CartPage', purpose: 'Shopping cart' }],
    components: ['StoreHeader', 'ProductCard', 'ProductGrid', 'CartDrawer', 'FilterBar'],
    features: ['Product browsing', 'Filtering', 'Cart interactions', 'Responsive product details'],
    design: 'Editorial commerce storefront'
  };
  if (/dashboard|analytics|admin|crm/.test(prompt)) return {
    targetUsers: ['Operators', 'Managers'],
    routes: [{ path: '/', component: 'DashboardPage', purpose: 'Operational overview' }, { path: '/settings', component: 'SettingsPage', purpose: 'Workspace settings' }],
    components: ['AppShell', 'Sidebar', 'MetricCard', 'DataTable', 'ChartPanel'],
    features: ['Dashboard metrics', 'Charts and tables', 'Filters', 'Responsive sidebar', 'Settings'],
    design: 'Dense but readable professional dashboard'
  };
  return {
    targetUsers: ['Primary users described by the request'],
    routes: [{ path: '/', component: 'HomePage', purpose: 'Primary requested workflow' }],
    components: ['AppShell', 'Header', 'DataCard', 'EmptyState'],
    features: ['Prompt-specific primary workflow', 'Realistic mock data', 'Error and empty states'],
    design: 'Modern application interface suited to the requested domain'
  };
}

function mockBlueprint(specification = {}) {
  const routes = normalizedRoutes(specification.routes);
  const pageFiles = routes.map((route) => fileContract({
    path: 'src/pages/' + route.component + '.jsx',
    responsibility: route.component + ' route UI',
    dependsOn: ['src/components/DataCard.jsx', 'src/data/mockData.js'],
    imports: [
      { path: 'src/components/DataCard.jsx', symbols: ['default'] },
      { path: 'src/data/mockData.js', symbols: ['metrics', 'activity'] }
    ],
    exports: ['default'],
    consumers: ['src/App.jsx']
  }));
  return normalizeBlueprint({
    stackManifest: {
      router: { mode: 'browser_router', ownerFile: 'src/App.jsx' },
      state: { mode: 'react_local_state', ownerFile: null },
      styling: { mode: 'tailwind', ownerFile: 'src/index.css' },
      dataFetching: { mode: 'local_mock_data', ownerFile: 'src/data/mockData.js' },
      providers: [{ name: 'BrowserRouter', ownerFile: 'src/App.jsx' }]
    },
    requiredDependencies: ['@vitejs/plugin-react', 'vite', 'react', 'react-dom', 'react-router-dom', 'tailwindcss', 'postcss', 'autoprefixer', 'lucide-react'],
    folderStructure: ['src/components', 'src/pages', 'src/data'],
    fileList: [
      fileContract({ path: 'src/index.css', responsibility: 'Global Tailwind styles and design tokens', consumers: ['src/main.jsx'] }),
      fileContract({ path: 'src/main.jsx', responsibility: 'Render the React root', dependsOn: ['src/App.jsx', 'src/index.css'], imports: [{ path: 'src/App.jsx', symbols: ['default'] }, { path: 'src/index.css', symbols: [] }] }),
      fileContract({ path: 'src/App.jsx', responsibility: 'Integrate application routes and navigation', dependsOn: ['src/components/AppShell.jsx', ...pageFiles.map((file) => file.path)], imports: [{ path: 'src/components/AppShell.jsx', symbols: ['default'] }, ...pageFiles.map((file) => ({ path: file.path, symbols: ['default'] }))], exports: ['default'], consumers: ['src/main.jsx'], providerRequirements: [] }),
      fileContract({ path: 'src/data/mockData.js', responsibility: 'Prompt-specific realistic mock data', exports: ['metrics', 'activity'], consumers: pageFiles.map((file) => file.path) }),
      fileContract({ path: 'src/components/AppShell.jsx', responsibility: 'Shared responsive application layout', exports: ['default'], consumers: ['src/App.jsx'], props: ['projectName', 'summary', 'navItems', 'children'], providerRequirements: ['BrowserRouter'] }),
      fileContract({ path: 'src/components/DataCard.jsx', responsibility: 'Reusable data presentation', exports: ['default'], consumers: pageFiles.map((file) => file.path), props: ['label', 'value', 'status'] }),
      ...pageFiles
    ],
    routes,
    reduxSlices: [],
    sharedComponentContracts: (specification.sharedComponents || []).map((name) => ({ name, props: [], responsibility: 'Implement ' + name + ' for the requested experience' })),
    mockDataRequirements: specification.dataRequirements || ['Create prompt-specific static data'],
    localStorageBehavior: specification.localStorageRequirements || [],
    implementationPhases: ['Scaffold project', 'Build shared UI', 'Build pages', 'Integrate routes', 'Validate and build'],
    acceptanceCriteria: ['Runs with npm run build', 'All declared routes render', 'Requested core features are visible and interactive', 'Mobile and desktop layouts are usable']
  }, specification);
}

function normalizeBlueprint(input = {}, specification = {}) {
  const routes = normalizedRoutes(input.routes?.length ? input.routes : specification.routes);
  const map = new Map();
  for (const raw of input.fileList || []) {
    let filePath = String(raw?.path || '').replace(/^\/+/, '');
    if (filePath === 'src/app/App.jsx') filePath = 'src/App.jsx';
    if (!/^src\/.+\.(js|jsx|css|json)$/.test(filePath) && !['package.json', 'index.html', 'vite.config.js', 'tailwind.config.js', 'postcss.config.js'].includes(filePath)) continue;
    map.set(filePath, fileContract({
      ...raw,
      path: filePath,
      dependsOn: normalizeContractPaths(raw.dependsOn),
      imports: (raw.imports || []).map((entry) => ({ ...entry, path: normalizeContractPath(entry?.path), symbols: Array.isArray(entry?.symbols) ? entry.symbols : [] })),
      consumers: normalizeContractPaths(raw.consumers)
    }));
  }
  for (const route of routes) {
    const path = 'src/pages/' + route.component + '.jsx';
    if (!map.has(path)) map.set(path, fileContract({ path, responsibility: route.component + ' route UI', exports: ['default'], consumers: ['src/App.jsx'] }));
  }
  const main = fileContract({ ...(map.get('src/main.jsx') || {}), path: 'src/main.jsx', responsibility: 'Render React root' });
  main.dependsOn = [...new Set([...main.dependsOn, 'src/App.jsx', ...(map.has('src/index.css') ? ['src/index.css'] : [])])];
  map.set('src/main.jsx', main);
  const app = fileContract({ ...(map.get('src/App.jsx') || {}), path: 'src/App.jsx', responsibility: 'Integrate actual pages, routes, navigation, and app-wide providers', exports: ['default'] });
  app.dependsOn = [...new Set([...app.dependsOn, ...routes.map((route) => 'src/pages/' + route.component + '.jsx')])];
  map.set('src/App.jsx', app);
  const stackManifest = normalizeStackManifest(input.stackManifest);
  const baseDependencies = ['@vitejs/plugin-react', 'vite', 'react', 'react-dom', 'tailwindcss', 'postcss', 'autoprefixer', 'lucide-react'];
  if (stackManifest.router.mode !== 'none') baseDependencies.push('react-router-dom');
  if (stackManifest.state.mode === 'redux_toolkit') baseDependencies.push('@reduxjs/toolkit', 'react-redux');
  return {
    stackManifest,
    requiredDependencies: [...new Set([...baseDependencies, ...(input.requiredDependencies || [])])],
    folderStructure: Array.isArray(input.folderStructure) ? input.folderStructure : ['src/components', 'src/pages', 'src/data'],
    fileList: [...map.values()],
    routes,
    reduxSlices: Array.isArray(input.reduxSlices) ? input.reduxSlices : [],
    sharedComponentContracts: Array.isArray(input.sharedComponentContracts) ? input.sharedComponentContracts : [],
    mockDataRequirements: Array.isArray(input.mockDataRequirements) ? input.mockDataRequirements : [],
    localStorageBehavior: Array.isArray(input.localStorageBehavior) ? input.localStorageBehavior : [],
    implementationPhases: Array.isArray(input.implementationPhases) ? input.implementationPhases : [],
    acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : []
  };
}

function fileContract(input = {}) {
  return {
    ...input,
    responsibility: String(input.responsibility || 'Implement ' + String(input.path || 'frontend file')),
    dependsOn: Array.isArray(input.dependsOn) ? input.dependsOn.filter(Boolean) : [],
    imports: Array.isArray(input.imports) ? input.imports : [],
    exports: Array.isArray(input.exports) ? input.exports : [],
    consumers: Array.isArray(input.consumers) ? input.consumers : [],
    props: Array.isArray(input.props) ? input.props : [],
    providerRequirements: Array.isArray(input.providerRequirements) ? input.providerRequirements : []
  };
}

function normalizeContractPath(value) { return String(value || '') === 'src/app/App.jsx' ? 'src/App.jsx' : String(value || '').replace(/^\/+/, ''); }
function normalizeContractPaths(values) { return Array.isArray(values) ? values.map(normalizeContractPath).filter(Boolean) : []; }

function normalizeStackManifest(input = {}) {
  return {
    router: { mode: input.router?.mode || 'browser_router', ownerFile: input.router?.ownerFile ?? 'src/App.jsx' },
    state: { mode: input.state?.mode || 'react_local_state', ownerFile: input.state?.ownerFile ?? null },
    styling: { mode: input.styling?.mode || 'tailwind', ownerFile: input.styling?.ownerFile ?? 'src/index.css' },
    dataFetching: { mode: input.dataFetching?.mode || 'local_mock_data', ownerFile: input.dataFetching?.ownerFile ?? null },
    providers: Array.isArray(input.providers) ? input.providers : []
  };
}

function normalizedRoutes(source) {
  const routes = Array.isArray(source) && source.length ? source : [{ path: '/', component: 'HomePage' }];
  const seen = new Set();
  const normalized = routes.map((route, index) => {
    let routePath = String(route?.path || (index ? '/page-' + index : '/')).trim();
    if (!routePath.startsWith('/')) routePath = '/' + routePath;
    const component = String(route?.component || (index ? 'Page' + index + 'Page' : 'HomePage')).replace(/[^A-Za-z0-9]/g, '') || 'HomePage';
    if (seen.has(routePath)) routePath += '-' + index;
    seen.add(routePath);
    return { ...route, path: routePath, component };
  });
  if (!normalized.some((route) => route.path === '/')) normalized[0] = { ...normalized[0], path: '/' };
  return normalized;
}
