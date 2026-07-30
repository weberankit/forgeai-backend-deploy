import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLangfuseObservation } from './langfuseTracing.js';

const serviceDirectory = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG_PATH = path.resolve(serviceDirectory, '..', '..', 'logs', 'ai-agent-calls.jsonl');
let writeQueue = Promise.resolve();
const callContext = new AsyncLocalStorage();

export function centralCallLogPath() {
  return path.resolve(process.env.AI_CALL_LOG_PATH || DEFAULT_LOG_PATH);
}

export async function withCallLog({ type, operation, provider, model, parentCallId, metadata, input }, callback) {
  const callId = randomUUID();
  parentCallId ||= callContext.getStore()?.callId;
  const startedAt = new Date();
  await writeCallEvent({ timestamp: startedAt.toISOString(), event: 'started', type, callId, parentCallId, operation, provider, model, metadata });
  try {
    const result = await withLangfuseObservation({
      type, operation, provider, model, metadata: sanitize(metadata), input
    }, (telemetry) => callContext.run(
      { callId },
      () => callback({ callId, ...telemetry })
    ));
    await writeCallEvent({ timestamp: new Date().toISOString(), event: 'completed', type, callId, parentCallId, operation, provider, model, durationMs: Date.now() - startedAt.getTime(), metadata });
    return result;
  } catch (error) {
    await writeCallEvent({ timestamp: new Date().toISOString(), event: 'failed', type, callId, parentCallId, operation, provider, model, durationMs: Date.now() - startedAt.getTime(), error: { name: error?.name || 'Error', message: error?.message || String(error) }, metadata });
    throw error;
  }
}

export function writeCallEvent(event) {
  const safeEvent = sanitize(event);
  const filePath = centralCallLogPath();
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, JSON.stringify(safeEvent) + '\n', 'utf8');
  });
  return writeQueue.catch((error) => console.error('Central call log write failed', { message: error.message }));
}

function sanitize(value, key = '') {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (/key|token|authorization|secret|image|buffer|content|prompt|input|output/i.test(key)) return { redacted: true, length: value.length };
    return value.length > 500 ? value.slice(0, 500) + '…' : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, key));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([itemKey, item]) => [itemKey, sanitize(item, itemKey)]));
  return String(value);
}
