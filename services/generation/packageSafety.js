import { httpError } from '../../utils/httpError.js';

const allowedDependencies = new Set([
  '@vitejs/plugin-react',
  'vite',
  'react',
  'react-dom',
  'react-router-dom',
  '@reduxjs/toolkit',
  'react-redux',
  'tailwindcss',
  'postcss',
  'autoprefixer',
  'lucide-react'
]);
const blockedScriptNames = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack'];

export function validatePackageJson(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw httpError(400, 'Generated package.json is not valid JSON.');
  }
  const scripts = parsed.scripts || {};
  for (const scriptName of blockedScriptNames) {
    if (scripts[scriptName]) throw httpError(400, 'Lifecycle scripts are not allowed in generated package.json.');
  }
  for (const scriptValue of Object.values(scripts)) {
    if (/rm\s+-rf|curl\s|wget\s|node\s+-e|\.env|docker|bash|sh\s/.test(String(scriptValue))) {
      throw httpError(400, 'Unsafe generated package script rejected.');
    }
  }
  const dependencies = { ...(parsed.dependencies || {}), ...(parsed.devDependencies || {}) };
  for (const dependencyName of Object.keys(dependencies)) {
    if (!allowedDependencies.has(dependencyName)) {
      throw httpError(400, 'Dependency is not allowed for generated frontend preview: ' + dependencyName);
    }
  }
  return parsed;
}
