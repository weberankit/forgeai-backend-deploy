import crypto from 'crypto';
import { normalizeProjectPath } from './pathSafety.js';

function expectedExportsFor(path, blueprint = {}) {
  const described = (blueprint.fileList || []).find((file) => normalizeSafe(file?.path) === path);
  const describedExports = Array.isArray(described?.exports) ? described.exports : [];
  const requiresDefault = /[.]jsx$/.test(path)
    && (path.startsWith('src/pages/')
      || path.startsWith('src/layouts/')
      || path.startsWith('src/routes/')
      || path === 'src/App.jsx');
  if (requiresDefault) return [...new Set(['default', ...describedExports])];
  if (describedExports.length) return [...new Set(describedExports)];
  if (/[.]jsx$/.test(path) && path.startsWith('src/components/')) return ['default'];
  if (path === 'src/main.jsx' || /\.css$/.test(path) || !/\.(js|jsx)$/.test(path)) return [];
  return [];
}

function normalizeSafe(value) {
  try { return normalizeProjectPath(value); } catch { return null; }
}

export function buildProjectManifest(blueprint = {}, batches = []) {
  const plannedPaths = new Set();
  const duplicatedPlans = new Set();
  for (const entry of blueprint.fileList || []) {
    const plannedPath = normalizeSafe(entry?.path);
    if (!plannedPath) continue;
    if (plannedPaths.has(plannedPath)) duplicatedPlans.add(plannedPath);
    plannedPaths.add(plannedPath);
  }
  if (duplicatedPlans.size) throw new Error('Duplicate planned file ownership: ' + [...duplicatedPlans].join(', '));
  const files = {};
  const conflicts = [];
  for (const batch of batches) {
    for (const rawPath of batch.files || []) {
      const path = normalizeProjectPath(rawPath);
      const owner = batch.agentName;
      if (files[path] && files[path].owner !== owner) {
        conflicts.push({ path, owners: [files[path].owner, owner] });
        continue;
      }
      const blueprintFile = (blueprint.fileList || []).find((file) => normalizeSafe(file?.path) === path) || {};
      files[path] = {
        owner,
        operation: 'create',
        responsibility: String(blueprintFile.responsibility || ''),
        expectedExports: expectedExportsFor(path, blueprint),
        imports: Array.isArray(blueprintFile.imports) ? blueprintFile.imports : [],
        dependsOn: (blueprintFile.dependsOn || []).map(normalizeSafe).filter(Boolean),
        consumers: (blueprintFile.consumers || []).map(normalizeSafe).filter(Boolean),
        props: Array.isArray(blueprintFile.props) ? blueprintFile.props : [],
        providerRequirements: Array.isArray(blueprintFile.providerRequirements) ? blueprintFile.providerRequirements : []
      };
    }
  }
  for (const [consumer, contract] of Object.entries(files)) {
    for (const dependency of contract.dependsOn) if (files[dependency]) files[dependency].consumers.push(consumer);
  }
  for (const contract of Object.values(files)) contract.consumers = [...new Set(contract.consumers)];
  if (conflicts.length) throw new Error('Duplicate file ownership: ' + conflicts.map((item) => item.path + ' (' + item.owners.join(', ') + ')').join('; '));
  const version = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16);
  return { version, files };
}

export function manifestForBatch(manifest, batch) {
  const files = {};
  for (const path of batch.files || []) files[path] = manifest.files[path];
  for (const path of batch.files || []) {
    for (const dependency of manifest.files[path]?.dependsOn || []) if (manifest.files[dependency]) files[dependency] = manifest.files[dependency];
  }
  return { version: manifest.version, files };
}

export function assertOwnedBatchFiles(files, batch, manifest) {
  const assigned = new Set(batch.files || []);
  for (const file of files || []) {
    const path = normalizeProjectPath(file.path);
    const contract = manifest.files[path];
    if (!contract) throw new Error('Agent returned an unplanned file: ' + path);
    if (!assigned.has(path) || contract.owner !== batch.agentName) throw new Error('File ownership conflict for ' + path + ': owner is ' + contract.owner + ', returned by ' + batch.agentName);
  }
}

export function assertDisjointWriteSets(batches = []) {
  const owners = new Map();
  for (const batch of batches) {
    for (const path of batch.files || []) {
      if (owners.has(path)) throw new Error('Parallel write-set conflict for ' + path + ': ' + owners.get(path) + ' and ' + batch.agentName);
      owners.set(path, batch.agentName);
    }
  }
}
