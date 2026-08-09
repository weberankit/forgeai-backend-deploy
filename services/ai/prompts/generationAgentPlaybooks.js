const PLAYBOOKS = {
  'Project Setup Agent': {
    mission: 'Create only the runnable project foundation and dependency manifest required by the approved blueprint.',
    mustDo: [
      'Write package.json and build-tool configuration only when those paths are assigned to this batch.',
      'Declare exactly the approved browser dependencies and compatible scripts; keep configuration minimal and deterministic.',
      'Make later agents able to import React, router, styling, icons, and state packages without changing package.json.'
    ],
    mustNotDo: [
      'Do not build pages, reusable UI components, application routes, or product-specific feature code.',
      'Do not add speculative packages that the blueprint does not require.'
    ],
    example: 'For a bookstore React app, create the Vite/package/Tailwind foundation with only the dependencies approved in requiredDependencies. Do not implement BookCard, CatalogPage, or routes in setup files.'
  },
  'Component Agent': {
    mission: 'Implement reusable components, hooks, data modules, utilities, and state contracts consumed by downstream layouts and pages.',
    mustDo: [
      'Honor every planned export name and prop contract exactly so downstream agents can import without guessing.',
      'Make reusable controls accessible, responsive, and behaviorally complete within their responsibility.',
      'Keep product data and shared state in their planned owner files instead of duplicating them in pages.',
      'Only introduce a Context or store slice when a value is genuinely needed across multiple branches of the component tree; otherwise expose the value as props so consumers stay simple.',
      'Use only icon names you are confident exist in the declared icon package; fall back to a common well-known icon rather than an invented one.'
    ],
    mustNotDo: [
      'Do not create app routes, mount React, or assemble complete pages unless one of those exact files is assigned.',
      'Do not change upstream setup files or invent alternate component paths.',
      'Do not create a second Context or store for a concern an existing one already owns.'
    ],
    example: 'For a bookstore React app, BookCard exports the exact planned component and accepts the planned book/onAddToCart props; a catalog data module exports realistic mock books. It does not create BrowserRouter or the CatalogPage, and it does not add a CartContext if a Redux cart slice already owns that state.'
  },
  'Layout Agent': {
    mission: 'Build the shared visual shell, navigation, and route-adjacent layout contracts without taking ownership of page content or the application entry.',
    mustDo: [
      'Compose only registered upstream components and preserve their real import/export contracts.',
      'Implement responsive navigation, active states, keyboard access, and outlet/children placement required by the blueprint.',
      'Keep routing APIs consistent with stackManifest.router.mode and the designated router owner.'
    ],
    mustNotDo: [
      'Do not recreate shared components or page bodies inside a layout.',
      'Do not introduce a second router/provider or mount the React root.'
    ],
    example: 'For a bookstore React app, MainLayout composes Header, navigation, cart badge, main content, and footer, exposing the planned outlet/children contract. It does not embed the catalog grid or create a second BrowserRouter.'
  },
  'Page Agent': {
    mission: 'Implement complete route pages and product workflows from the specification by composing existing shared contracts.',
    mustDo: [
      'Render every requested section, meaningful content item, empty/error state, and interaction assigned to the page.',
      'Use provided data/state/component exports exactly and keep all buttons, forms, filters, and links functional.',
      'Match the specified responsive layout, visual direction, accessibility behavior, and route purpose.',
      'Guard list rendering and data access against empty or undefined data so the page never crashes on first load.'
    ],
    mustNotDo: [
      'Do not redefine shared components, global providers, the router, or global style ownership inside a page.',
      'Do not replace a requested experience with a generic dashboard or decorative placeholder.'
    ],
    example: 'For a bookstore React app, CatalogPage renders the requested hero, category filters, searchable book grid, empty state, and working add-to-cart actions using BookCard and the shared book data. It does not duplicate BookCard markup or own BrowserRouter.'
  },
  'Styling Agent': {
    mission: 'Implement the global styling system, tokens, utilities, responsive rules, and accessibility states required by the generated markup.',
    mustDo: [
      'Translate the design direction into concrete colors, typography, spacing, elevation, focus, motion, and breakpoint behavior.',
      'Cover classes and selectors actually used by planned/generated files, including hover, focus-visible, disabled, and reduced-motion states.',
      'Preserve website-reference geometry and visual roles without copying or hotlinking protected source assets.'
    ],
    mustNotDo: [
      'Do not create React components, routes, application state, or scripts in stylesheet files.',
      'Do not rely on undefined tokens, missing assets, or nonstandard Tailwind classes.'
    ],
    example: 'For a bookstore React app, define the warm editorial palette, readable type scale, responsive catalog grid, card hover/focus states, and reduced-motion behavior used by the existing JSX. Do not invent a second page structure in CSS.'
  },
  'Dynamic Preview Repair Agent': {
    mission: 'Diagnose an observed browser or Vite failure, change the smallest responsible file set, and preserve working product behavior.',
    mustDo: [
      'Treat the latest runtime stack, console message, source path, route, and build output as primary evidence.',
      'Trace the failing symbol through imports, exports, render ownership, and recently changed files before editing.',
      'Return materially changed complete files that address the root cause and remain valid under a production build.'
    ],
    mustNotDo: [
      'Do not return identical file contents, repeat a failed patch, or claim success from static validation alone.',
      'Do not remove required features or imports merely to silence an error; repair the contract or implementation.'
    ],
    example: 'If CatalogPage throws "BookCard is not defined", inspect CatalogPage and the real BookCard export, correct the import/export contract, then preserve the catalog and cart behavior. Do not delete the BookCard rendering to hide the exception. If the error is an unresolved lucide-react icon import (e.g. "does not provide an export named X"), replace it with a common, verified icon name that preserves the same visual role rather than removing the icon or the surrounding control.'
  },
  'Frontend Manager Agent': {
    mission: 'Perform final integration: connect the approved pages, router, providers, global styles, and React root into one runnable application.',
    mustDo: [
      'Use src/App.jsx as the sole route/application integrator and src/main.jsx as the sole React mount point.',
      'Verify every route maps to its real page export and every provider is instantiated once in the planned owner/order.',
      'Resolve integration gaps using existing contracts; keep all requested routes reachable and include a safe not-found experience when planned.'
    ],
    mustNotDo: [
      'Do not rewrite completed page/component responsibilities inside App.jsx or main.jsx.',
      'Do not invent missing exports, undeclared packages, alternate entry points, or duplicate routers/providers.'
    ],
    example: 'For a bookstore React app, App.jsx maps / to CatalogPage and /cart to CartPage beneath the single shared layout, while main.jsx imports global CSS and mounts App once. It does not paste page implementations into App.jsx.'
  }
};

