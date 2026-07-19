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
  combined = repairImportExportContracts(combined, proposedPaths, repairs);
  combined = repairManifestExports(combined, proposedPaths, manifest, repairs);
  combined = repairUndefinedRenderedComponents(combined, proposedPaths, repairs);
  combined = repairRouteContracts(combined, proposedPaths, repairs);
  combined = combined.map((file) => proposedPaths.has(file.path) ? repairDuplicateStatements(file, repairs) : file);
  const repaired = combined.filter((file) => proposedPaths.has(file.path));
  return { files: repaired, repairs, validation: validateProjectSymbols(combined) };
}

function repairManifestExports(files, proposedPaths, manifest, repairs) {
  if (!manifest?.files) return files;
  return files.map((file) => {
    const filePath = normalizeProjectPath(file.path);
    if (!proposedPaths.has(filePath) || !/\.(js|jsx)$/.test(filePath)) return file;
    const expected = manifest.files[filePath]?.expectedExports || [];
    if (!expected.length) return file;
    const table = analyzeExports(file);
    const additions = [];
    if (expected.includes('default') && table.defaultExports === 0) {
      const componentName = path.posix.basename(filePath).replace(/\.(js|jsx)$/, '');
      const candidate = table.declarations.has(componentName) ? componentName : table.namedExports.has(componentName) ? componentName : [...table.namedExports][0] || [...table.declarations][0];
      if (candidate) {
        additions.push('export default ' + candidate + ';');
        repairs.push({ code: 'MISSING_PLANNED_DEFAULT_EXPORT', file: filePath, line: null, action: 'Added the manifest-required default export for ' + candidate + '.' });
      }
    }
    for (const name of expected.filter((item) => item !== 'default')) {
      if (!table.namedExports.has(name) && table.declarations.has(name)) {
        additions.push('export { ' + name + ' };');
        repairs.push({ code: 'MISSING_PLANNED_NAMED_EXPORT', file: filePath, line: null, action: 'Added the manifest-required named export ' + name + '.' });
      }
    }
    return additions.length ? { ...file, content: String(file.content || '').replace(/\s*$/, '\n\n') + additions.join('\n') + '\n' } : file;
  });
}

