import path from 'path';
import { httpError } from '../../utils/httpError.js';

const blockedSegments = new Set(['..', '.git', 'node_modules', '.env']);
const blockedNames = new Set(['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml']);
const backendPatterns = [/^server\//i, /^api\//i, /express/i, /mongoose/i, /mongodb/i, /jwt/i, /oauth/i, /auth/i];
const allowedRootFiles = new Set(['package.json', 'index.html', 'vite.config.js', 'tailwind.config.js', 'postcss.config.js']);

export function normalizeProjectPath(filePath) {
  const clean = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!clean) throw httpError(400, 'Generated file path is required.');
  if (path.posix.isAbsolute(clean)) throw httpError(400, 'Generated file paths must be relative.');
  const normalized = path.posix.normalize(clean);
  const segments = normalized.split('/');
  if (segments.some((segment) => blockedSegments.has(segment))) {
    throw httpError(400, 'Invalid generated file path: ' + filePath);
  }
  if (blockedNames.has(path.posix.basename(normalized))) {
    throw httpError(400, 'Generated file is not allowed: ' + filePath);
  }
  if (!normalized.startsWith('src/') && !allowedRootFiles.has(normalized)) {
    throw httpError(400, 'Generated file must be inside src/ or be an allowed config file: ' + filePath);
  }
  if (backendPatterns.some((pattern) => pattern.test(normalized))) {
    throw httpError(400, 'Backend/auth file paths are not allowed: ' + filePath);
  }
  return normalized;
}

export function assertUniquePaths(files) {
  const seen = new Set();
  for (const file of files) {
    const normalized = normalizeProjectPath(file.path);
    if (seen.has(normalized)) throw httpError(400, 'Duplicate generated file path: ' + normalized);
    seen.add(normalized);
  }
}

export function languageForPath(filePath) {
  if (filePath.endsWith('.jsx')) return 'jsx';
  if (filePath.endsWith('.js')) return 'javascript';
  if (filePath.endsWith('.css')) return 'css';
  if (filePath.endsWith('.html')) return 'html';
  if (filePath.endsWith('.json')) return 'json';
  return 'text';
}
