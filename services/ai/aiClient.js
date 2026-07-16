import { runExpansionGraph, runPlanningGraph } from './langGraphAgent.js';

export async function expandSpecification({ prompt, imageDescription }) {
  return runExpansionGraph({
    prompt,
    imageDescription,
    fallback: mockExpansion(prompt, imageDescription)
  });
}

export async function planFrontendProject({ specification, clarification }) {
  return runPlanningGraph({
    specification,
    clarification,
    fallback: mockBlueprint(specification)
  });
}

function titleFromPrompt(prompt) {
  const cleaned = prompt.replace(/build|create|make|frontend|react|app/gi, '').trim();
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 5);
  return words.length ? words.map((word) => word[0]?.toUpperCase() + word.slice(1)).join(' ') : 'Frontend Project';
}

function mockExpansion(prompt, imageDescription) {
  const projectName = titleFromPrompt(prompt);
  return {
    projectName,
    projectSummary: 'A frontend-only React application for: ' + prompt,
    targetUsers: ['Primary users described by the prompt', 'Operators reviewing responsive UI flows'],
    pages: [
      { name: 'Home', route: '/', purpose: 'Primary workspace and overview' },
      { name: 'Details', route: '/details/:id', purpose: 'Focused view for a selected item or workflow' }
    ],
    routes: [
      { path: '/', component: 'HomePage' },
      { path: '/details/:id', component: 'DetailsPage' }
    ],
    sharedComponents: ['AppShell', 'Header', 'Sidebar', 'DataCard', 'EmptyState', 'StatusBadge'],
    coreFeatures: ['Responsive application shell', 'Prompt-specific primary workflow', 'Reviewable mock data states', 'Error and empty states'],
    dataRequirements: ['Use local mock data shaped around the requested domain', 'No generated backend or database'],
    reduxRequirements: ['Use Redux Toolkit only for shared cross-page state if the workflow requires it'],
    localStorageRequirements: ['Persist lightweight user preferences or draft UI state only when useful'],
    responsiveRequirements: ['Mobile-first layout', 'Collapsible navigation on small screens', 'Readable touch targets'],
    accessibilityRequirements: ['Semantic landmarks', 'Keyboard accessible controls', 'Visible focus states', 'Accessible form labels'],
    designDirection: ['Modern AI coding workspace feel', 'Clean professional UI', imageDescription ? 'Reflect uploaded reference image where applicable' : 'Derive visual system from prompt'],
    assumptions: ['The generated app is frontend-only', 'All external data will be mocked for the generated app', 'Authentication is out of scope'],
    blockingQuestions: []
  };
}

function mockBlueprint(specification) {
  const routes = specification.routes?.length ? specification.routes : [{ path: '/', component: 'HomePage' }];
  return {
    requiredDependencies: ['@vitejs/plugin-react', 'react', 'react-dom', 'react-router-dom', 'tailwindcss', 'lucide-react'],
    folderStructure: ['src/app', 'src/components', 'src/pages', 'src/data', 'src/routes', 'src/styles'],
    fileList: [
      { path: 'src/main.jsx', responsibility: 'Render React root and router providers', dependsOn: ['src/app/App.jsx'] },
      { path: 'src/app/App.jsx', responsibility: 'Define application shell and routes', dependsOn: ['src/pages/HomePage.jsx'] },
      { path: 'src/data/mockData.js', responsibility: 'Provide domain mock data', dependsOn: [] },
      { path: 'src/components/AppShell.jsx', responsibility: 'Shared responsive layout', dependsOn: [] },
      { path: 'src/pages/HomePage.jsx', responsibility: 'Primary route experience', dependsOn: ['src/components/AppShell.jsx', 'src/data/mockData.js'] },
      { path: 'src/pages/DetailsPage.jsx', responsibility: 'Detail route for selected entities', dependsOn: ['src/data/mockData.js'] }
    ],
    routes,
    reduxSlices: specification.reduxRequirements?.some((item) => !/only/i.test(item))
      ? [{ name: 'appState', state: ['selectedItem', 'filters'], responsibility: 'Coordinate shared UI state' }]
      : [],
    sharedComponentContracts: [
      { name: 'AppShell', props: ['children', 'navigationItems'], responsibility: 'Wrap pages in responsive navigation' },
      { name: 'DataCard', props: ['title', 'value', 'status'], responsibility: 'Display repeatable domain metrics or entities' }
    ],
    mockDataRequirements: specification.dataRequirements || ['Create prompt-specific static data'],
    localStorageBehavior: specification.localStorageRequirements || [],
    implementationPhases: ['Scaffold Vite app and Tailwind', 'Create layout and route structure', 'Add mock data and components', 'Implement responsive states', 'Verify accessibility basics'],
    acceptanceCriteria: ['Runs with npm run dev', 'All declared routes render', 'No generated backend, database, or auth', 'Mobile and desktop layouts are usable']
  };
}
