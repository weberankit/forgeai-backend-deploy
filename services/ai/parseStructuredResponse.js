import { httpError } from '../../utils/httpError.js';

export function stripMarkdownFences(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

export function parseStructuredResponse(text, validator) {
  let parsed;
  try {
    parsed = JSON.parse(stripMarkdownFences(text));
  } catch {
    throw httpError(502, 'AI provider returned invalid JSON.');
  }

  const result = validator(parsed);
  if (!result.valid) {
    throw httpError(502, `AI provider returned invalid structured output: ${result.message}`);
  }
  return parsed;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) return `${field} must be an array`;
  return null;
}

export function validateExpansionSpec(value) {
  const requiredStrings = ['projectName', 'projectSummary'];
  for (const field of requiredStrings) {
    if (!value[field] || typeof value[field] !== 'string') return { valid: false, message: `${field} is required` };
  }
  const arrays = [
    'targetUsers',
    'pages',
    'routes',
    'sharedComponents',
    'coreFeatures',
    'dataRequirements',
    'reduxRequirements',
    'localStorageRequirements',
    'responsiveRequirements',
    'accessibilityRequirements',
    'designDirection',
    'assumptions',
    'blockingQuestions'
  ];
  for (const field of arrays) {
    const error = requireArray(value[field], field);
    if (error) return { valid: false, message: error };
  }
  const pageRoutes = new Set(value.pages.map((page) => String(page?.route || '')));
  const routePaths = new Set(value.routes.map((route) => String(route?.path || '')));
  if (pageRoutes.size !== value.pages.length || routePaths.size !== value.routes.length) return { valid: false, message: 'pages and routes must use unique route paths' };
  if (pageRoutes.size !== routePaths.size || [...pageRoutes].some((route) => !routePaths.has(route))) return { valid: false, message: 'pages and routes must describe the same route paths' };
  for (const route of value.routes) if (!route?.path || !route?.component) return { valid: false, message: 'each route requires path and component' };
  return { valid: true };
}

