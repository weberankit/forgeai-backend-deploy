import path from 'path';
import * as parser from '@babel/parser';
import traverseModule from '@babel/traverse';
import { normalizeProjectPath } from '../generation/pathSafety.js';

const traverse = traverseModule.default || traverseModule;
const jsExts = ['.js', '.jsx'];

export function buildDependencyGraph(files = []) {
  const fileMap = new Map(files.map((file) => [normalizeProjectPath(file.path), file]));
  const graph = {};
  for (const file of files) {
    const filePath = normalizeProjectPath(file.path);
    if (!jsExts.some((ext) => filePath.endsWith(ext))) continue;
    graph[filePath] = analyzeFile(filePath, file.content || '', fileMap);
  }
  for (const [filePath, node] of Object.entries(graph)) {
    for (const imported of node.imports) {
      if (graph[imported]) graph[imported].importedBy.push(filePath);
    }
  }
  return graph;
}

export function findCircularImports(graph = {}) {
  const cycles = [];
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  function visit(filePath) {
    if (visiting.has(filePath)) {
      const start = stack.indexOf(filePath);
      cycles.push(stack.slice(start).concat(filePath));
      return;
    }
    if (visited.has(filePath)) return;
    visiting.add(filePath);
    stack.push(filePath);
    for (const next of graph[filePath]?.imports || []) if (graph[next]) visit(next);
    stack.pop();
    visiting.delete(filePath);
    visited.add(filePath);
  }
  Object.keys(graph).forEach(visit);
  return cycles;
}

function analyzeFile(filePath, content, fileMap) {
  const node = {
    imports: [],
    importedBy: [],
    importedSymbols: {},
    exports: [],
    renders: [],
    localFunctions: [],
    eventHandlers: [],
    reduxImports: [],
    serviceImports: []
  };
  let ast;
  try {
    ast = parser.parse(content, { sourceType: 'module', plugins: ['jsx'] });
  } catch (error) {
    node.parseError = error.message;
    return node;
  }
  traverse(ast, {
    ImportDeclaration(pathRef) {
      const source = pathRef.node.source.value;
      const symbols = pathRef.node.specifiers.map((specifier) => specifier.local?.name).filter(Boolean);
      if (source.startsWith('.')) {
        const resolved = resolveRelativeImport(filePath, source, fileMap);
        if (resolved) {
          node.imports.push(resolved);
          node.importedSymbols[resolved] = symbols;
          if (resolved.includes('/services/')) node.serviceImports.push(resolved);
          if (resolved.includes('/store/') || /slice/i.test(resolved)) node.reduxImports.push(resolved);
        } else {
          node.missingImports = node.missingImports || [];
          node.missingImports.push(source);
        }
      } else if (source.includes('redux')) {
        node.reduxImports.push(source);
      }
    },
    ExportDefaultDeclaration(pathRef) {
      const declaration = pathRef.node.declaration;
      node.exports.push(declaration?.id?.name || 'default');
    },
    ExportNamedDeclaration(pathRef) {
      if (pathRef.node.declaration?.declarations) {
        for (const declaration of pathRef.node.declaration.declarations) if (declaration.id?.name) node.exports.push(declaration.id.name);
      }
      if (pathRef.node.declaration?.id?.name) node.exports.push(pathRef.node.declaration.id.name);
      for (const specifier of pathRef.node.specifiers || []) if (specifier.exported?.name) node.exports.push(specifier.exported.name);
    },
    FunctionDeclaration(pathRef) {
      if (pathRef.node.id?.name) node.localFunctions.push(pathRef.node.id.name);
    },
    VariableDeclarator(pathRef) {
      if (pathRef.node.id?.name && ['ArrowFunctionExpression', 'FunctionExpression'].includes(pathRef.node.init?.type)) node.localFunctions.push(pathRef.node.id.name);
    },
    JSXOpeningElement(pathRef) {
      const name = jsxName(pathRef.node.name);
      if (name && /^[A-Z]/.test(name) && !node.renders.includes(name)) node.renders.push(name);
      for (const attr of pathRef.node.attributes || []) {
        const attrName = attr.name?.name;
        if (attrName && /^on[A-Z]/.test(attrName)) {
          const expr = attr.value?.expression;
          const handler = expr?.name || expr?.callee?.name || attrName;
          if (!node.eventHandlers.includes(handler)) node.eventHandlers.push(handler);
        }
      }
    }
  });
  node.imports = [...new Set(node.imports)];
  node.exports = [...new Set(node.exports)];
  node.localFunctions = [...new Set(node.localFunctions)];
  return node;
}

function resolveRelativeImport(fromPath, specifier, fileMap) {
  const base = normalizeProjectPath(path.posix.join(path.posix.dirname(fromPath), specifier));
  const candidates = [base, base + '.js', base + '.jsx', base + '.css', path.posix.join(base, 'index.js'), path.posix.join(base, 'index.jsx')];
  return candidates.find((candidate) => fileMap.has(candidate)) || null;
}

function jsxName(name) {
  if (!name) return '';
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXMemberExpression') return jsxName(name.object) + '.' + jsxName(name.property);
  return '';
}