function repairDuplicateStatements(file, repairs) {
  if (!/\.(js|jsx)$/.test(file.path)) return file;
  let ast;
  try { ast = parser.parse(file.content, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true, ranges: true }); } catch { return file; }
  const seen = new Map();
  const declaredNames = new Set();
  const exportedNames = new Set();
  const removals = [];
  for (const statement of ast.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement;
    const names = declarationNames(declaration);
    const duplicateNames = names.filter((name) => declaredNames.has(name));
    if (duplicateNames.length) {
      removals.push([statement.start, statement.end]);
      repairs.push({ code: 'DUPLICATE_DECLARATION', file: file.path, line: statement.loc?.start.line, action: 'Removed repeated top-level declaration(s): ' + [...new Set(duplicateNames)].join(', ') + '.' });
      continue;
    }
    names.forEach((name) => declaredNames.add(name));
    if (statement.type === 'ExportNamedDeclaration') {
      const exportNames = exportStatementNames(statement);
      if (exportNames.length && exportNames.every((name) => exportedNames.has(name))) {
        removals.push([statement.start, statement.end]);
        repairs.push({ code: statement.declaration ? 'DUPLICATE_DECLARATION' : 'DUPLICATE_NAMED_EXPORT', file: file.path, line: statement.loc?.start.line, action: statement.declaration ? 'Removed a repeated exported declaration.' : 'Removed a redundant named export statement.' });
        continue;
      }
      exportNames.forEach((name) => exportedNames.add(name));
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
  for (const item of declaration?.declarations || []) names.push(...bindingNames(item.id));
  for (const item of statement.specifiers || []) {
    const exported = item.exported?.name || item.exported?.value;
    if (exported && exported !== 'default') names.push(exported);
  }
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


function repairImportExportContracts(files, proposedPaths, repairs) {
  const fileMap = new Map(files.map((file) => [normalizeProjectPath(file.path), { ...file, path: normalizeProjectPath(file.path), content: String(file.content || '') }]));
  const tables = new Map();
  for (const file of fileMap.values()) if (/\.(js|jsx)$/.test(file.path)) tables.set(file.path, analyzeExports(file));

  const replacementsByFile = new Map();
  const appendsByFile = new Map();

  for (const file of fileMap.values()) {
    if (!/\.(js|jsx)$/.test(file.path)) continue;
    let ast;
    try { ast = parser.parse(file.content, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true, ranges: true }); } catch { continue; }
    for (const statement of ast.program.body) {
      if (statement.type !== 'ImportDeclaration' || !statement.source.value.startsWith('.')) continue;
      const resolved = resolve(file.path, statement.source.value, fileMap);
      if (!resolved || !tables.has(resolved)) continue;
      const targetTable = tables.get(resolved);
      const importInfo = parseImportInfo(statement);
      let nextInfo = null;

      const defaultSpecifier = importInfo.defaultLocal;
      if (defaultSpecifier && targetTable.defaultExports === 0) {
        const exportName = bestNamedExportForDefault(defaultSpecifier, targetTable);
        if (exportName && proposedPaths.has(resolved)) {
          queueAppend(appendsByFile, resolved, '\nexport default ' + exportName + ';\n');
          targetTable.defaultExports = 1;
          repairs.push({ code: 'MISSING_DEFAULT_EXPORT', file: resolved, line: null, action: 'Added a default export for ' + exportName + ' to satisfy imports from ' + file.path + '.' });
          continue;
        }
        if (exportName && proposedPaths.has(file.path) && !importInfo.namespaceLocal) {
          nextInfo = cloneImportInfo(importInfo);
          nextInfo.defaultLocal = '';
          addNamedImport(nextInfo, exportName, defaultSpecifier);
          repairs.push({ code: 'DEFAULT_IMPORT_TO_NAMED_IMPORT', file: file.path, line: statement.loc?.start.line, action: 'Rewrote default import from ' + statement.source.value + ' to named import ' + exportName + '.' });
        }
      }

      for (const specifier of importInfo.named) {
        if (targetTable.namedExports.has(specifier.imported)) continue;
        if (proposedPaths.has(resolved) && targetTable.declarations.has(specifier.imported)) {
          queueAppend(appendsByFile, resolved, '\nexport { ' + specifier.imported + ' };\n');
          targetTable.namedExports.add(specifier.imported);
          repairs.push({ code: 'MISSING_NAMED_EXPORT', file: resolved, line: null, action: 'Exported existing declaration ' + specifier.imported + ' for imports from ' + file.path + '.' });
          continue;
        }
        if (proposedPaths.has(file.path) && !importInfo.defaultLocal && targetTable.defaultExports > 0 && canUseDefaultForNamedImport(specifier, targetTable)) {
          nextInfo ||= cloneImportInfo(importInfo);
          nextInfo.defaultLocal = specifier.local;
          nextInfo.named = nextInfo.named.filter((item) => !(item.imported === specifier.imported && item.local === specifier.local));
          repairs.push({ code: 'NAMED_IMPORT_TO_DEFAULT_IMPORT', file: file.path, line: statement.loc?.start.line, action: 'Rewrote named import ' + specifier.imported + ' from ' + statement.source.value + ' to a default import.' });
        }
      }

      if (nextInfo) {
        queueReplacement(replacementsByFile, file.path, statement.start, statement.end, formatImportStatement(nextInfo, statement.source.value));
      }
    }
  }

  for (const [filePath, additions] of appendsByFile.entries()) {
    const file = fileMap.get(filePath);
    if (!file) continue;
    fileMap.set(filePath, { ...file, content: file.content.replace(/\s*$/, '\n') + additions.join('') });
  }
  for (const [filePath, replacements] of replacementsByFile.entries()) {
    const file = fileMap.get(filePath);
    if (!file) continue;
    let content = file.content;
    for (const [start, end, value] of replacements.sort((a, b) => b[0] - a[0])) content = content.slice(0, start) + value + content.slice(end);
    fileMap.set(filePath, { ...file, content });
  }

  return files.map((file) => fileMap.get(normalizeProjectPath(file.path)) || file);
}



function repairUndefinedRenderedComponents(files, proposedPaths, repairs) {
  return files.map((file) => {
    const filePath = normalizeProjectPath(file.path);
    if (!proposedPaths.has(filePath) || !/\.(js|jsx)$/.test(filePath)) return file;
    const content = String(file.content || '');
    const analysis = analyzeRenderedComponents({ ...file, path: filePath, content });
    const missing = [...analysis.rendered].filter((name) => !analysis.available.has(name) && !builtinJsxComponents.has(name));
    if (!missing.length) return file;
    const additions = missing.map((name) => fallbackComponentDeclaration(name)).join('\n');
    for (const name of missing) repairs.push({ code: 'UNDEFINED_RENDERED_COMPONENT', file: filePath, line: null, action: 'Added a safe local fallback component for ' + name + '.' });
    return { ...file, path: filePath, content: content.replace(/\s*$/, '\n\n') + additions + '\n' };
  });
}

const builtinJsxComponents = new Set(['React', 'Fragment', 'Suspense', 'StrictMode']);

function analyzeRenderedComponents(file) {
  const available = new Set();
  const rendered = new Set();
  let ast;
  try { ast = parser.parse(file.content, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true }); } catch { return { available, rendered }; }
  walkAst(ast.program, (node) => {
    if (node.type === 'ImportDeclaration') {
      for (const specifier of node.specifiers || []) if (specifier.local?.name) available.add(specifier.local.name);
    }
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
      if (node.id?.name) available.add(node.id.name);
    }
    if (node.type === 'VariableDeclarator') {
      for (const name of bindingNames(node.id)) available.add(name);
    }
    if (node.type === 'JSXOpeningElement') {
      const name = jsxRootName(node.name);
      if (name && /^[A-Z]/.test(name)) rendered.add(name);
    }
  });
  return { available, rendered };
}

