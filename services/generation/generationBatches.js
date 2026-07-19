import { topologicalSortFiles } from './topologicalSort.js';
import { normalizeProjectPath } from './pathSafety.js';

const setupFiles = [
  'package.json',
  'index.html',
  'vite.config.js',
  'tailwind.config.js',
  'postcss.config.js'
];
const stylingFiles = ['src/index.css'];
const requiredIntegrationFiles = ['src/App.jsx', 'src/main.jsx'];

const phaseMeta = {
  1: { phase: 'project_setup', agentName: 'Project Setup Agent' },
  2: { phase: 'component_registry', agentName: 'Component Agent' },
  3: { phase: 'layout_and_routing', agentName: 'Layout Agent' },
  4: { phase: 'pages_and_features', agentName: 'Page Agent' },
  5: { phase: 'styling_system', agentName: 'Styling Agent' },
  6: { phase: 'integration', agentName: 'Frontend Manager Agent' }
};

function safeNormalizeProjectPath(filePath) {
  try {
    return normalizeProjectPath(filePath);
  } catch {
    return null;
  }
}

function safeBlueprintFiles(fileList = []) {
  const normalized = [];
  for (const file of fileList) {
    const path = safeNormalizeProjectPath(file?.path);
    if (!path) continue;
    normalized.push({ ...file, path });
  }
  return normalized.map((file) => ({
    ...file,
    dependsOn: Array.isArray(file.dependsOn)
      ? file.dependsOn.map(safeNormalizeProjectPath).filter(Boolean)
      : []
  }));
}

function classify(filePath) {
  if (setupFiles.includes(filePath)) return 1;
  if (stylingFiles.includes(filePath) || /^src\/(styles|theme|tokens)\//.test(filePath) || /\.(css)$/.test(filePath)) return 5;
  if (/^src\/(components|data|hooks|utils|services|store|features)\//.test(filePath)) return 2;
  if (/^src\/(layouts|routes|navigation)\//.test(filePath)) return 3;
  if (/^src\/pages\//.test(filePath)) return 4;
  if (requiredIntegrationFiles.includes(filePath) || filePath === 'src/app/App.jsx') return 6;
  return 4;
}

const phaseChunkSizes = { 1: 10, 2: 6, 3: 8, 4: 4, 5: 6, 6: 10 };

function chunk(items, size = 8) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

export function buildGenerationBatches(blueprint = {}) {
  const specs = new Map();
  const add = (file) => {
    const path = normalizeProjectPath(file.path);
    const previous = specs.get(path);
    specs.set(path, { ...(previous || {}), ...file, path, dependsOn: [...new Set([...(previous?.dependsOn || []), ...(file.dependsOn || [])])] });
  };
  setupFiles.forEach((path) => add({ path, dependsOn: [] }));
  const blueprintFiles = Array.isArray(blueprint.fileList) ? safeBlueprintFiles(blueprint.fileList) : [];
  for (const file of blueprintFiles) add(file);
  const routes = Array.isArray(blueprint.routes) ? blueprint.routes : [];
  for (const route of routes) {
    const component = String(route.component || '').replace(/[^A-Za-z0-9]/g, '') || 'GeneratedPage';
    add({ path: 'src/pages/' + component + '.jsx', dependsOn: [] });
  }
  stylingFiles.forEach((path) => add({ path, dependsOn: [] }));
  add({ path: 'src/App.jsx', dependsOn: routes.map((route) => 'src/pages/' + String(route.component || '').replace(/[^A-Za-z0-9]/g, '') + '.jsx') });
  add({ path: 'src/main.jsx', dependsOn: ['src/App.jsx', 'src/index.css'] });

  for (const file of specs.values()) {
    if (!setupFiles.includes(file.path) && !file.dependsOn.includes('package.json')) file.dependsOn.push('package.json');
  }
  const sorted = topologicalSortFiles([...specs.values()]);
  const levelByPath = new Map();
  for (const file of sorted) levelByPath.set(file.path, file.dependsOn.length ? Math.max(...file.dependsOn.map((path) => levelByPath.get(path) || 0)) + 1 : 0);

  const grouped = new Map();
  for (const file of sorted) {
    const group = classify(file.path);
    const key = levelByPath.get(file.path) + ':' + group;
    if (!grouped.has(key)) grouped.set(key, { level: levelByPath.get(file.path), group, files: [] });
    grouped.get(key).files.push(file.path);
  }
  const batches = [];
  for (const entry of [...grouped.values()].sort((a, b) => a.level - b.level || a.group - b.group)) {
    const meta = phaseMeta[entry.group];
    for (const files of chunk(entry.files, phaseChunkSizes[entry.group] || 8)) {
      batches.push({
        batchNumber: batches.length + 1,
        phase: meta.phase,
        agentName: meta.agentName,
        dependencyLevel: entry.level,
        fileDependencies: [...new Set(files.flatMap((path) => specs.get(path)?.dependsOn || []))],
        dependsOn: [...new Set(files.flatMap((path) => specs.get(path)?.dependsOn || []))],
        concurrentGroup: null,
        files
      });
    }
  }
  const ownerBatch = new Map();
  for (const batch of batches) for (const path of batch.files) ownerBatch.set(path, batch.batchNumber);
  for (const batch of batches) batch.dependsOnBatches = [...new Set(batch.fileDependencies.map((path) => ownerBatch.get(path)).filter((number) => number && number !== batch.batchNumber))];
  return batches;
}

export function buildAgentExecutionStages(batches = []) {
  const pending = new Map(batches.map((batch) => [batch.batchNumber, batch]));
  const completed = new Set();
  const stages = [];
  while (pending.size) {
    const ready = [...pending.values()].filter((batch) => (batch.dependsOnBatches || []).every((number) => completed.has(number) || !pending.has(number)));
    if (!ready.length) throw new Error('Generation batch dependency cycle detected.');
    const phases = [...new Set(ready.map((batch) => batch.phase))];
    const phase = phases.length === 1 ? phases[0] : phases.every((item) => ['pages_and_features', 'styling_system'].includes(item)) ? 'page_and_styling' : 'generation_wave_' + (stages.length + 1);
    stages.push({ phase, parallel: ready.length > 1, batches: ready });
    for (const batch of ready) { pending.delete(batch.batchNumber); completed.add(batch.batchNumber); }
  }
  return stages;
}
