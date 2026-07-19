import { randomUUID } from 'node:crypto';
import { writeActivities, writeActivity } from '../services/observability/activityLogger.js';

export function activityRequestLogger(req, res, next) {
  const requestId = req.get('x-request-id') || randomUUID();
  const startedAt = Date.now();
  req.activityRequestId = requestId;
  res.setHeader('x-request-id', requestId);
  res.on('finish', () => {
    void writeActivity({
      type: 'api_request', source: 'backend', requestId,
      method: req.method, path: req.originalUrl.split('?')[0],
      status: res.statusCode, durationMs: Date.now() - startedAt,
      visitorId: req.get('x-visitor-id') || undefined,
      userAgent: req.get('user-agent') || undefined
    });
  });
  next();
}

export async function ingestBrowserActivity(req, res, next) {
  try {
    await writeActivities(req.body?.events, {
      type: 'browser_activity', source: 'frontend',
      visitorId: req.get('x-visitor-id') || undefined,
      ingestRequestId: req.activityRequestId
    });
    res.status(202).json({ accepted: Math.min(req.body?.events?.length || 0, 100) });
  } catch (error) {
    next(error);
  }
}
