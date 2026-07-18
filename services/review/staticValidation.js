import * as parser from '@babel/parser';
import { validatePackageJson } from '../generation/packageSafety.js';
import { normalizeProjectPath } from '../generation/pathSafety.js';
import { buildDependencyGraph, findCircularImports } from './dependencyGraph.js';
import { validateProjectSymbols } from './symbolValidation.js';
import { validateRouteIntegration } from './routeValidation.js';

const requiredFiles = ['package.json', 'index.html', 'src/main.jsx', 'src/App.jsx'];
const blockedPatterns = [/^server\//i, /^api\//i, /Dockerfile/i, /docker-compose/i, /auth/i, /jwt/i, /oauth/i, /mongoose/i, /mongodb/i, /express/i];

export function runStaticValidation(files = []) {
  const errors = [];
  const warnings = [];
  const normalized = [];
  const seen = new Set();

  for (const file of files) {
    try {
      const filePath = normalizeProjectPath(file.path);
      if (seen.has(filePath)) errors.push(issue('duplicate_path', 'Duplicate generated file path: ' + filePath, filePath));
      seen.add(filePath);
      if (blockedPatterns.some((pattern) => pattern.test(filePath))) errors.push(issue('disallowed_path', 'Disallowed frontend project path: ' + filePath, filePath));
      normalized.push({ ...file, path: filePath, content: String(file.content || '') });
    } catch (error) {
      errors.push(issue('invalid_path', error.message, file.path || null));
    }
  }

  for (const required of requiredFiles) if (!seen.has(required)) errors.push(issue('missing_required_file', 'Missing required file: ' + required, required));
  const pkg = normalized.find((file) => file.path === 'package.json');
  if (pkg) {
    try { validatePackageJson(pkg.content); } catch (error) { errors.push(issue('invalid_package_json', error.message, 'package.json')); }
  }

  const graph = buildDependencyGraph(normalized);
  for (const [filePath, node] of Object.entries(graph)) {
    if (node.parseError) errors.push(issue('jsx_parse_error', node.parseError, filePath));
    for (const missing of node.missingImports || []) errors.push(issue('missing_relative_import', 'Missing relative import: ' + missing, filePath));
    if (!node.exports.length && /\.(jsx|js)$/.test(filePath) && !filePath.endsWith('main.jsx')) warnings.push(issue('missing_export', 'No export detected in module.', filePath));
  }
  for (const cycle of findCircularImports(graph)) warnings.push(issue('circular_import', 'Circular import warning: ' + cycle.join(' -> '), cycle[0]));

  for (const file of normalized) {
    if (/\.(jsx|js)$/.test(file.path)) {
      if (new RegExp("from\\s+['\"](express|mongoose|mongodb|jsonwebtoken|next|next/)").test(file.content)) errors.push(issue('backend_import', 'Backend/auth import detected.', file.path));
      if (/process\.env|import\.meta\.env\.(?!MODE|DEV|PROD)/.test(file.content)) errors.push(issue('secret_access', 'Generated code may not access platform secrets.', file.path));
      try { parser.parse(file.content, { sourceType: 'module', plugins: ['jsx'] }); } catch (error) { errors.push(issue('parse_error', error.message, file.path)); }
    }
  }

  const symbolValidation = validateProjectSymbols(normalized);
  const existing = new Set(errors.map((item) => [item.code, item.file, item.line, item.symbol].join(':')));
  for (const finding of symbolValidation.errors) {
    const key = [finding.code, finding.file, finding.line, finding.symbol].join(':');
    if (!existing.has(key)) errors.push(finding);
  }
  const routeValidation = validateRouteIntegration(normalized);
  errors.push(...routeValidation.errors);

  return { passed: errors.length === 0, errors, warnings, graph, symbols: symbolValidation.tables, routeValidation };
}

function issue(code, message, file) {
  return { code, message, file };
}
