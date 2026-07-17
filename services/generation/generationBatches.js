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
  1: { phase: 'project_setup', agentName: 'Project Setup Agent', dependsOn: [] },
  2: { phase: 'component_registry', agentName: 'Component Agent', dependsOn: ['Project Setup Agent'] },
  3: { phase: 'layout_and_routing', agentName: 'Layout Agent', dependsOn: ['Component Agent'] },
  4: { phase: 'pages_and_features', agentName: 'Page Agent', dependsOn: ['Layout Agent'], concurrentGroup: 'page_and_styling' },
  5: { phase: 'styling_system', agentName: 'Styling Agent', dependsOn: ['Layout Agent'], concurrentGroup: 'page_and_styling' },
  6: { phase: 'integration', agentName: 'Frontend Manager Agent', dependsOn: ['Page Agent', 'Styling Agent'] }
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
  const validPaths = new Set();
  for (const file of fileList) {
    const path = safeNormalizeProjectPath(file?.path);
    if (!path) continue;
    validPaths.add(path);
    normalized.push({ ...file, path });
  }
  return normalized.map((file) => ({
    ...file,
    dependsOn: Array.isArray(file.dependsOn)
      ? file.dependsOn.map(safeNormalizeProjectPath).filter((dependency) => dependency && validPaths.has(dependency))
      : []
  }));
}

function sortBlueprintFilesSafely(fileList = []) {
  const safeFiles = safeBlueprintFiles(fileList);
  try {
    return topologicalSortFiles(safeFiles);
  } catch {
    return safeFiles.map((file) => ({ ...file, dependsOn: [] }));
  }
}

function uniquePush(paths, filePath) {
  const normalized = normalizeProjectPath(filePath);
  if (!paths.includes(normalized)) paths.push(normalized);
}

function classify(filePath) {
  if (setupFiles.includes(filePath)) return 1;
  if (stylingFiles.includes(filePath) || /^src\/(styles|theme|tokens)\//.test(filePath) || /\.(css)$/.test(filePath)) return 5;
  if (/^src\/(components|data|utils|services|store|features)\//.test(filePath)) return 2;
  if (/^src\/(layouts|routes|navigation)\//.test(filePath)) return 3;
  if (/^src\/pages\//.test(filePath)) return 4;
  if (requiredIntegrationFiles.includes(filePath) || filePath === 'src/app/App.jsx') return 6;
  return 4;
}

function chunk(items, size = 8) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

export function buildGenerationBatches(blueprint = {}) {
  const paths = [];
  setupFiles.forEach((filePath) => uniquePush(paths, filePath));

  const blueprintFiles = Array.isArray(blueprint.fileList) ? sortBlueprintFilesSafely(blueprint.fileList) : [];
  for (const file of blueprintFiles) uniquePush(paths, file.path);

  uniquePush(paths, 'src/data/mockData.js');
  uniquePush(paths, 'src/components/AppShell.jsx');
  uniquePush(paths, 'src/components/DataCard.jsx');

  const routes = Array.isArray(blueprint.routes) ? blueprint.routes : [];
  for (const route of routes) {
    const component = String(route.component || '').replace(/[^A-Za-z0-9]/g, '') || 'GeneratedPage';
    uniquePush(paths, 'src/pages/' + component + '.jsx');
  }

  stylingFiles.forEach((filePath) => uniquePush(paths, filePath));
  requiredIntegrationFiles.forEach((filePath) => uniquePush(paths, filePath));

  const grouped = new Map();
  for (const filePath of paths) {
    const group = classify(filePath);
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push(filePath);
  }

  const batches = [];
  for (const group of [1, 2, 3, 4, 5, 6]) {
    const groupFiles = grouped.get(group) || [];
    const meta = phaseMeta[group];
    for (const files of chunk(groupFiles, group === 1 ? 10 : 20)) {
      batches.push({
        batchNumber: batches.length + 1,
        phase: meta.phase,
        agentName: meta.agentName,
        dependsOn: meta.dependsOn,
        concurrentGroup: meta.concurrentGroup || null,
        files
      });
    }
  }
  return batches;
}

export function buildAgentExecutionStages(batches = []) {
  const byPhase = new Map();
  for (const batch of batches) {
    if (!byPhase.has(batch.phase)) byPhase.set(batch.phase, []);
    byPhase.get(batch.phase).push(batch);
  }
  const stage = (phase, parallel = false) => ({ phase, parallel, batches: byPhase.get(phase) || [] });
  return [
    stage('project_setup'),
    stage('component_registry'),
    stage('layout_and_routing'),
    { phase: 'page_and_styling', parallel: true, batches: [...(byPhase.get('pages_and_features') || []), ...(byPhase.get('styling_system') || [])] },
    stage('integration')
  ].filter((item) => item.batches.length);
}