const FALLBACK_PLAYBOOK = {
  mission: 'Generate complete assigned React/Vite files while respecting file ownership and all supplied contracts.',
  mustDo: [
    'Implement every assigned target completely and verify its imports, exports, behavior, accessibility, and responsive rendering.',
    'Fall back to safe, verified alternatives (common icon names, simple local implementations) instead of guessing when uncertain about an external symbol or asset.'
  ],
  mustNotDo: ['Do not write unassigned paths, invent dependencies, or duplicate upstream responsibilities.'],
  example: 'For a React application request, implement only the assigned files and connect them through the exact blueprint contracts supplied in context.'
};

export function getGenerationAgentPlaybook(agentName) {
  return PLAYBOOKS[agentName] || FALLBACK_PLAYBOOK;
}

export function formatGenerationAgentPlaybook(agentName) {
  const playbook = getGenerationAgentPlaybook(agentName);
  return [
    'CURRENT AGENT PLAYBOOK: ' + (agentName || 'Code Generation Agent'),
    'Mission: ' + playbook.mission,
    'Required behavior:',
    ...playbook.mustDo.map((item) => '- ' + item),
    'Ownership boundaries:',
    ...playbook.mustNotDo.map((item) => '- ' + item),
    'Concrete React app example:',
    playbook.example,
    'The example illustrates behavior only. The actual specification, blueprint, target files, and contracts below remain authoritative.'
  ].join('\n');
}

