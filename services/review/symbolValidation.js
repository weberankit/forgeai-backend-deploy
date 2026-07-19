import path from 'path';
import * as parser from '@babel/parser';
import traverseModule from '@babel/traverse';
import { normalizeProjectPath } from '../generation/pathSafety.js';

const traverse = traverseModule.default || traverseModule;
const extensions = ['', '.js', '.jsx', '.css', '/index.js', '/index.jsx'];

export function validateProjectSymbols(files = []) {
  const findings = [];
  const normalized = files.map((file) => ({ ...file, path: normalizeProjectPath(file.path), content: String(file.content || '') }));
  const fileMap = new Map(normalized.map((file) => [file.path, file]));
  const tables = {};
  for (const file of normalized) {
    if (!/\.(js|jsx)$/.test(file.path)) continue;
    tables[file.path] = analyze(file, findings);
  }
  for (const [filePath, table] of Object.entries(tables)) validateImports(filePath, table, tables, fileMap, findings);
  return { passed: findings.length === 0, errors: findings, tables };
}

function analyze(file, findings) {
  let ast;
  try {
    ast = parser.parse(file.content, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true });
  } catch (error) {
    findings.push(issue(classifyParserError(error.message), file.path, error.loc?.line, symbolFromMessage(error.message), error.message, 'Regenerate or repair the invalid declaration/export.'));
    return emptyTable();
  }
  for (const error of ast.errors || []) findings.push(issue(classifyParserError(error.message), file.path, error.loc?.line, symbolFromMessage(error.message), error.message, 'Remove the duplicate or conflicting statement.'));
  const table = emptyTable();
  const declarations = new Map();
  const exports = new Map();
  const importKeys = new Map();
  const localBindings = new Map();
  traverse(ast, {
    Program(programPath) {
      for (const statement of programPath.node.body) collectTopLevel(statement, declarations, file, findings);
    },
    ImportDeclaration(ref) {
      const node = ref.node;
      const key = node.source.value + ':' + node.specifiers.map((item) => item.type + ':' + (item.imported?.name || 'default') + ':' + item.local.name).sort().join(',');
      if (importKeys.has(key)) findings.push(issue('DUPLICATE_IMPORT', file.path, node.loc?.start.line, null, 'Duplicate import from ' + node.source.value, 'Remove the later identical import.'));
      importKeys.set(key, true);
      const entry = { source: node.source.value, line: node.loc?.start.line, specifiers: [] };
      for (const specifier of node.specifiers) {
        const kind = specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.type === 'ImportNamespaceSpecifier' ? 'namespace' : 'named';
        const imported = kind === 'named' ? specifier.imported.name : kind;
        entry.specifiers.push({ kind, imported, local: specifier.local.name });
        if (localBindings.has(specifier.local.name)) findings.push(issue('CONFLICTING_LOCAL_IMPORT', file.path, node.loc?.start.line, specifier.local.name, 'Imported identifier conflicts with another top-level binding: ' + specifier.local.name, 'Rename or remove the conflicting binding.'));
        localBindings.set(specifier.local.name, 'import');
        table.importedLocals.add(specifier.local.name);
      }
      table.imports.push(entry);
    },
    ExportDefaultDeclaration(ref) {
      table.defaultExports += 1;
      if (table.defaultExports > 1) findings.push(issue('MULTIPLE_DEFAULT_EXPORTS', file.path, ref.node.loc?.start.line, 'default', 'Module has more than one default export.', 'Keep one authoritative default export.'));
    },
    ExportNamedDeclaration(ref) {
      const names = exportNames(ref.node);
      if (names.includes('default')) table.defaultExports += 1;
      for (const name of names.filter((name) => name !== 'default')) {
        if (exports.has(name)) findings.push(issue('DUPLICATE_NAMED_EXPORT', file.path, ref.node.loc?.start.line, name, 'Named export is repeated: ' + name, 'Keep one authoritative named export.'));
        exports.set(name, true);
        table.namedExports.add(name);
      }
    },
    JSXOpeningElement(ref) {
      const name = jsxName(ref.node.name);
      if (name && /^[A-Z]/.test(name)) {
        const rootName = name.split('.')[0];
        table.rendered.add(rootName);
        if (ref.scope.hasBinding(rootName)) table.scopedRenderedBindings.add(rootName);
      }
    }
  });
  for (const [name] of declarations) {
    if (localBindings.has(name)) findings.push(issue('CONFLICTING_LOCAL_IMPORT', file.path, declarations.get(name).line, name, 'Local declaration conflicts with imported identifier: ' + name, 'Remove or rename one binding.'));
    table.declarations.add(name);
  }
  for (const component of table.rendered) {
    if (!table.scopedRenderedBindings.has(component) && !table.declarations.has(component) && !table.importedLocals.has(component) && !['React', 'Fragment'].includes(component)) findings.push(issue('UNDEFINED_RENDERED_COMPONENT', file.path, null, component, 'Rendered component is not imported or declared: ' + component, 'Import the component or define it locally.'));
  }
  return table;
}

