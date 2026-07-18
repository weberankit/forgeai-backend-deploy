import path from 'path';
import * as parser from '@babel/parser';
import { mergeFiles } from './generatedFileValidation.js';
import { normalizeProjectPath } from './pathSafety.js';
import { validateProjectSymbols } from '../review/symbolValidation.js';

export function runDeterministicRepairs(previousFiles = [], proposedFiles = [], manifest = null) {
  const proposedPaths = new Set(proposedFiles.map((file) => normalizeProjectPath(file.path)));
  let combined = mergeFiles(previousFiles, proposedFiles);
  const repairs = [];
  combined = combined.map((file) => proposedPaths.has(file.path) ? repairDuplicateStatements(file, repairs) : file);
  combined = repairRelativePaths(combined, proposedPaths, manifest, repairs);
  const repaired = combined.filter((file) => proposedPaths.has(file.path));
  return { files: repaired, repairs, validation: validateProjectSymbols(combined) };
}

function repairDuplicateStatements(file, repairs) {
  if (!/\.(js|jsx)$/.test(file.path)) return file;
  let ast;
  try { ast = parser.parse(file.content, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true, ranges: true }); } catch { return file; }
  const seen = new Map();
  const exportedNames = new Set();
  const removals = [];
  for (const statement of ast.program.body) {
    if (statement.type === 'ExportNamedDeclaration') {
      const names = exportStatementNames(statement);
      if (names.length && names.every((name) => exportedNames.has(name))) {
        removals.push([statement.start, statement.end]);
        repairs.push({ code: statement.declaration ? 'DUPLICATE_DECLARATION' : 'DUPLICATE_NAMED_EXPORT', file: file.path, line: statement.loc?.start.line, action: statement.declaration ? 'Removed a repeated exported declaration.' : 'Removed a redundant named export statement.' });
        continue;
      }
      names.forEach((name) => exportedNames.add(name));
    }
    const key = safeStatementKey(statement, file.content);
    if (!key) continue;
    if (seen.has(key)) {
      removals.push([statement.start, statement.end]);
      repairs.push({ code: repairCode(statement), file: file.path, line: statement.loc?.start.line, action: 'Removed an exact duplicate top-level statement.' });
    } else seen.set(key, statement);
  }
  if (!removals.length) return file;
  let content = file.content;
  for (const [start, end] of removals.sort((a, b) => b[0] - a[0])) content = content.slice(0, start) + content.slice(end).replace(/^\s*\n/, '\n');
  return { ...file, content };
}

function exportStatementNames(statement) {
  const names = [];
  const declaration = statement.declaration;
  if (declaration?.id?.name) names.push(declaration.id.name);
  for (const item of declaration?.declarations || []) if (item.id?.name) names.push(item.id.name);
  for (const item of statement.specifiers || []) if (item.exported?.name && item.exported.name !== 'default') names.push(item.exported.name);
  return names;
}

function safeStatementKey(statement, content) {
  if (!['ImportDeclaration', 'VariableDeclaration', 'FunctionDeclaration', 'ClassDeclaration', 'ExportNamedDeclaration', 'ExportDefaultDeclaration'].includes(statement.type)) return null;
  const text = content.slice(statement.start, statement.end).replace(/\s+/g, ' ').trim();
  return statement.type + ':' + text;
}

function repairCode(statement) {
  if (statement.type === 'ImportDeclaration') return 'DUPLICATE_IMPORT';
  if (statement.type === 'ExportDefaultDeclaration') return 'MULTIPLE_DEFAULT_EXPORTS';
  if (statement.type === 'ExportNamedDeclaration') return 'DUPLICATE_NAMED_EXPORT';
  return 'DUPLICATE_DECLARATION';
}

function repairRelativePaths(files, proposedPaths, manifest, repairs) {
  const fileMap = new Map(files.map((file) => [normalizeProjectPath(file.path), file]));
  return files.map((file) => {
    if (!proposedPaths.has(file.path) || !/\.(js|jsx)$/.test(file.path)) return file;
    let ast;
    try { ast = parser.parse(file.content, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true }); } catch { return file; }
    const replacements = [];
    for (const statement of ast.program.body) {
      if (statement.type !== 'ImportDeclaration' || !statement.source.value.startsWith('.')) continue;
      if (resolve(file.path, statement.source.value, fileMap)) continue;
      const basename = path.posix.basename(statement.source.value).replace(/\.(js|jsx|css)$/, '').toLowerCase();
      const candidates = [...fileMap.keys()].filter((candidate) => path.posix.basename(candidate).replace(/\.(js|jsx|css)$/, '').toLowerCase() === basename);
      const contracted = Object.keys(manifest?.files || {}).filter((candidate) => path.posix.basename(candidate).replace(/\.(js|jsx|css)$/, '').toLowerCase() === basename && fileMap.has(candidate));
      const unique = [...new Set([...contracted, ...candidates])];
      if (unique.length !== 1) continue;
      let relative = path.posix.relative(path.posix.dirname(file.path), unique[0]).replace(/\.(js|jsx)$/, '');
      if (!relative.startsWith('.')) relative = './' + relative;
      replacements.push([statement.source.start + 1, statement.source.end - 1, relative]);
      repairs.push({ code: 'WRONG_RELATIVE_IMPORT_PATH', file: file.path, line: statement.loc?.start.line, action: 'Repointed ' + statement.source.value + ' to ' + relative + '.' });
    }
    let content = file.content;
    for (const [start, end, value] of replacements.sort((a, b) => b[0] - a[0])) content = content.slice(0, start) + value + content.slice(end);
    return { ...file, content };
  });
}

function resolve(from, source, fileMap) {
  const base = normalizeProjectPath(path.posix.join(path.posix.dirname(from), source));
  return [base, base + '.js', base + '.jsx', base + '.css', base + '/index.js', base + '/index.jsx'].find((candidate) => fileMap.has(candidate));
}
