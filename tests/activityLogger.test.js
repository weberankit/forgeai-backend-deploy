import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeActivity } from '../services/observability/activityLogger.js';

test('activity logger writes safe structured events to its own log', async () => {
  const logPath = path.join(os.tmpdir(), 'forgeai-activity-' + process.pid + '.jsonl');
  process.env.ACTIVITY_LOG_PATH = logPath;
  await rm(logPath, { force: true });
  await writeActivity({ type: 'webcontainer', action: 'spawn', command: 'npm run dev', body: 'private' });
  const record = JSON.parse((await readFile(logPath, 'utf8')).trim());
  assert.equal(record.type, 'webcontainer');
  assert.equal(record.action, 'spawn');
  assert.deepEqual(record.body, { redacted: true, length: 7 });
  await rm(logPath, { force: true });
  delete process.env.ACTIVITY_LOG_PATH;
});