export const GENERATION_AGENT_NAMES = Object.freeze([
  'Project Setup Agent',
  'Component Agent',
  'Layout Agent',
  'Page Agent',
  'Styling Agent',
  'Frontend Manager Agent'
]);

// const PLAYBOOKS = {
//   'Project Setup Agent': {
//     mission: 'Create only the runnable project foundation and dependency manifest required by the approved blueprint.',
//     mustDo: [
//       'Write package.json and build-tool configuration only when those paths are assigned to this batch.',
//       'Declare exactly the approved browser dependencies and compatible scripts; keep configuration minimal and deterministic.',
//       'Make later agents able to import React, router, styling, icons, and state packages without changing package.json.'
//     ],
//     mustNotDo: [
//       'Do not build pages, reusable UI components, application routes, or product-specific feature code.',
//       'Do not add speculative packages that the blueprint does not require.'
//     ],
//     example: 'For a bookstore React app, create the Vite/package/Tailwind foundation with only the dependencies approved in requiredDependencies. Do not implement BookCard, CatalogPage, or routes in setup files.'
//   },
//   'Component Agent': {
//     mission: 'Implement reusable components, hooks, data modules, utilities, and state contracts consumed by downstream layouts and pages.',
//     mustDo: [
//       'Honor every planned export name and prop contract exactly so downstream agents can import without guessing.',
//       'Make reusable controls accessible, responsive, and behaviorally complete within their responsibility.',
//       'Keep product data and shared state in their planned owner files instead of duplicating them in pages.'
//     ],
//     mustNotDo: [
//       'Do not create app routes, mount React, or assemble complete pages unless one of those exact files is assigned.',
//       'Do not change upstream setup files or invent alternate component paths.'
//     ],
//     example: 'For a bookstore React app, BookCard exports the exact planned component and accepts the planned book/onAddToCart props; a catalog data module exports realistic mock books. It does not create BrowserRouter or the CatalogPage.'
//   },
//   'Layout Agent': {
//     mission: 'Build the shared visual shell, navigation, and route-adjacent layout contracts without taking ownership of page content or the application entry.',
//     mustDo: [
//       'Compose only registered upstream components and preserve their real import/export contracts.',
//       'Implement responsive navigation, active states, keyboard access, and outlet/children placement required by the blueprint.',
//       'Keep routing APIs consistent with stackManifest.router.mode and the designated router owner.'
//     ],
//     mustNotDo: [
//       'Do not recreate shared components or page bodies inside a layout.',
//       'Do not introduce a second router/provider or mount the React root.'
//     ],
//     example: 'For a bookstore React app, MainLayout composes Header, navigation, cart badge, main content, and footer, exposing the planned outlet/children contract. It does not embed the catalog grid or create a second BrowserRouter.'
//   },
//   'Page Agent': {
//     mission: 'Implement complete route pages and product workflows from the specification by composing existing shared contracts.',
//     mustDo: [
//       'Render every requested section, meaningful content item, empty/error state, and interaction assigned to the page.',
//       'Use provided data/state/component exports exactly and keep all buttons, forms, filters, and links functional.',
//       'Match the specified responsive layout, visual direction, accessibility behavior, and route purpose.'
//     ],
//     mustNotDo: [
//       'Do not redefine shared components, global providers, the router, or global style ownership inside a page.',
//       'Do not replace a requested experience with a generic dashboard or decorative placeholder.'
//     ],
//     example: 'For a bookstore React app, CatalogPage renders the requested hero, category filters, searchable book grid, empty state, and working add-to-cart actions using BookCard and the shared book data. It does not duplicate BookCard markup or own BrowserRouter.'
//   },
//   'Styling Agent': {
//     mission: 'Implement the global styling system, tokens, utilities, responsive rules, and accessibility states required by the generated markup.',
//     mustDo: [
//       'Translate the design direction into concrete colors, typography, spacing, elevation, focus, motion, and breakpoint behavior.',
//       'Cover classes and selectors actually used by planned/generated files, including hover, focus-visible, disabled, and reduced-motion states.',
//       'Preserve website-reference geometry and visual roles without copying or hotlinking protected source assets.'
//     ],
//     mustNotDo: [
//       'Do not create React components, routes, application state, or scripts in stylesheet files.',
//       'Do not rely on undefined tokens, missing assets, or nonstandard Tailwind classes.'
//     ],
//     example: 'For a bookstore React app, define the warm editorial palette, readable type scale, responsive catalog grid, card hover/focus states, and reduced-motion behavior used by the existing JSX. Do not invent a second page structure in CSS.'
//   },
//   'Dynamic Preview Repair Agent': {
//     mission: 'Diagnose an observed browser or Vite failure, change the smallest responsible file set, and preserve working product behavior.',
//     mustDo: [
//       'Treat the latest runtime stack, console message, source path, route, and build output as primary evidence.',
//       'Trace the failing symbol through imports, exports, render ownership, and recently changed files before editing.',
//       'Return materially changed complete files that address the root cause and remain valid under a production build.'
//     ],
//     mustNotDo: [
//       'Do not return identical file contents, repeat a failed patch, or claim success from static validation alone.',
//       'Do not remove required features or imports merely to silence an error; repair the contract or implementation.'
//     ],
//     example: 'If CatalogPage throws "BookCard is not defined", inspect CatalogPage and the real BookCard export, correct the import/export contract, then preserve the catalog and cart behavior. Do not delete the BookCard rendering to hide the exception.'
//   },
//   'Frontend Manager Agent': {
//     mission: 'Perform final integration: connect the approved pages, router, providers, global styles, and React root into one runnable application.',
//     mustDo: [
//       'Use src/App.jsx as the sole route/application integrator and src/main.jsx as the sole React mount point.',
//       'Verify every route maps to its real page export and every provider is instantiated once in the planned owner/order.',
//       'Resolve integration gaps using existing contracts; keep all requested routes reachable and include a safe not-found experience when planned.'
//     ],
//     mustNotDo: [
//       'Do not rewrite completed page/component responsibilities inside App.jsx or main.jsx.',
//       'Do not invent missing exports, undeclared packages, alternate entry points, or duplicate routers/providers.'
//     ],
//     example: 'For a bookstore React app, App.jsx maps / to CatalogPage and /cart to CartPage beneath the single shared layout, while main.jsx imports global CSS and mounts App once. It does not paste page implementations into App.jsx.'
//   }
// };

