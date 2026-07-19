export function buildCodeGenerationPrompt({ specification, blueprint, previousFiles, targetFiles, contracts, warnings, agentName, phase, dependencyContext }) {
  return [
    'You are ' + (agentName || 'Code Generation Agent') + ', generating complete files for a frontend-only React Vite application.',
    '',
    'Return strict JSON only. Do not include Markdown fences.',
    '',
    'Current dependency-ordered phase: ' + (phase || 'code_generation'),
    '',
    'Frontend Manager DAG:',
    '- Frontend Manager Agent orchestrates all phases.',
    '- Project Setup Agent creates React/Vite/Tailwind foundation.',
    '- Component Agent builds shared components and reusable contracts.',
    '- Layout Agent consumes registered components to build shell/navigation/routing.',
    '- Page Agent and Styling Agent may run concurrently after layout because they only consume registered components/layouts/tokens.',
    '- Final integration assembles React project files.',
    '',
    'Allowed generated project stack:',
    '- React.js with Vite',
    '- JavaScript',
    '- Tailwind CSS',
    '- React Router when useful',
    '- Redux Toolkit only when useful',
    '- Lucide React',
    '- localStorage',
    '- Mock data',
    '- Safe browser-compatible npm packages when they materially implement the requested UI behavior',
    '- Frontend-only mock flows for payments, auth, uploads, email, maps, analytics, or third-party integrations unless the package is already in the allowed stack',
    '',
    'Disallowed: Express, MongoDB, Mongoose, SQL, authentication, JWT, OAuth, Docker, Next.js, server routes, server-only secrets.',
    'You may add a browser-compatible npm dependency when it is needed for the requested UI. Add it to package.json and import it normally. Never add server frameworks, databases, server auth packages, lifecycle scripts, Git/URL dependencies, or packages that require secrets.',
    '',
    'Return this exact JSON shape:',
    '{ "files": [{ "path": "src/components/Header.jsx", "language": "jsx", "content": "complete file content" }], "contracts": [], "warnings": [] }',
    '',
    'Generate only the requested target files. Preserve exact paths. Return complete working file contents. Do not use placeholder comments or TODO-only code. Ensure imports refer to generated or existing files.',
    'Return exactly one complete version of each target file. Never duplicate imports, declarations, exports, routes, or file paths.',
    'Implement the specification and blueprint literally: requested sections, workflows, interactions, data, and design direction must appear in the UI.',
    'Use the supplied previous file contents as authoritative contracts. Do not invent exports, prop names, aliases, or alternate folders.',
    'Only src/App.jsx integrates routes and only src/main.jsx mounts React. Do not create another router or application entry.',
    'Before returning, verify every rendered component is imported or declared and every imported symbol is exported by its real module.',
    'Never import a relative module unless that exact file exists in previous files, target files, or the blueprint file list. If you import ./routes/AppRoutes, then src/routes/AppRoutes.jsx must be generated or already present.',
    'Respect dependency order: consume previous files/contracts, but do not redefine upstream responsibilities unless a requested target file requires it.',
    '',
    'Specification:',
    JSON.stringify(specification, null, 2),
    '',
    'Blueprint:',
    JSON.stringify(blueprint, null, 2),
    '',
    'Previously generated files:',
    JSON.stringify(buildPreviousFileContext(previousFiles, targetFiles, blueprint), null, 2),
    '',
    'Target files:',
    JSON.stringify(targetFiles, null, 2),
    '',
    'Registered contracts:',
    JSON.stringify(contracts || [], null, 2),
    '',
    'Dependency context:',
    JSON.stringify(dependencyContext || {}, null, 2),
    '',
    'Known pitfalls to avoid from verified fix memory:',
    dependencyContext?.knownPitfalls || 'No verified pitfalls matched this context.',
    '',
    'Previous warnings:',
    JSON.stringify(warnings || [], null, 2)
  ].join('\n');
}


function buildPreviousFileContext(files = [], targetFiles = [], blueprint = {}) {
  const relevant = prioritizePreviousFiles(files, targetFiles, blueprint);
  let remaining = Number(process.env.GENERATION_PREVIOUS_CONTEXT_CHARS || 45000);
  if (!Number.isFinite(remaining) || remaining < 8000) remaining = 45000;
  return relevant.map((file) => {
    const content = String(file.content || '');
    const included = content.slice(0, Math.max(0, Math.min(content.length, remaining)));
    remaining -= included.length;
    return { path: file.path, language: file.language, content: included, truncated: included.length < content.length };
  });
}

function prioritizePreviousFiles(files = [], targetFiles = [], blueprint = {}) {
  const targetSet = new Set((targetFiles || []).map(String));
  const blueprintFiles = new Map((blueprint.fileList || []).map((file) => [String(file.path || ''), file]));
  const directDependencies = new Set(['package.json', 'src/index.css', 'src/data/mockData.js', 'src/components/AppShell.jsx', 'src/components/DataCard.jsx']);

  for (const target of targetSet) {
    for (const dependency of blueprintFiles.get(target)?.dependsOn || []) directDependencies.add(String(dependency));
    if (target === 'src/App.jsx') {
      for (const route of blueprint.routes || []) directDependencies.add('src/pages/' + String(route.component || 'HomePage').replace(/[^A-Za-z0-9]/g, '') + '.jsx');
    }
    if (target.startsWith('src/pages/')) {
      directDependencies.add('src/components/AppShell.jsx');
      directDependencies.add('src/data/mockData.js');
    }
  }

  const scored = (files || []).map((file, index) => {
    const path = String(file.path || '');
    let score = 0;
    if (directDependencies.has(path)) score += 100;
    if (path === 'src/App.jsx' || path === 'src/main.jsx') score += 50;
    if (targetSet.has(path)) score -= 100;
    return { file, index, score };
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((item) => item.file);
}