export function validateBlueprint(value) {
  const arrays = [
    'requiredDependencies',
    'folderStructure',
    'fileList',
    'routes',
    'reduxSlices',
    'sharedComponentContracts',
    'mockDataRequirements',
    'localStorageBehavior',
    'implementationPhases',
    'acceptanceCriteria'
  ];
  for (const field of arrays) {
    const error = requireArray(value[field], field);
    if (error) return { valid: false, message: error };
  }
  const stackError = validateStackManifest(value.stackManifest);
  if (stackError) return { valid: false, message: stackError };
  const paths = new Set();
  for (const file of value.fileList) {
    const path = normalizeBlueprintPath(file?.path);
    if (!path) return { valid: false, message: 'every fileList entry requires a safe frontend path' };
    if (paths.has(path)) return { valid: false, message: 'duplicate blueprint file path: ' + path };
    paths.add(path);
    if (!file.responsibility || !Array.isArray(file.dependsOn) || !Array.isArray(file.imports) || !Array.isArray(file.exports) || !Array.isArray(file.consumers) || !Array.isArray(file.props) || !Array.isArray(file.providerRequirements)) {
      return { valid: false, message: 'each file requires responsibility, dependsOn, imports, exports, consumers, props, and providerRequirements' };
    }
  }
  for (const file of value.fileList) {
    const filePath = normalizeBlueprintPath(file.path);
    for (const dependency of file.dependsOn) {
      const dependencyPath = normalizeBlueprintPath(dependency);
      if (!dependencyPath || !paths.has(dependencyPath)) return { valid: false, message: filePath + ' depends on missing ' + dependency };
    }
    for (const imported of file.imports) {
      const importedPath = normalizeBlueprintPath(imported?.path);
      if (!importedPath || !paths.has(importedPath)) return { valid: false, message: filePath + ' imports missing ' + String(imported?.path || '') };
      if (!file.dependsOn.map(normalizeBlueprintPath).includes(importedPath)) return { valid: false, message: filePath + ' must list imported path in dependsOn: ' + importedPath };
      if (!Array.isArray(imported.symbols)) return { valid: false, message: filePath + ' import symbols must be an array' };
      const exporter = value.fileList.find((entry) => normalizeBlueprintPath(entry.path) === importedPath);
      for (const symbol of imported.symbols) {
        if (!exporter.exports.includes(symbol)) return { valid: false, message: filePath + ' imports unplanned symbol ' + symbol + ' from ' + importedPath };
      }
    }
    for (const consumer of file.consumers) {
      const consumerPath = normalizeBlueprintPath(consumer);
      if (!consumerPath || !paths.has(consumerPath)) return { valid: false, message: filePath + ' lists missing consumer ' + consumer };
    }
  }
  const cycle = findBlueprintCycle(value.fileList);
  if (cycle) return { valid: false, message: 'circular blueprint dependency: ' + cycle.join(' -> ') };
  for (const route of value.routes) {
    const pagePath = 'src/pages/' + String(route?.component || '').replace(/[^A-Za-z0-9]/g, '') + '.jsx';
    if (!route?.path || !route?.component || !paths.has(pagePath)) return { valid: false, message: 'route requires matching page file: ' + pagePath };
  }
  const providerNames = new Set(value.stackManifest.providers.map((provider) => provider?.name));
  for (const provider of value.stackManifest.providers) {
    const ownerPath = normalizeBlueprintPath(provider?.ownerFile);
    if (!provider?.name || !ownerPath || !paths.has(ownerPath)) return { valid: false, message: 'every provider requires a planned owner file' };
  }
  for (const [key, selection] of Object.entries(value.stackManifest)) {
    if (key === 'providers' || selection.ownerFile == null) continue;
    const ownerPath = normalizeBlueprintPath(selection.ownerFile);
    if (!ownerPath || !paths.has(ownerPath)) return { valid: false, message: 'stackManifest.' + key + ' ownerFile must be planned' };
  }
  for (const file of value.fileList) {
    for (const provider of file.providerRequirements) if (!providerNames.has(provider)) return { valid: false, message: file.path + ' requires undeclared provider ' + provider };
  }
  return { valid: true };
}

function validateStackManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return 'stackManifest is required';
  const allowed = {
    router: new Set(['browser_router', 'data_router', 'none']),
    state: new Set(['react_local_state', 'redux_toolkit', 'context']),
    styling: new Set(['tailwind']),
    dataFetching: new Set(['local_mock_data', 'browser_fetch'])
  };
  for (const [key, modes] of Object.entries(allowed)) {
    if (!manifest[key] || !modes.has(manifest[key].mode)) return 'stackManifest.' + key + '.mode is invalid';
    if (!Object.prototype.hasOwnProperty.call(manifest[key], 'ownerFile')) return 'stackManifest.' + key + '.ownerFile is required';
  }
  if (!Array.isArray(manifest.providers)) return 'stackManifest.providers must be an array';
  return null;
}

function normalizeBlueprintPath(value) {
  const path = String(value || '').replace(/^\/+/, '');
  if (!path || path.includes('..') || path.includes('\\')) return null;
  if (/^src\/.+\.(js|jsx|css|json)$/.test(path)) return path === 'src/app/App.jsx' ? 'src/App.jsx' : path;
  return ['package.json', 'index.html', 'vite.config.js', 'tailwind.config.js', 'postcss.config.js'].includes(path) ? path : null;
}

function findBlueprintCycle(files) {
  const byPath = new Map(files.map((file) => [normalizeBlueprintPath(file.path), file]));
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  function visit(path) {
    if (visiting.has(path)) return stack.slice(stack.indexOf(path)).concat(path);
    if (visited.has(path)) return null;
    visiting.add(path); stack.push(path);
    for (const raw of byPath.get(path)?.dependsOn || []) {
      const cycle = visit(normalizeBlueprintPath(raw));
      if (cycle) return cycle;
    }
    stack.pop(); visiting.delete(path); visited.add(path);
    return null;
  }
  for (const path of byPath.keys()) { const cycle = visit(path); if (cycle) return cycle; }
  return null;
}
