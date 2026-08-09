import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeOpenAiUsage, withLangfuseObservation, withLangfuseProjectContext } from './langfuseTracing.js';

const serviceDirectory = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG_PATH = path.resolve(serviceDirectory, '..', '..', 'logs', 'ai-agent-calls.jsonl');
let writeQueue = Promise.resolve();
const callContext = new AsyncLocalStorage();

export function centralCallLogPath() {
  return path.resolve(process.env.AI_CALL_LOG_PATH || DEFAULT_LOG_PATH);
}

export async function withProjectCallLog({ projectId, operation, qualityMode, metadata = {} }, callback) {
  const projectMetadata = {
    projectId: String(projectId || ''),
    qualityMode,
    ...metadata
  };
  const inheritedContext = callContext.getStore() || {};
  const runProjectOperation = () => callContext.run({
    ...inheritedContext,
    projectId: String(projectId || '')
  }, () => withCallLog({
    type: 'agent_call',
    operation,
    provider: 'pipeline',
    metadata: projectMetadata
  }, callback));

  if (inheritedContext.projectId === String(projectId || '')) {
    return runProjectOperation();
  }
  return withLangfuseProjectContext({
    projectId,
    operation,
    qualityMode,
    metadata
  }, runProjectOperation);
}

export async function withCallLog({ type, operation, provider, model, parentCallId, metadata, input }, callback) {
  const callId = randomUUID();
  const inheritedContext = callContext.getStore() || {};
  parentCallId ||= inheritedContext.callId;
  const effectiveMetadata = inheritedContext.projectId && !metadata?.projectId
    ? { ...(metadata || {}), projectId: inheritedContext.projectId }
    : metadata;
  let recordedUsage = {};
  const startedAt = new Date();
  await writeCallEvent({ timestamp: startedAt.toISOString(), event: 'started', type, callId, parentCallId, operation, provider, model, metadata: effectiveMetadata });
  try {
    const result = await withLangfuseObservation({
      type, operation, provider, model, metadata: sanitize(effectiveMetadata), input
    }, (telemetry) => {
      const localTelemetry = {
        ...telemetry,
        recordUsage(usage) {
          recordedUsage = { ...recordedUsage, ...normalizeOpenAiUsage(usage) };
          telemetry.recordUsage(usage);
        }
      };
      return callContext.run(
        { ...inheritedContext, callId },
        () => callback({ callId, ...localTelemetry })
      );
    });
    await writeCallEvent({ timestamp: new Date().toISOString(), event: 'completed', type, callId, parentCallId, operation, provider, model, durationMs: Date.now() - startedAt.getTime(), usage: recordedUsage, metadata: effectiveMetadata });
    return result;
  } catch (error) {
    await writeCallEvent({ timestamp: new Date().toISOString(), event: 'failed', type, callId, parentCallId, operation, provider, model, durationMs: Date.now() - startedAt.getTime(), usage: recordedUsage, error: { name: error?.name || 'Error', message: error?.message || String(error) }, metadata: effectiveMetadata });
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
