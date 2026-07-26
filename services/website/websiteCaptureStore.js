import { randomUUID } from 'node:crypto';
import { httpError } from '../../utils/httpError.js';

const captures = new Map();
const CAPTURE_TTL_MS = 30 * 60 * 1000;
const MAX_CAPTURES = 12;

export function storeWebsiteCapture(visitorId, context) {
  purgeExpiredCaptures();
  while (captures.size >= MAX_CAPTURES) {
    captures.delete(captures.keys().next().value);
  }
  const captureId = randomUUID();
  captures.set(captureId, {
    visitorId,
    context,
    expiresAt: Date.now() + CAPTURE_TTL_MS
  });
  return captureId;
}

export function getWebsiteCapture(captureId, visitorId) {
  purgeExpiredCaptures();
  const record = captures.get(String(captureId || ''));
  if (!record || record.visitorId !== visitorId) {
    throw httpError(404, 'Website capture expired or was not found. Import the website again.');
  }
  return record.context;
}

export function deleteWebsiteCapture(captureId, visitorId) {
  const record = captures.get(String(captureId || ''));
  if (record?.visitorId === visitorId) captures.delete(captureId);
}

export function clearWebsiteCaptureStore() {
  captures.clear();
}

function purgeExpiredCaptures() {
  const now = Date.now();
  for (const [captureId, record] of captures) {
    if (record.expiresAt <= now) captures.delete(captureId);
  }
}
