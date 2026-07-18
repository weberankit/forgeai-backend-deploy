import { httpError } from '../../utils/httpError.js';

export const baseDependencies = new Set([
  '@vitejs/plugin-react', 'vite', 'react', 'react-dom', 'react-router-dom',
  '@reduxjs/toolkit', 'react-redux', 'tailwindcss', 'postcss', 'autoprefixer', 'lucide-react'
]);

const blockedPackages = new Set([
  'express', 'fastify', 'koa', 'hapi', '@hapi/hapi', 'next', 'nuxt',
  'mongoose', 'mongodb', 'mysql', 'mysql2', 'pg', 'pg-promise', 'sqlite3', 'better-sqlite3',
  'sequelize', 'typeorm', 'prisma', '@prisma/client', 'redis', 'ioredis',
  'jsonwebtoken', 'passport', 'bcrypt', 'bcryptjs', 'argon2', 'dotenv',
  'nodemon', 'pm2', 'node-gyp', 'shelljs'
]);
const blockedScriptNames = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack'];
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const unsafeVersionPattern = /^(?:file:|link:|git\+|git:|https?:|ssh:|github:|workspace:|npm:)/i;

export function isSafeFrontendDependency(name, version) {
  if (!packageNamePattern.test(String(name || '')) || blockedPackages.has(String(name).toLowerCase())) return false;
  const requestedVersion = String(version || '').trim();
  return Boolean(requestedVersion) && requestedVersion.length <= 80 && !unsafeVersionPattern.test(requestedVersion);
}

export function validatePackageJson(content) {
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw httpError(400, 'Generated package.json is not valid JSON.'); }
  validateScripts(parsed.scripts || {});
  const dependencies = { ...(parsed.dependencies || {}), ...(parsed.devDependencies || {}) };
  if (Object.keys(dependencies).length > 40) throw httpError(400, 'Generated frontend exceeds the dependency limit of 40 packages.');
  for (const [name, version] of Object.entries(dependencies)) {
    if (!isSafeFrontendDependency(name, version)) throw httpError(400, 'Unsafe or server-side dependency rejected: ' + name);
  }
  return parsed;
}

export function sanitizePackageJson(content) {
  let parsed;
  try { parsed = JSON.parse(content); } catch { return content; }
  const removed = [];
  for (const field of ['dependencies', 'devDependencies']) {
    if (!parsed[field] || typeof parsed[field] !== 'object') continue;
    for (const [name, version] of Object.entries(parsed[field])) {
      if (!isSafeFrontendDependency(name, version)) { removed.push(name); delete parsed[field][name]; }
    }
    if (Object.keys(parsed[field]).length === 0) delete parsed[field];
  }
  if (removed.length) parsed.aiFrontendEngineer = { ...(parsed.aiFrontendEngineer || {}), removedUnsupportedDependencies: [...new Set(removed)] };
  return JSON.stringify(parsed, null, 2) + '\n';
}

function validateScripts(scripts) {
  for (const scriptName of blockedScriptNames) if (scripts[scriptName]) throw httpError(400, 'Lifecycle scripts are not allowed in generated package.json.');
  for (const scriptValue of Object.values(scripts)) {
    if (/rm\s+-rf|curl\s|wget\s|node\s+-e|\.env|docker|bash|sh\s/.test(String(scriptValue))) throw httpError(400, 'Unsafe generated package script rejected.');
  }
}
