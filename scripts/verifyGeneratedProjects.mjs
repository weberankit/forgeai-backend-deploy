import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const baseUrl = process.env.PIPELINE_API_URL || 'http://localhost:4000';
const projects = [
  ['506daa48-c7e2-4cbe-a5fd-8a498ffdc85f', 'ca4dd4a5-5b72-4cfc-8eaa-c8eacce8d151'],
  ['441b6d10-f364-457e-be67-d2660737ccd2', 'ca4dd4a5-5b72-4cfc-8eaa-c8eacce8d151'],
  ['95d79a54-f8f3-4b3c-8c3f-a69c1402e219', '777eae79-59c6-4355-b014-2bef83c2ffd0'],
  ['b2d3b450-9727-433e-bcc2-bd71a2be733e', '777eae79-59c6-4355-b014-2bef83c2ffd0'],
  ['a1f99236-348b-40a2-8288-6ca2ae8b0879', '777eae79-59c6-4355-b014-2bef83c2ffd0'],
  ['204b1d35-e8dd-47c5-bc3d-cc1485b8f0ec', '777eae79-59c6-4355-b014-2bef83c2ffd0']
];

async function verify([projectId, visitorId]) {
  const startedAt = Date.now();
  const response = await fetch(baseUrl + '/api/projects/' + projectId + '/files', { headers: { 'x-visitor-id': visitorId } });
  if (!response.ok) throw new Error('Files API returned ' + response.status + ' for ' + projectId);
  const payload = await response.json();
  const directory = path.join(os.tmpdir(), 'forgeai-matrix-' + projectId);
  await fs.mkdir(directory, { recursive: true });
  for (const file of payload.files || []) {
    const target = path.join(directory, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, String(file.content || ''));
  }
  try {
    await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: directory, timeout: 5 * 60_000, maxBuffer: 2_000_000 });
    const build = await run('npm', ['run', 'build'], { cwd: directory, timeout: 5 * 60_000, maxBuffer: 2_000_000 });
    return { projectId, passed: true, fileCount: payload.files?.length || 0, durationMs: Date.now() - startedAt, buildTail: build.stdout.trim().split('\n').slice(-2).join(' | ') };
  } catch (error) {
    return { projectId, passed: false, fileCount: payload.files?.length || 0, durationMs: Date.now() - startedAt, error: String(error.stderr || error.stdout || error.message).trim().slice(-3000) };
  }
}

const results = [];
for (let offset = 0; offset < projects.length; offset += 2) {
  results.push(...await Promise.all(projects.slice(offset, offset + 2).map(verify)));
}
console.log(JSON.stringify({ results }, null, 2));