function fallbackComponentDeclaration(name) {
  if (/icon/i.test(name)) {
    return 'function ' + name + "({ className = '', title = '' }) {\n  return <span className={className} aria-hidden={title ? undefined : true} aria-label={title || undefined}>✦</span>;\n}\n";
  }
  return 'function ' + name + "({ children, className = '', title = '', label = '', ...props }) {\n  return <div className={className} {...props}>{children || title || label || null}</div>;\n}\n";
}

function jsxRootName(node) {
  if (!node) return '';
  if (node.type === 'JSXIdentifier') return node.name;
  if (node.type === 'JSXMemberExpression') return jsxRootName(node.object);
  return '';
}

function walkAst(node, visit, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range' || key === 'extra') continue;
    if (Array.isArray(value)) {
      for (const item of value) walkAst(item, visit, seen);
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      walkAst(value, visit, seen);
    }
  }
}


function repairRouteContracts(files, proposedPaths, repairs) {
  const normalized = files.map((file) => ({ ...file, path: normalizeProjectPath(file.path), content: String(file.content || '') }));
  const routeFiles = normalized.filter((file) => /\.(js|jsx)$/.test(file.path) && isAuthoritativeRouteFile(file.path));
  const routes = routeFiles.flatMap((file) => collectRoutePaths(file).map((routePath) => ({ path: routePath, file: file.path })));
  const registered = new Set(routes.map((route) => route.path));
  const concreteRoutes = routes.filter((route) => route.path && route.path !== '*');
  if (!concreteRoutes.length || registered.has('/')) return files;

  const navigation = normalized.flatMap((file) => /\.(js|jsx)$/.test(file.path) ? collectNavigationPaths(file).map((navPath) => ({ path: navPath, file: file.path })) : []);
  if (!navigation.some((item) => item.path === '/')) return files;

  const targetPath = normalized.some((file) => file.path === 'src/App.jsx') ? 'src/App.jsx' : concreteRoutes[0].file;
  if (!proposedPaths.has(targetPath)) return files;
  const target = normalized.find((file) => file.path === targetPath);
  if (!target) return files;
  const nextContent = addRootRoute(target.content);
  if (nextContent === target.content) return files;
  repairs.push({ code: 'MISSING_ROOT_ROUTE', file: targetPath, line: null, action: 'Added a / route because generated navigation links to /.' });
  return normalized.map((file) => file.path === targetPath ? { ...file, content: nextContent } : file);
}

function collectRoutePaths(file) {
  const paths = [];
  const content = file.content || '';
  for (const match of content.matchAll(/<Route\b[^>]*\bpath\s*=\s*["']([^"']+)["']/g)) paths.push(match[1]);
  if (isAuthoritativeRouteFile(file.path) && /\b(route|router|routes)\b/i.test(content)) {
    for (const match of content.matchAll(/\bpath\s*:\s*["']([^"']+)["']/g)) paths.push(match[1]);
  }
  return [...new Set(paths)];
}

function collectNavigationPaths(file) {
  const paths = [];
  const content = file.content || '';
  for (const match of content.matchAll(/<(?:Link|NavLink)\b[^>]*\bto\s*=\s*["']([^"']+)["']/g)) paths.push(match[1]);
  for (const block of content.matchAll(/(?:const|let|var)\s+[A-Za-z0-9_$]*(?:nav|menu|navigation)[A-Za-z0-9_$]*\s*=\s*\[([\s\S]*?)\]/gi)) {
    for (const match of block[1].matchAll(/\b(?:path|to|href)\s*:\s*["']([^"']+)["']/g)) paths.push(match[1]);
  }
  return [...new Set(paths)];
}

