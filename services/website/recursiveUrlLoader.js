import { assertPublicHttpUrl, normalizeInternalUrl } from './publicUrl.js';
import { httpError } from '../../utils/httpError.js';

const HTML_LIMIT_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 12_000;
const REDIRECT_LIMIT = 5;

export class RecursiveUrlLoader {
  constructor(rootUrl, options = {}) {
    this.rootUrl = rootUrl;
    this.maxDepth = clamp(options.maxDepth ?? 2, 0, 4);
    this.maxPages = clamp(options.maxPages ?? 12, 1, 20);
    this.fetchImpl = options.fetchImpl || fetch;
    this.validateUrl = options.validateUrl || assertPublicHttpUrl;
  }

  async load() {
    const rootResponse = await this.fetchHtml(this.rootUrl);
    const rootUrl = rootResponse.url;
    const allowedOrigin = new URL(rootUrl).origin;
    const queue = [{ url: rootUrl, depth: 0, prefetched: rootResponse }];
    const queued = new Set([rootUrl]);
    const pages = [];

    while (queue.length && pages.length < this.maxPages) {
      const current = queue.shift();
      let loaded;
      try {
        loaded = current.prefetched || await this.fetchHtml(current.url, allowedOrigin);
      } catch (error) {
        if (current.depth === 0) throw error;
        continue;
      }

      const normalizedUrl = normalizeInternalUrl(loaded.url, rootUrl, allowedOrigin);
      if (!normalizedUrl || pages.some((page) => page.url === normalizedUrl)) continue;
      const title = extractTitle(loaded.html) || new URL(normalizedUrl).pathname || new URL(normalizedUrl).hostname;
      const links = extractPageLinks(loaded.html, normalizedUrl, allowedOrigin);
      pages.push({
        url: normalizedUrl,
        path: new URL(normalizedUrl).pathname + new URL(normalizedUrl).search,
        title,
        depth: current.depth,
        status: loaded.status
      });

      if (current.depth >= this.maxDepth) continue;
      for (const link of links) {
        if (queued.size >= this.maxPages * 5) break;
        if (queued.has(link)) continue;
        queued.add(link);
        queue.push({ url: link, depth: current.depth + 1 });
      }
    }

    if (!pages.length) throw httpError(422, 'No crawlable HTML pages were found at this URL.');
    return { sourceUrl: rootUrl, origin: allowedOrigin, pages };
  }

  async fetchHtml(input, allowedOrigin) {
    let current = await this.validateUrl(input, allowedOrigin ? { allowedOrigin } : {});
    for (let redirect = 0; redirect <= REDIRECT_LIMIT; redirect += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let response;
      try {
        response = await this.fetchImpl(current.href, {
          redirect: 'manual',
          headers: {
            Accept: 'text/html,application/xhtml+xml',
            'User-Agent': 'ForgeAI-WebsiteImporter/1.0'
          },
          signal: controller.signal
        });
      } catch (error) {
        if (error.name === 'AbortError') throw httpError(504, 'Website discovery timed out.');
        throw httpError(502, 'The website could not be loaded.');
      } finally {
        clearTimeout(timeout);
      }

      if (isRedirect(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw httpError(502, 'Website returned an invalid redirect.');
        const redirected = new URL(location, current);
        current = await this.validateUrl(redirected, allowedOrigin ? { allowedOrigin } : {});
        continue;
      }

      if (!response.ok) throw httpError(422, 'Website returned HTTP ' + response.status + '.');
      const contentType = response.headers.get('content-type') || '';
      if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        throw httpError(422, 'The URL did not return an HTML page.');
      }
      const html = await readLimitedText(response, HTML_LIMIT_BYTES);
      return { url: current.href, html, status: response.status };
    }
    throw httpError(422, 'Website redirected too many times.');
  }
}

export function extractPageLinks(html, baseUrl, allowedOrigin) {
  const links = new Set();
  const pattern = /<a\b[^>]*?\bhref\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+))/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    const href = decodeHtml(match[1] || match[2] || match[3] || '').trim();
    const normalized = normalizeInternalUrl(href, baseUrl, allowedOrigin);
    if (normalized) links.add(normalized);
  }
  return [...links];
}

function extractTitle(html) {
  const match = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return decodeHtml(match?.[1] || '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

async function readLimitedText(response, maxBytes) {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) throw httpError(413, 'Website page is too large to inspect.');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw httpError(413, 'Website page is too large to inspect.');
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw httpError(413, 'Website page is too large to inspect.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

function clamp(value, minimum, maximum) {
  const number = Number(value);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(number) ? number : minimum));
}
