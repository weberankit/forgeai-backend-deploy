import { topologicalSortFiles } from './topologicalSort.js';
import { normalizeProjectPath } from './pathSafety.js';

const baseFiles = [
  'package.json',
  'index.html',
  'vite.config.js',
  'tailwind.config.js',
  'postcss.config.js',
  'src/index.css'
];
const requiredIntegrationFiles = ['src/App.jsx', 'src/main.jsx'];

function uniquePush(paths, filePath) {
  const normalized = normalizeProjectPath(filePath);
  if (!paths.includes(normalized)) paths.push(normalized);
}

function classify(filePath) {
  if (baseFiles.includes(filePath)) return 1;
  if (/^src\/(utils|data|services|store|features)\//.test(filePath)) return 2;
  if (/^src\/components\//.test(filePath)) return 3;
  if (/^src\/(layouts|routes|navigation)\//.test(filePath)) return 4;
  if (/^src\/(pages|features)\//.test(filePath)) return 5;
  if (requiredIntegrationFiles.includes(filePath) || filePath === 'src/app/App.jsx') return 6;
  return 5;
}

function chunk(items, size = 8) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

export function buildGenerationBatches(blueprint = {}) {
  const paths = [];
  baseFiles.forEach((filePath) => uniquePush(paths, filePath));

  const blueprintFiles = Array.isArray(blueprint.fileList) ? topologicalSortFiles(blueprint.fileList) : [];
  for (const file of blueprintFiles) uniquePush(paths, file.path);

  uniquePush(paths, 'src/data/mockData.js');
  uniquePush(paths, 'src/components/AppShell.jsx');
  uniquePush(paths, 'src/components/DataCard.jsx');

  const routes = Array.isArray(blueprint.routes) ? blueprint.routes : [];
  for (const route of routes) {
    const component = String(route.component || '').replace(/[^A-Za-z0-9]/g, '') || 'GeneratedPage';
    uniquePush(paths, 'src/pages/' + component + '.jsx');
  }

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
    for (const files of chunk(groupFiles, group === 1 ? 10 : 8)) {
      batches.push({ batchNumber: batches.length + 1, phase: phaseName(group), files });
    }
  }
  return batches;
}

function phaseName(group) {
  return {
    1: 'project_configuration',
    2: 'data_and_state',
    3: 'shared_components',
    4: 'layout_and_routing',
    5: 'pages_and_features',
    6: 'integration'
  }[group];
}