function addRootRoute(content) {
  const routeTag = content.match(/(\s*)<Route\b(?:(?:[^{}]|\{[^{}]*\})*?)\bpath\s*=\s*["'](?!\/['"]|\*['"])([^"']+)["'](?:(?:[^{}]|\{[^{}]*\})*?)\/>/);
  if (routeTag) {
    const clone = routeTag[0].replace(/\bpath\s*=\s*["'][^"']+["']/, 'path="/"');
    return content.slice(0, routeTag.index) + clone + '\n' + content.slice(routeTag.index);
  }
  const objectPath = content.match(/\bpath\s*:\s*["'](?!\/['"]|\*['"])([^"']+)["']/);
  if (objectPath) return content.slice(0, objectPath.index) + 'path: \'/\'' + content.slice(objectPath.index + objectPath[0].length);
  return content;
}

function isAuthoritativeRouteFile(filePath) {
  return filePath === 'src/App.jsx' || /^src\/(routes|app|navigation)\//.test(filePath);
}


function analyzeExports(file) {
  const table = { namedExports: new Set(), defaultExports: 0, declarations: new Set(), defaultDeclarationName: '' };
  let ast;
  try { ast = parser.parse(file.content, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true }); } catch { return table; }
  for (const statement of ast.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement;
    for (const name of declarationNames(declaration)) table.declarations.add(name);
    if (statement.type === 'ExportDefaultDeclaration') {
      table.defaultExports += 1;
      if (statement.declaration?.id?.name) table.defaultDeclarationName = statement.declaration.id.name;
    }
    if (statement.type === 'ExportNamedDeclaration') {
      for (const name of exportStatementNames(statement)) if (name !== 'default') table.namedExports.add(name);
      for (const specifier of statement.specifiers || []) if (specifier.exported?.name && specifier.exported.name !== 'default') table.namedExports.add(specifier.exported.name);
    }
  }
  return table;
}

function parseImportInfo(statement) {
  const info = { defaultLocal: '', namespaceLocal: '', named: [] };
  for (const specifier of statement.specifiers || []) {
    if (specifier.type === 'ImportDefaultSpecifier') info.defaultLocal = specifier.local.name;
    if (specifier.type === 'ImportNamespaceSpecifier') info.namespaceLocal = specifier.local.name;
    if (specifier.type === 'ImportSpecifier') info.named.push({ imported: specifier.imported.name || specifier.imported.value, local: specifier.local.name });
  }
  return info;
}

function cloneImportInfo(info) {
  return { defaultLocal: info.defaultLocal, namespaceLocal: info.namespaceLocal, named: info.named.map((item) => ({ ...item })) };
}

function addNamedImport(info, imported, local) {
  if (info.named.some((item) => item.imported === imported && item.local === local)) return;
  info.named.push({ imported, local });
}

function bestNamedExportForDefault(localName, targetTable) {
  if (targetTable.namedExports.has(localName)) return localName;
  const caseInsensitive = [...targetTable.namedExports].find((name) => name.toLowerCase() === String(localName).toLowerCase());
  if (caseInsensitive) return caseInsensitive;
  if (targetTable.declarations.has(localName)) return localName;
  const named = [...targetTable.namedExports];
  return named.length === 1 ? named[0] : '';
}

function canUseDefaultForNamedImport(specifier, targetTable) {
  if (!targetTable.defaultExports) return false;
  if (!targetTable.defaultDeclarationName) return true;
  return targetTable.defaultDeclarationName === specifier.imported || targetTable.defaultDeclarationName === specifier.local;
}

function formatImportStatement(info, source) {
  if (!info.defaultLocal && !info.namespaceLocal && !info.named.length) return "import '" + source + "';";
  const named = info.named.map((item) => item.imported === item.local ? item.imported : item.imported + ' as ' + item.local);
  const secondary = info.namespaceLocal ? '* as ' + info.namespaceLocal : named.length ? '{ ' + named.join(', ') + ' }' : '';
  if (info.defaultLocal && secondary) return "import " + info.defaultLocal + ', ' + secondary + " from '" + source + "';";
  if (info.defaultLocal) return "import " + info.defaultLocal + " from '" + source + "';";
  return "import " + secondary + " from '" + source + "';";
}

function queueReplacement(replacementsByFile, filePath, start, end, value) {
  if (!replacementsByFile.has(filePath)) replacementsByFile.set(filePath, []);
  replacementsByFile.get(filePath).push([start, end, value]);
}

function queueAppend(appendsByFile, filePath, value) {
  if (!appendsByFile.has(filePath)) appendsByFile.set(filePath, []);
  if (!appendsByFile.get(filePath).includes(value)) appendsByFile.get(filePath).push(value);
}

function declarationNames(node) {
  if (!node) return [];
  if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id?.name) return [node.id.name];
  if (node.type === 'VariableDeclaration') return node.declarations.flatMap((item) => bindingNames(item.id));
  return [];
}

function bindingNames(node) {
  if (!node) return [];
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'ObjectPattern') return node.properties.flatMap((item) => bindingNames(item.value || item.argument));
  if (node.type === 'ArrayPattern') return node.elements.flatMap(bindingNames);
  return [];
}

function resolve(from, source, fileMap) {
  const base = normalizeProjectPath(path.posix.join(path.posix.dirname(from), source));
  return [base, base + '.js', base + '.jsx', base + '.css', base + '/index.js', base + '/index.jsx'].find((candidate) => fileMap.has(candidate));
}
