import path from 'path';
import { languageForPath, normalizeProjectPath } from './pathSafety.js';
import { toPlainGeneratedFiles } from './generatedFileObjects.js';

const importRegex = /import\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g;

export function repairMissingRelativeImports(files = []) {
  let normalized = toPlainGeneratedFiles(files);
  const originalByPath = new Map(normalized.map((file) => [file.path, file]));
  normalized = normalized.map((file) => repairRootSourceImports(file, originalByPath));
  const byPath = new Map(normalized.map((file) => [file.path, file]));
  const additions = [];

  for (const file of normalized) {
    if (!/\.(jsx|js)$/.test(file.path)) continue;
    const dir = path.posix.dirname(file.path);
    importRegex.lastIndex = 0;
    let match;
    while ((match = importRegex.exec(file.content))) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      let base;
      try {
        base = normalizeProjectPath(path.posix.join(dir, specifier));
      } catch {
        continue;
      }
      if (resolveCandidate(base, byPath)) continue;
      const repaired = buildRepairFile(base, byPath);
      if (!repaired || byPath.has(repaired.path)) continue;
      byPath.set(repaired.path, repaired);
      additions.push(repaired);
    }
  }

  if (!additions.length) return normalized;
  return [...normalized, ...additions].sort((a, b) => a.path.localeCompare(b.path));
}

function repairRootSourceImports(file, byPath) {
  if (!/\.(jsx|js)$/.test(file.path) || !String(file.content || '').includes('src/')) return file;
  const content = String(file.content || '').replace(importRegex, (statement, specifier) => {
    if (!specifier.startsWith('src/')) return statement;
    const resolved = resolveCandidate(normalizeProjectPath(specifier), byPath);
    if (!resolved) return statement;
    const replacement = relativeImport(file.path, resolved);
    const quoteIndex = statement.lastIndexOf(specifier);
    return statement.slice(0, quoteIndex) + replacement + statement.slice(quoteIndex + specifier.length);
  });
  return content === file.content ? file : { ...file, content, repaired: true, updatedAt: new Date() };
}

function resolveCandidate(base, byPath) {
  const candidates = [base, base + '.js', base + '.jsx', base + '.css', path.posix.join(base, 'index.js'), path.posix.join(base, 'index.jsx')];
  return candidates.find((candidate) => byPath.has(candidate));
}

function buildRepairFile(base, byPath) {
  const filePath = preferredRepairPath(base);
  const target = findBestTarget(base, byPath);
  const content = target ? bridgeContent(filePath, target.path) : fallbackModuleContent(filePath, componentNameFromPath(base));
  return {
    path: filePath,
    language: languageForPath(filePath),
    content,
    generatedAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    repaired: true
  };
}

function preferredRepairPath(base) {
  if (/\.(js|jsx|css)$/.test(base)) return base;
  return base + '.jsx';
}

function findBestTarget(base, byPath) {
  const name = path.posix.basename(base).replace(/\.(jsx|js)$/i, '').toLowerCase();
  const files = Array.from(byPath.values()).filter((file) => /\.(jsx|js)$/.test(file.path));
  const exact = files.find((file) => path.posix.basename(file.path).replace(/\.(jsx|js)$/i, '').toLowerCase() === name);
  if (exact) return exact;

  if (/routes?|router/i.test(name)) {
    return files.find((file) => file.path === 'src/App.jsx') || files.find((file) => file.path.startsWith('src/pages/')) || null;
  }

  if (/page|home|dashboard|landing/i.test(name)) {
    return files.find((file) => file.path.startsWith('src/pages/')) || files.find((file) => file.path === 'src/App.jsx') || null;
  }

  return null;
}

function bridgeContent(filePath, targetPath) {
  const relative = relativeImport(filePath, targetPath);
  return "export { default } from '" + relative + "';\nexport * from '" + relative + "';\n";
}

function fallbackModuleContent(filePath, componentName) {
  if (filePath.endsWith('.css')) return '/* Generated fallback stylesheet to satisfy a missing CSS import. */\n';
  if (filePath.includes('/hooks/')) {
    const hookName = /^Use[A-Z]/.test(componentName) ? componentName[0].toLowerCase() + componentName.slice(1) : (/^use[A-Z]/.test(componentName) ? componentName : 'use' + componentName);
    return 'export function ' + hookName + "() {\n  const toggle = () => {};\n  return { value: false, isDarkMode: false, darkMode: false, toggle, toggleDarkMode: toggle };\n}\nexport default " + hookName + ';\n';
  }
  if (filePath.endsWith('.js')) return 'export const ' + componentName + ' = {};\nexport default ' + componentName + ';\n';
  return fallbackComponentContent(componentName);
}

function fallbackComponentContent(componentName) {
  return 'export default function ' + componentName + "() {\n  return <main className=\"min-h-screen bg-slate-950 p-8 text-slate-50\">\n    <section className=\"mx-auto max-w-4xl rounded-2xl bg-white/10 p-8\">\n      <h1 className=\"text-3xl font-semibold\">Generated preview</h1>\n      <p className=\"mt-3 text-slate-300\">This safe fallback keeps the preview running while the app is repaired.</p>\n    </section>\n  </main>;\n}\n";
}

function componentNameFromPath(filePath) {
  const raw = path.posix.basename(filePath).replace(/\.(jsx|js)$/i, '') || 'GeneratedView';
  const name = raw.replace(/[^a-zA-Z0-9]/g, ' ').split(' ').filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  return /^[A-Z]/.test(name) ? name : 'Generated' + name;
}

function relativeImport(fromPath, toPath) {
  let rel = path.posix.relative(path.posix.dirname(fromPath), toPath).replace(/\.(jsx|js)$/i, '');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}
