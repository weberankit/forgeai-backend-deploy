import * as parser from '@babel/parser';
import traverseModule from '@babel/traverse';
import { normalizeProjectPath } from '../generation/pathSafety.js';

const traverse = traverseModule.default || traverseModule;
const testablePattern = /^src\/(App\.jsx|pages\/.*\.jsx|components\/.*\.jsx|layouts\/.*\.jsx|routes\/.*\.jsx)$/;
const builtinJsxNames = new Set(['Fragment', 'React']);

export function runSmokeRenderTests(files = []) {
  const errors = [];
  const warnings = [];
  const normalized = [];

  for (const file of files) {
    try {
      normalized.push({ ...file, path: normalizeProjectPath(file.path), content: String(file.content || '') });
    } catch (error) {
      errors.push(issue('smoke_invalid_path', error.message, file.path || null));
    }
  }

  const fileMap = new Map(normalized.map((file) => [file.path, file]));
  const testedFiles = [];

  for (const file of normalized) {
    if (!testablePattern.test(file.path)) continue;
    testedFiles.push(file.path);
    const analysis = analyzeRenderableFile(file, fileMap);
    for (const error of analysis.errors) errors.push(error);
    for (const warning of analysis.warnings) warnings.push(warning);
  }

  return { passed: errors.length === 0, errors, warnings, testedFiles };
}

function analyzeRenderableFile(file, fileMap) {
  const errors = [];
  const warnings = [];
  let ast;
  try {
    ast = parser.parse(file.content, { sourceType: 'module', plugins: ['jsx'] });
  } catch (error) {
    errors.push(issue('smoke_parse_error', error.message, file.path));
    return { errors, warnings };
  }

  const importedNames = new Set();
  const localNames = new Set();
  const renderedNames = new Set();
  let hasDefaultExport = false;
  let hasAnyExport = false;
  let hasJsx = false;

  traverse(ast, {
    ImportDeclaration(pathRef) {
      const source = pathRef.node.source.value;
      for (const specifier of pathRef.node.specifiers || []) {
        if (specifier.local?.name) importedNames.add(specifier.local.name);
      }
      if (source.startsWith('.') && !resolveRelativeImport(file.path, source, fileMap)) {
        errors.push(issue('smoke_missing_import', 'Smoke test could not resolve import: ' + source, file.path));
      }
    },
    ExportDefaultDeclaration() {
      hasDefaultExport = true;
      hasAnyExport = true;
    },
    ExportNamedDeclaration() {
      hasAnyExport = true;
    },
    FunctionDeclaration(pathRef) {
      if (pathRef.node.id?.name) localNames.add(pathRef.node.id.name);
    },
    VariableDeclarator(pathRef) {
      if (pathRef.node.id?.name) localNames.add(pathRef.node.id.name);
    },
    JSXOpeningElement(pathRef) {
      hasJsx = true;
      const name = rootJsxName(pathRef.node.name);
      if (name && /^[A-Z]/.test(name)) renderedNames.add(name);
    },
    JSXFragment() {
      hasJsx = true;
    }
  });

  if (!hasDefaultExport && /^src\/(pages|layouts|routes)\//.test(file.path)) {
    errors.push(issue('smoke_missing_default_export', 'Renderable module is missing a default export.', file.path));
  }
  if (!hasAnyExport && /^src\/components\//.test(file.path)) {
    errors.push(issue('smoke_missing_component_export', 'Component module does not export a component.', file.path));
  }
  if (!hasJsx && /\.(jsx)$/.test(file.path)) {
    warnings.push(issue('smoke_no_jsx_rendered', 'Renderable JSX file does not appear to return JSX.', file.path));
  }
  for (const renderedName of renderedNames) {
    if (builtinJsxNames.has(renderedName)) continue;
    if (!importedNames.has(renderedName) && !localNames.has(renderedName)) {
      errors.push(issue('smoke_undefined_render_symbol', 'Rendered component is not imported or locally defined: ' + renderedName, file.path));
    }
  }

  return { errors, warnings };
}

function resolveRelativeImport(fromPath, specifier, fileMap) {
  const base = normalizeProjectPath(fromPath.split('/').slice(0, -1).concat(specifier).join('/'));
  const candidates = [base, base + '.js', base + '.jsx', base + '.css', base + '/index.js', base + '/index.jsx'];
  return candidates.find((candidate) => fileMap.has(candidate)) || null;
}

function rootJsxName(name) {
  if (!name) return '';
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXMemberExpression') return rootJsxName(name.object);
  return '';
}

function issue(code, message, file) {
  return { code, message, file };
}
