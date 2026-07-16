import path from 'path';
import { httpError } from '../../utils/httpError.js';
import { assertUniquePaths, normalizeProjectPath } from './pathSafety.js';
import { validatePackageJson } from './packageSafety.js';

const requiredFiles = ['package.json', 'index.html', 'src/main.jsx', 'src/App.jsx'];
const blockedPathPatterns = [/^server\//i, /^api\//i, /Dockerfile/i, /docker-compose/i, /auth/i, /jwt/i, /oauth/i, /mongoose/i, /mongodb/i, /express/i];
const importRegex = /import\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g;

export function validateGeneratedFiles(files, targetFiles = []) {
  const normalized = normalizeAndValidateFileBasics(files);
  const pathSet = new Set(normalized.map((file) => file.path));
  for (const requiredFile of requiredFiles) {
    if (!pathSet.has(requiredFile)) throw httpError(400, 'Generated project is missing required file: ' + requiredFile);
  }
  assertTargetsReturned(pathSet, targetFiles);
  validateRelativeImports(normalized, pathSet);
  return normalized;
}

export function validateGenerationBatch(files, targetFiles, existingFiles = []) {
  const normalized = normalizeAndValidateFileBasics(files);
  const pathSet = new Set(normalized.map((file) => file.path));
  assertTargetsReturned(pathSet, targetFiles);
  normalizeAndValidateFileBasics(mergeFiles(existingFiles, files));
  return normalized;
}

export function mergeFiles(existingFiles, newFiles) {
  const map = new Map();
  for (const file of existingFiles || []) map.set(normalizeProjectPath(file.path), { ...file, path: normalizeProjectPath(file.path) });
  for (const file of newFiles || []) map.set(normalizeProjectPath(file.path), { ...file, path: normalizeProjectPath(file.path), content: String(file.content || '') });
  return Array.from(map.values());
}

function normalizeAndValidateFileBasics(files) {
  if (!Array.isArray(files) || files.length === 0) throw httpError(400, 'No generated files returned.');
  if (files.length > 80) throw httpError(400, 'Generated project exceeds file count limit.');
  const normalized = files.map((file) => ({
    ...file,
    path: normalizeProjectPath(file.path),
    content: String(file.content || '')
  }));
  assertUniquePaths(normalized);
  for (const file of normalized) {
    if (file.content.length > 180000) throw httpError(400, 'Generated file exceeds size limit: ' + file.path);
    if (blockedPathPatterns.some((pattern) => pattern.test(file.path))) throw httpError(400, 'Disallowed generated file path: ' + file.path);
    if (new RegExp("from\\s+['\"](express|mongoose|mongodb|jsonwebtoken|next|next/)").test(file.content)) {
      throw httpError(400, 'Generated file imports disallowed backend/auth packages: ' + file.path);
    }
    if (/process\.env|import\.meta\.env\.(?!MODE|DEV|PROD)/.test(file.content)) {
      throw httpError(400, 'Generated file may not read platform environment secrets: ' + file.path);
    }
    if (file.path === 'package.json') validatePackageJson(file.content);
  }
  return normalized;
}

function assertTargetsReturned(pathSet, targetFiles = []) {
  for (const targetFile of targetFiles) {
    const normalizedTarget = normalizeProjectPath(targetFile);
    if (!pathSet.has(normalizedTarget)) throw httpError(400, 'Generation batch did not return target file: ' + normalizedTarget);
  }
}

function validateRelativeImports(files, pathSet) {
  for (const file of files) {
    if (!/\.(jsx|js)$/.test(file.path)) continue;
    const dir = path.posix.dirname(file.path);
    importRegex.lastIndex = 0;
    let match;
    while ((match = importRegex.exec(file.content))) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const base = normalizeProjectPath(path.posix.join(dir, specifier));
      const candidates = [base, base + '.js', base + '.jsx', base + '.css', path.posix.join(base, 'index.js'), path.posix.join(base, 'index.jsx')];
      if (!candidates.some((candidate) => pathSet.has(candidate))) {
        throw httpError(400, 'Relative import does not resolve in ' + file.path + ': ' + specifier);
      }
    }
  }
}
