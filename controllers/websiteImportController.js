import { once } from 'node:events';
import {
  discoverWebsite,
  captureWebsiteSelection,
  resolveWebsiteImportMaxPages,
  summarizeCaptureForClient
} from '../services/website/websiteCaptureService.js';
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

export async function streamWebsitePages(
  req,
  res,
  next
) {
  const url = String(
    req.body?.url || ''
  ).trim();

  if (!url) {
    next(httpError(400, 'Website URL is required.'));
    return;
  }

  try {
    await runWebsiteJob(
      req.visitorId,
      async () => {
        res.status(200);
        res.setHeader(
          'Content-Type',
          'application/x-ndjson; charset=utf-8'
        );
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const abortController =
          new AbortController();
        const abortOnClose = () => {
          if (!res.writableEnded) {
            abortController.abort();
          }
        };
        res.once('close', abortOnClose);

        const heartbeat = setInterval(() => {
          if (!res.destroyed) {
            res.write(
              JSON.stringify({
                type: 'heartbeat'
              }) + '\n'
            );
          }
        }, 15_000);
        heartbeat.unref?.();

        try {
          await writeStreamEvent(res, {
            type: 'start',
            sourceUrl: url,
            maxPages:
              resolveWebsiteImportMaxPages()
          });

          const result = await discoverWebsite(
            url,
            {
              signal: abortController.signal,
              onPage: async (progress) => {
                await writeStreamEvent(res, {
                  type: 'page',
                  ...progress
                });
              }
            }
          );

          await writeStreamEvent(res, {
            type: 'complete',
            result
          });
        } catch (error) {
          if (
            !abortController.signal.aborted &&
            !res.destroyed
          ) {
            await writeStreamEvent(res, {
              type: 'error',
              status: error?.status || 500,
              message:
                error?.message ||
                'Website discovery failed.'
            });
          }
        } finally {
          clearInterval(heartbeat);
          res.off('close', abortOnClose);
          if (!res.writableEnded) {
            res.end();
          }
        }
      }
    );
  } catch (error) {
    if (res.headersSent) {
      if (!res.writableEnded) {
        res.end();
      }
      return;
    }

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

async function writeStreamEvent(res, event) {
  if (res.destroyed || res.writableEnded) {
    return;
  }

  const accepted = res.write(
    JSON.stringify(event) + '\n'
  );

  if (!accepted) {
    await Promise.race([
      once(res, 'drain'),
      once(res, 'close')
    ]);
  }
}