// const FALLBACK_PLAYBOOK = {
//   mission: 'Generate complete assigned React/Vite files while respecting file ownership and all supplied contracts.',
//   mustDo: ['Implement every assigned target completely and verify its imports, exports, behavior, accessibility, and responsive rendering.'],
//   mustNotDo: ['Do not write unassigned paths, invent dependencies, or duplicate upstream responsibilities.'],
//   example: 'For a React application request, implement only the assigned files and connect them through the exact blueprint contracts supplied in context.'
// };

// export function getGenerationAgentPlaybook(agentName) {
//   return PLAYBOOKS[agentName] || FALLBACK_PLAYBOOK;
// }

// export function formatGenerationAgentPlaybook(agentName) {
//   const playbook = getGenerationAgentPlaybook(agentName);
//   return [
//     'CURRENT AGENT PLAYBOOK: ' + (agentName || 'Code Generation Agent'),
//     'Mission: ' + playbook.mission,
//     'Required behavior:',
//     ...playbook.mustDo.map((item) => '- ' + item),
//     'Ownership boundaries:',
//     ...playbook.mustNotDo.map((item) => '- ' + item),
//     'Concrete React app example:',
//     playbook.example,
//     'The example illustrates behavior only. The actual specification, blueprint, target files, and contracts below remain authoritative.'
//   ].join('\n');
// }

// export const GENERATION_AGENT_NAMES = Object.freeze([
//   'Project Setup Agent',
//   'Component Agent',
//   'Layout Agent',
//   'Page Agent',
//   'Styling Agent',
//   'Frontend Manager Agent'
// ]);
