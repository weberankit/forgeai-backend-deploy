import { discoverWebsite, captureWebsiteSelection, summarizeCaptureForClient } from '../services/website/websiteCaptureService.js';
import { storeWebsiteCapture } from '../services/website/websiteCaptureStore.js';
import { httpError } from '../utils/httpError.js';

const activeVisitors = new Set();
let activeJobs = 0;
const MAX_CONCURRENT_JOBS = 2;

export async function discoverWebsitePages(req, res, next) {
  try {
    const url = String(req.body?.url || '').trim();
    if (!url) throw httpError(400, 'Website URL is required.');
    const result = await runWebsiteJob(req.visitorId, () => discoverWebsite(url));
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function captureSelectedWebsitePages(req, res, next) {
  try {
    const sourceUrl = String(req.body?.sourceUrl || '').trim();
    const urls = Array.isArray(req.body?.urls) ? req.body.urls : [];
    const mode = String(req.body?.mode || 'clone');
    if (!sourceUrl) throw httpError(400, 'Website source URL is required.');
    const context = await runWebsiteJob(req.visitorId, () => captureWebsiteSelection({ sourceUrl, urls, mode }));
    const captureId = storeWebsiteCapture(req.visitorId, context);
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ website: summarizeCaptureForClient(captureId, context) });
  } catch (error) {
    next(error);
  }
}

async function runWebsiteJob(visitorId, callback) {
  if (activeVisitors.has(visitorId)) throw httpError(409, 'A website import is already running for this browser.');
  if (activeJobs >= MAX_CONCURRENT_JOBS) throw httpError(429, 'Website capture is busy. Try again shortly.');
  activeVisitors.add(visitorId);
  activeJobs += 1;
  try {
    return await callback();
  } finally {
    activeVisitors.delete(visitorId);
    activeJobs -= 1;
  }
}
