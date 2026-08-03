import path from 'path';
import { httpError } from '../../utils/httpError.js';
import { assertUniquePaths, normalizeProjectPath } from './pathSafety.js';
import { sanitizePackageJson, validatePackageJson } from './packageSafety.js';
import { validateProjectSymbols } from '../review/symbolValidation.js';
import { toPlainGeneratedFile } from './generatedFileObjects.js';

const requiredFiles = ['package.json', 'index.html', 'src/main.jsx', 'src/App.jsx'];
const blockedPathPatterns = [/^server\//i, /^api\//i, /Dockerfile/i, /docker-compose/i, /auth/i, /jwt/i, /oauth/i, /mongoose/i, /mongodb/i, /express/i];
const importRegex = /import\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g;

export function validateGeneratedFiles(files, targetFiles = [], manifest = null) {
  const normalized = normalizeAndValidateFileBasics(files);
  const pathSet = new Set(normalized.map((file) => file.path));
  for (const requiredFile of requiredFiles) {
    if (!pathSet.has(requiredFile)) throw httpError(400, 'Generated project is missing required file: ' + requiredFile);
  }
  assertTargetsReturned(pathSet, targetFiles);
  validateRelativeImports(normalized, pathSet);
  assertSymbols(normalized);
  assertManifestExports(normalized, manifest);
  return normalized;
}

export function validateGenerationBatch(files, targetFiles, existingFiles = [], manifest = null) {
  const normalized = normalizeAndValidateFileBasics(files);
  const pathSet = new Set(normalized.map((file) => file.path));
  assertTargetsReturned(pathSet, targetFiles);
  const combined = normalizeAndValidateFileBasics(mergeFiles(existingFiles, files));
  validateRelativeImports(combined, new Set(combined.map((file) => file.path)), pathSet);
  assertSymbols(combined, pathSet);
  assertManifestExports(combined, manifest, pathSet);
  return normalized;
}

function assertManifestExports(files, manifest, scopedPathSet = null) {
  if (!manifest?.files) return;
  const validation = validateProjectSymbols(files);
  const errors = [];
  for (const [filePath, contract] of Object.entries(manifest.files)) {
    if (scopedPathSet && !scopedPathSet.has(filePath)) continue;
    const table = validation.tables[filePath];
    if (!table) continue;
    for (const expected of contract.expectedExports || []) {
      if (expected === 'default' && table.defaultExports === 0) errors.push(filePath + ' must provide its planned default export');
      if (expected !== 'default' && !table.namedExports.has(expected)) errors.push(filePath + ' must provide planned export ' + expected);
    }
  }
  if (errors.length) throw httpError(400, errors.join('; '));
}

export function mergeFiles(existingFiles, newFiles) {
  const map = new Map();
  for (const file of existingFiles || []) {
    const plain = toPlainGeneratedFile(file);
    map.set(plain.path, plain);
  }
  for (const file of newFiles || []) {
    const plain = toPlainGeneratedFile(file);
    map.set(plain.path, plain);
  }
  return Array.from(map.values());
}

function normalizeAndValidateFileBasics(files) {
  if (!Array.isArray(files) || files.length === 0) throw httpError(400, 'No generated files returned.');
  if (files.length > 80) throw httpError(400, 'Generated project exceeds file count limit.');
  const normalized = files.map((file) => {
    const normalizedPath = normalizeProjectPath(file.path);
    const content = normalizedPath === 'package.json' ? sanitizePackageJson(String(file.content || '')) : String(file.content || '');
    return { ...file, path: normalizedPath, content };
  });
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

function assertSymbols(files, scopedPathSet = null) {
  const validation = validateProjectSymbols(files);
  const errors = scopedPathSet
    ? validation.errors.filter((item) => isScopedFinding(item, scopedPathSet))
    : validation.errors;
  if (errors.length) {
    const error = httpError(400, errors.map((item) => (item.file ? item.file + (item.line ? ':' + item.line : '') + ': ' : '') + item.message).join('; '));
    error.findings = errors;
    throw error;
  }
}

function assertTargetsReturned(pathSet, targetFiles = []) {
  const missing = [];
  for (const targetFile of targetFiles) {
    const normalizedTarget = normalizeProjectPath(targetFile);
    if (!pathSet.has(normalizedTarget)) missing.push(normalizedTarget);
  }
  if (missing.length) throw httpError(400, 'Generation batch did not return target files: ' + missing.join(', '));
}

function validateRelativeImports(files, pathSet, scopedPathSet = null) {
  const unresolved = [];
  for (const file of files) {
    if (!/\.(jsx|js)$/.test(file.path)) continue;
    if (scopedPathSet && !scopedPathSet.has(file.path)) continue;
    const dir = path.posix.dirname(file.path);
    importRegex.lastIndex = 0;
    let match;
    while ((match = importRegex.exec(file.content))) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const base = normalizeProjectPath(path.posix.join(dir, specifier));
      const candidates = [base, base + '.js', base + '.jsx', base + '.css', path.posix.join(base, 'index.js'), path.posix.join(base, 'index.jsx')];
      if (!candidates.some((candidate) => pathSet.has(candidate))) {
        unresolved.push(file.path + ': ' + specifier);
      }
    }
  }
  if (unresolved.length) throw httpError(400, 'Relative imports do not resolve: ' + unresolved.join('; '));
}

function isScopedFinding(item, scopedPathSet) {
  if (!item.file) return true;
  let filePath = item.file;
  try { filePath = normalizeProjectPath(item.file); } catch {}
  if (scopedPathSet.has(filePath)) return true;
  return [...scopedPathSet].some((targetPath) => String(item.message || '').includes(targetPath));
}
