import { normalizeProjectPath, languageForPath } from '../generation/pathSafety.js';
import { toPlainGeneratedFiles } from '../generation/generatedFileObjects.js';

const createRoots = ['src/pages/', 'src/components/', 'src/layouts/', 'src/hooks/', 'src/utils/', 'src/data/'];
const createExtensions = ['.js', '.jsx', '.css', '.json'];
const operations = new Set(['create', 'update', 'delete']);

export function validateEditOperations(existingFiles, proposedChanges, approvedTargets, message) {
  const existingPaths = (existingFiles || []).map((file) => normalizeProjectPath(file.path));
  if (new Set(existingPaths).size !== existingPaths.length) throw new Error('The existing project contains duplicate file paths.');
  const existing = new Map((existingFiles || []).map((file) => [normalizeProjectPath(file.path), file]));
  const approved = new Set((approvedTargets || []).map(normalizeProjectPath));
  const seen = new Set();
  const normalized = [];
  const explicitDelete = hasExplicitDeleteIntent(message);
  for (const proposed of proposedChanges || []) {
    const operation = proposed.operation || proposed.changeType || 'update';
    const rawPath = String(proposed.path || '').trim();
    if (rawPath.startsWith('/') || rawPath.startsWith('\\')) throw new Error('Edit operation paths must be relative.');
    if (!operations.has(operation)) throw new Error('Unsupported edit operation: ' + operation);
    const path = normalizeProjectPath(proposed.path);
    if (seen.has(path)) throw new Error('Duplicate edit operation path: ' + path);
    seen.add(path);
    const current = existing.get(path);
    if (operation === 'create') {
      if (current) throw new Error('Create cannot overwrite an existing file: ' + path);
      if (!isSafeCreatePath(path)) throw new Error('New files are not allowed at this frontend path: ' + path);
      if (typeof proposed.content !== 'string' || !proposed.content.trim()) throw new Error('Created file content is required: ' + path);
    }
    if (operation === 'update') {
      if (!current) throw new Error('Update requires an existing file: ' + path);
      if (!approved.has(path)) throw new Error('Update is outside the approved integration targets: ' + path);
      if (typeof proposed.content !== 'string' || !proposed.content.trim()) throw new Error('Updated file content is required: ' + path);
    }
    if (operation === 'delete') {
      if (!explicitDelete) throw new Error('Delete requires explicit user intent.');
      if (!current) throw new Error('Delete requires an existing file: ' + path);
      if (!approved.has(path)) throw new Error('Delete is outside the approved targets: ' + path);
    }
    normalized.push({ operation, path, language: proposed.language || languageForPath(path), content: operation === 'delete' ? '' : proposed.content, reason: proposed.reason || operation + ' ' + path, addressesFindingIds: proposed.addressesFindingIds || [] });
  }
  return normalized;
}

export function applyEditOperationsToFiles(existingFiles, changes, operationId = '') {
  const byPath = new Map(toPlainGeneratedFiles(existingFiles).map((file) => [file.path, file]));
  const now = new Date();
  for (const change of changes) {
    if (change.operation === 'delete') {
      byPath.delete(change.path);
      continue;
    }
    const previous = byPath.get(change.path);
    byPath.set(change.path, {
      ...(previous || {}),
      path: change.path,
      language: change.language || languageForPath(change.path),
      content: change.content,
      version: previous ? (previous.version || 1) + 1 : 1,
      generatedAt: previous?.generatedAt || now,
      updatedAt: now,
      lastOperation: 'edit',
      lastOperationId: operationId
    });
  }
  return [...byPath.values()];
}

export function isSafeCreatePath(path) {
  const basename = path.split('/').pop().toLowerCase();
  if (basename.startsWith('.env') || basename.includes('secret') || basename.includes('config')) return false;
  return createRoots.some((root) => path.startsWith(root)) && createExtensions.some((extension) => path.endsWith(extension));
}

function hasExplicitDeleteIntent(message) {
  const words = new Set(String(message || '').toLowerCase().match(/[a-z]+/g) || []);
  return words.has('delete') || words.has('remove');
}
