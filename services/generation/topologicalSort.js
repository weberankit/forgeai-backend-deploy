import { httpError } from '../../utils/httpError.js';
import { normalizeProjectPath } from './pathSafety.js';

export function topologicalSortFiles(fileList = []) {
  const normalizedFiles = fileList.map((file) => ({
    ...file,
    path: normalizeProjectPath(file.path),
    dependsOn: Array.isArray(file.dependsOn) ? file.dependsOn.map(normalizeProjectPath) : []
  }));
  const byPath = new Map();
  for (const file of normalizedFiles) {
    if (byPath.has(file.path)) throw httpError(400, 'Duplicate blueprint file path: ' + file.path);
    byPath.set(file.path, file);
  }

  const missingDependencies = [];
  for (const file of normalizedFiles) {
    for (const dependency of file.dependsOn) {
      if (!byPath.has(dependency)) missingDependencies.push(file.path + ' depends on missing ' + dependency);
    }
  }
  if (missingDependencies.length) throw httpError(400, missingDependencies.join('; '));

  const sorted = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(file) {
    if (visited.has(file.path)) return;
    if (visiting.has(file.path)) throw httpError(400, 'Circular blueprint dependency detected at ' + file.path);
    visiting.add(file.path);
    for (const dependency of file.dependsOn) visit(byPath.get(dependency));
    visiting.delete(file.path);
    visited.add(file.path);
    sorted.push(file);
  }

  for (const file of normalizedFiles) visit(file);
  return sorted;
}