function collectTopLevel(statement, declarations, file, findings) {
  const declaration = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement;
  const names = declarationNames(declaration);
  for (const name of names) {
    if (declarations.has(name)) findings.push(issue('DUPLICATE_DECLARATION', file.path, declaration.loc?.start.line, name, 'Top-level declaration is repeated: ' + name, 'Keep one identical declaration or regenerate the file.'));
    else declarations.set(name, { line: declaration.loc?.start.line });
  }
}

function validateImports(filePath, table, tables, fileMap, findings) {
  for (const imported of table.imports) {
    if (!imported.source.startsWith('.')) continue;
    const resolved = resolveImport(filePath, imported.source, fileMap);
    if (!resolved) {
      findings.push(issue('MISSING_RELATIVE_MODULE', filePath, imported.line, null, 'Missing relative import: ' + imported.source, 'Resolve the path from the manifest or create the planned module.'));
      continue;
    }
    const target = tables[resolved];
    if (!target) continue;
    for (const specifier of imported.specifiers) {
      if (specifier.kind === 'named' && !target.namedExports.has(specifier.imported)) findings.push(issue('MISSING_NAMED_EXPORT', filePath, imported.line, specifier.imported, resolved + ' does not export ' + specifier.imported, 'Correct the import name or the authoritative module export.'));
      if (specifier.kind === 'default' && target.defaultExports === 0) findings.push(issue('MISSING_DEFAULT_EXPORT', filePath, imported.line, specifier.local, resolved + ' has no default export.', 'Use a named import or add the contracted default export.'));
    }
  }
}

function resolveImport(from, source, fileMap) {
  const base = normalizeProjectPath(path.posix.join(path.posix.dirname(from), source));
  return extensions.map((suffix) => base + suffix).find((candidate) => fileMap.has(candidate)) || null;
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

function exportNames(node) {
  return [...declarationNames(node.declaration), ...(node.specifiers || []).map((item) => item.exported?.name).filter(Boolean)];
}

function jsxName(node) {
  if (!node) return '';
  if (node.type === 'JSXIdentifier') return node.name;
  if (node.type === 'JSXMemberExpression') return jsxName(node.object) + '.' + jsxName(node.property);
  return '';
}

function emptyTable() {
  return { imports: [], namedExports: new Set(), defaultExports: 0, declarations: new Set(), importedLocals: new Set(), rendered: new Set(), scopedRenderedBindings: new Set() };
}

function classifyParserError(message) {
  if (/already been declared|redeclaration/i.test(message)) return 'DUPLICATE_DECLARATION';
  if (/has already been exported/i.test(message)) return 'DUPLICATE_NAMED_EXPORT';
  if (/Only one default export|duplicate.*default/i.test(message)) return 'MULTIPLE_DEFAULT_EXPORTS';
  return 'PARSE_ERROR';
}

function symbolFromMessage(message) {
  return message.match(/["'`]([^"'`]+)["'`]/)?.[1] || null;
}

function issue(code, file, line, symbol, message, suggestedAction) {
  return { code, file, line: line || null, symbol: symbol || null, message, suggestedAction };
}
