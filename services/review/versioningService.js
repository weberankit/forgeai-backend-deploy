import { randomUUID } from 'crypto';
import { normalizeProjectPath } from '../generation/pathSafety.js';
import { upsertGeneratedFiles } from '../generation/codeGenerationService.js';

export function createSnapshot(project, operationType, message = '') {
  project.fileSnapshots = project.fileSnapshots || [];
  project.fileSnapshots.push({
    snapshotId: randomUUID(),
    operationType,
    message,
    files: (project.generatedFiles || []).map((file) => ({ ...file })),
    createdAt: new Date()
  });
  if (project.fileSnapshots.length > 10) project.fileSnapshots = project.fileSnapshots.slice(-10);
}

export function applyFileChanges(project, changes, operationType, operationId) {
  const normalized = changes.map((change) => ({
    path: normalizeProjectPath(change.path),
    language: change.language || inferLanguage(change.path),
    content: String(change.content || ''),
    lastOperation: operationType,
    lastOperationId: operationId
  }));
  project.generatedFiles = upsertGeneratedFiles(project.generatedFiles || [], normalized).map((file) => {
    const changed = normalized.find((candidate) => candidate.path === file.path);
    return changed ? { ...file, lastOperation: operationType, lastOperationId: operationId } : file;
  });
  project.lastChangedFiles = normalized.map((file) => file.path);
  return project.generatedFiles;
}

export function restoreLatestSnapshot(project) {
  const snapshot = project.fileSnapshots?.[project.fileSnapshots.length - 1];
  if (!snapshot) return null;
  project.generatedFiles = snapshot.files.map((file) => ({ ...file, updatedAt: new Date() }));
  project.lastChangedFiles = snapshot.files.map((file) => file.path);
  project.operationStatus = 'restored';
  return snapshot;
}

function inferLanguage(filePath) {
  if (filePath.endsWith('.jsx')) return 'jsx';
  if (filePath.endsWith('.js')) return 'javascript';
  if (filePath.endsWith('.css')) return 'css';
  if (filePath.endsWith('.json')) return 'json';
  if (filePath.endsWith('.html')) return 'html';
  return 'text';
}
