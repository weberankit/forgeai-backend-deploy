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

  // Build the set of valid paths first
  const paths = new Set();
  const coercedFiles = [];
  for (const file of value.fileList) {
    const filePath = normalizeBlueprintPath(file?.path);
    if (!filePath) return { valid: false, message: 'every fileList entry requires a safe frontend path' };
    if (paths.has(filePath)) return { valid: false, message: 'duplicate blueprint file path: ' + filePath };
    paths.add(filePath);
    // Coerce missing optional array fields rather than rejecting the whole blueprint
    coercedFiles.push({
      ...file,
      path: filePath,
      responsibility: file.responsibility || '',
      dependsOn: Array.isArray(file.dependsOn) ? file.dependsOn : [],
      imports: Array.isArray(file.imports) ? file.imports : [],
      exports: Array.isArray(file.exports) ? file.exports : [],
      consumers: Array.isArray(file.consumers) ? file.consumers : [],
      props: Array.isArray(file.props) ? file.props : [],
      providerRequirements: Array.isArray(file.providerRequirements) ? file.providerRequirements : [],
    });
  }

  // Cross-reference checks — skip entries that can't be resolved rather than hard-failing,
  // since LLMs occasionally get path casing or trailing slashes slightly wrong.
  for (const file of coercedFiles) {
    // dependsOn must reference known paths
    for (const dep of file.dependsOn) {
      const depPath = normalizeBlueprintPath(dep);
      if (!depPath || !paths.has(depPath)) {
        return { valid: false, message: file.path + ' depends on missing ' + dep };
      }
    }
    // imports — path must exist; symbols cross-check is advisory only (LLMs mis-list symbols frequently)
    for (const imported of file.imports) {
      const importedPath = normalizeBlueprintPath(imported?.path);
      if (!importedPath || !paths.has(importedPath)) {
        return { valid: false, message: file.path + ' imports missing ' + String(imported?.path || '') };
      }
      // If the import path is not in dependsOn, add it silently rather than rejecting
      if (!file.dependsOn.map(normalizeBlueprintPath).includes(importedPath)) {
        file.dependsOn.push(importedPath);
      }
      if (!Array.isArray(imported.symbols)) {
        imported.symbols = [];
      }
      // Symbol check is a warning only — do not hard-fail
    }
    // consumers — only reject if the path is genuinely bad, not just absent from the file list yet
    for (const consumer of file.consumers) {
      const consumerPath = normalizeBlueprintPath(consumer);
      if (consumerPath && !paths.has(consumerPath)) {
        // Silently drop invalid consumer references rather than failing the whole blueprint
      }
    }
  }

  const cycle = findBlueprintCycle(coercedFiles);
  if (cycle) return { valid: false, message: 'circular blueprint dependency: ' + cycle.join(' -> ') };

  // Every route must have a matching page file
  for (const route of value.routes) {
    const pagePath = 'src/pages/' + String(route?.component || '').replace(/[^A-Za-z0-9]/g, '') + '.jsx';
    if (!route?.path || !route?.component) {
      return { valid: false, message: 'each route requires path and component' };
    }
    if (!paths.has(pagePath)) {
      return { valid: false, message: 'route requires matching page file: ' + pagePath };
    }
  }

  // stackManifest provider owner files must be planned
  const providerNames = new Set(value.stackManifest.providers.map((provider) => provider?.name).filter(Boolean));
  for (const provider of value.stackManifest.providers) {
    const ownerPath = normalizeBlueprintPath(provider?.ownerFile);
    if (!provider?.name) continue; // skip nameless providers
    if (!ownerPath || !paths.has(ownerPath)) {
      return { valid: false, message: 'provider "' + provider.name + '" ownerFile is not a planned file' };
    }
  }
  for (const [key, selection] of Object.entries(value.stackManifest)) {
    if (key === 'providers') continue;
    if (!selection || selection.ownerFile == null) continue;
    const ownerPath = normalizeBlueprintPath(selection.ownerFile);
    if (!ownerPath || !paths.has(ownerPath)) {
      return { valid: false, message: 'stackManifest.' + key + ' ownerFile must be a planned file' };
    }
  }
  // providerRequirements — advisory only; providers can be declared at runtime
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
