import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultPath = path.resolve(serviceDirectory, '..', '..', 'logs', 'activity.log.jsonl');
let writeQueue = Promise.resolve();

export function activityLogPath() {
  return path.resolve(process.env.ACTIVITY_LOG_PATH || defaultPath);
}

export function writeActivity(event) {
  const record = sanitize({ timestamp: new Date().toISOString(), eventId: randomUUID(), ...event });
  const filePath = activityLogPath();
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, JSON.stringify(record) + '\n', 'utf8');
  });
  return writeQueue.catch((error) => console.error('Activity log write failed', { message: error.message }));
}

export function writeActivities(events, context = {}) {
  return Promise.all((Array.isArray(events) ? events : []).slice(0, 100).map((event) =>
    writeActivity({ ...context, ...event, source: event?.source || context.source })
  ));
}

function sanitize(value, key = '') {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (/authorization|cookie|secret|password|token|body|content|code|prompt|input|output/i.test(key)) return { redacted: true, length: value.length };
    return value.length > 1000 ? value.slice(0, 1000) + '…' : value;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, key));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .map(([itemKey, item]) => [itemKey, sanitize(item, itemKey)]));
  return String(value);
}
