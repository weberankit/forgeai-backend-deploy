// import fs from 'node:fs/promises';
// import { chromium } from 'playwright';
// import { RecursiveUrlLoader } from './recursiveUrlLoader.js';
// import { assertPublicHttpUrl, normalizeInternalUrl } from './publicUrl.js';
// import { httpError } from '../../utils/httpError.js';

// const MAX_DISCOVERED_PAGES = 12;
// const MAX_SELECTED_PAGES = 4;
// const NAVIGATION_TIMEOUT_MS = 18_000;
// const MAX_SCREENSHOT_HEIGHT = 10_000;
// const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;
// const MAX_DOM_CHARS = 60_000;
// const MAX_TEXT_CHARS = 8_000;

// export async function discoverWebsite(inputUrl) {
//   const loader = new RecursiveUrlLoader(inputUrl, {
//     maxDepth: 2,
//     maxPages: MAX_DISCOVERED_PAGES
//   });
//   const discovered = await loader.load();
//   const thumbnails = await withBrowserPage(async (page) => {
//     const pages = [];
//     for (const candidate of discovered.pages) {
//       try {
//         await visitPage(page, candidate.url, discovered.origin);
//         const finalUrl = normalizeInternalUrl(page.url(), discovered.sourceUrl, discovered.origin);
//         if (!finalUrl) continue;
//         const thumbnail = await page.screenshot({
//           type: 'jpeg',
//           quality: 52,
//           animations: 'disabled',
//           caret: 'hide',
//           scale: 'css'
//         });
//         pages.push({
//           ...candidate,
//           url: finalUrl,
//           path: new URL(finalUrl).pathname + new URL(finalUrl).search,
//           title: (await page.title()).trim().slice(0, 180) || candidate.title,
//           thumbnail: 'data:image/jpeg;base64,' + thumbnail.toString('base64')
//         });
//       } catch (error) {
//         pages.push({ ...candidate, thumbnail: '', error: safePageError(error) });
//       }
//     }
//     return pages;
//   });

//   const pages = dedupeByUrl(thumbnails).slice(0, MAX_DISCOVERED_PAGES);
//   if (!pages.some((page) => page.thumbnail)) {
//     throw httpError(422, 'Pages were discovered, but the website could not be rendered.');
//   }
//   return { sourceUrl: discovered.sourceUrl, pages };
// }

// export async function captureWebsiteSelection({ sourceUrl, urls, mode = 'clone' }) {
//   const source = await assertPublicHttpUrl(sourceUrl);
//   const allowedOrigin = source.origin;
//   const selected = [...new Set((Array.isArray(urls) ? urls : []).map((url) => normalizeInternalUrl(url, source, allowedOrigin)).filter(Boolean))];
//   if (!selected.length) throw httpError(400, 'Select at least one website page.');
//   if (selected.length > MAX_SELECTED_PAGES) throw httpError(400, 'Select no more than four website pages.');

//   const pages = await withBrowserPage(async (page) => {
//     const captured = [];
//     for (const url of selected) {
//       await visitPage(page, url, allowedOrigin);
//       const finalUrl = normalizeInternalUrl(page.url(), source, allowedOrigin);
//       if (!finalUrl) throw httpError(422, 'A selected page redirected outside the website.');
//       const pageData = await collectPageData(page);
//       const screenshot = await captureBoundedFullPage(page, pageData.dimensions);
//       captured.push({
//         url: finalUrl,
//         path: new URL(finalUrl).pathname + new URL(finalUrl).search,
//         title: (await page.title()).trim().slice(0, 180),
//         screenshot: 'data:image/jpeg;base64,' + screenshot.buffer.toString('base64'),
//         screenshotMetadata: screenshot.metadata,
//         ...pageData
//       });
//     }
//     return captured;
//   });

//   return {
//     version: 1,
//     mode: normalizeMode(mode),
//     sourceUrl: source.href,
//     capturedAt: new Date().toISOString(),
//     pages
//   };
// }

// export function buildGeneratorWebsiteReference(context, prompt = '') {
//   if (!context?.pages?.length) return null;
//   const mode = resolveWebsiteMode(prompt, context.mode);
//   return {
//     version: 1,
//     mode,
//     sourceUrl: context.sourceUrl,
//     capturedAt: context.capturedAt,
//     assetPolicy: {
//       mode: 'mock_only',
//       preserve: ['placement', 'dimensions', 'aspect_ratio', 'visual_role'],
//       forbidden: ['source_asset_urls', 'source_cdn_urls', 'hotlinking']
//     },
//     instruction: mode === 'clone'
//       ? 'Closely reproduce the selected pages as an original React implementation, preserving layout hierarchy, page flow, visual tokens, responsive behavior, and content structure. Replace every source image or media asset with a stable mock or locally generated placeholder while preserving its placement and aspect ratio.'
//       : 'Use the selected pages as visual and UX inspiration while creating a distinct implementation for the user request. Replace every source image or media asset with a stable mock or locally generated placeholder.',
//     pages: context.pages.map((page) => ({
//       url: page.url,
//       path: page.path,
//       title: page.title,
//       screenshotMetadata: page.screenshotMetadata,
//       structure: page.structure,
//       cssVariables: page.cssVariables,
//       computedStyles: (page.computedStyles || []).slice(0, 40),
//       textExcerpt: String(page.textExcerpt || '').slice(0, 4_000),
//       domExcerpt: redactCapturedAssetUrls(page.dom).slice(0, 12_000)
//     }))
//   };
// }

// export function buildExpansionWebsiteContext(context, prompt = '') {
//   const reference = buildGeneratorWebsiteReference(context, prompt);
//   if (!reference) return null;
//   return {
//     ...reference,
//     pages: reference.pages.map((page, index) => ({
//       ...page,
//       screenshot: context.pages[index]?.screenshot || ''
//     }))
//   };
// }

// export function summarizeCaptureForClient(captureId, context) {
//   return {
//     captureId,
//     mode: context.mode,
//     sourceUrl: context.sourceUrl,
//     pageCount: context.pages.length,
//     pages: context.pages.map((page) => ({
//       url: page.url,
//       path: page.path,
//       title: page.title,
//       screenshotMetadata: page.screenshotMetadata
//     }))
//   };
// }

// export function resolveWebsiteMode(prompt, selectedMode = 'clone') {
//   const text = String(prompt || '').toLowerCase();
//   if (/\b(?:use|take|treat).{0,35}\b(?:reference|inspiration|inspire|guide)\b|\b(?:reference|inspiration)\s+(?:only|for)\b/.test(text)) {
//     return 'reference';
//   }
//   if (/\b(?:clone|copy|replicate|recreate|match)\b/.test(text)) return 'clone';
//   return normalizeMode(selectedMode);
// }

// export function redactCapturedAssetUrls(dom) {
//   let sanitized = String(dom || '')
//     .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
//     .replace(/<(?:link|meta|base)\b[^>]*\/?>/gi, '')
//     .replace(/\s(?:src|srcset|poster)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
//     .replace(/\sdata-(?!forgeai-mock-asset\b)[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
//     .replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
//     .replace(/(<(?:image|use)\b[^>]*?)\s(?:href|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1');

//   sanitized = sanitized.replace(/<(img|picture|source|video|audio|image)\b([^>]*)>/gi, (match, tag, rawAttributes) => {
//     if (/\bdata-forgeai-mock-asset\s*=/i.test(rawAttributes)) return match;
//     const selfClosing = /\/\s*$/.test(rawAttributes);
//     const attributes = rawAttributes.replace(/\/\s*$/, '');
//     const kind = /^(?:video|audio)$/i.test(tag) ? 'media' : 'image';
//     return `<${tag}${attributes} data-forgeai-mock-asset="${kind}"${selfClosing ? ' /' : ''}>`;
//   });

//   return sanitized;
// }


// async function withBrowserPage(callback) {
//   const executablePath = await resolveChromiumExecutable();
//   let browser;

//   try {
//     console.log("Starting Chromium", {
//       customExecutablePath: executablePath || null,
//       playwrightExecutablePath: chromium.executablePath()
//     });

//     browser = await chromium.launch({
//       headless: true,

//       // Use a manually installed Chrome/Chromium only when found.
//       // Otherwise Playwright automatically uses its downloaded browser.
//       ...(executablePath ? { executablePath } : {}),

//       args: [
//         "--no-sandbox",
//         "--disable-setuid-sandbox",
//         "--disable-dev-shm-usage"
//       ]
//     });
//   } catch (error) {
//     // Important: expose the real cause in Render logs.
//     console.error("Chromium launch failed:", {
//       message: error?.message,
//       stack: error?.stack,
//       playwrightExecutablePath: chromium.executablePath(),
//       customExecutablePath: executablePath || null,
//       browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH || null
//     });

//     throw httpError(
//       503,
//       "Website capture browser could not start. Check the server logs for the Chromium launch error."
//     );
//   }

//   let context;

//   try {
//     context = await browser.newContext({
//       viewport: { width: 1440, height: 900 },
//       deviceScaleFactor: 1,
//       colorScheme: "light",
//       reducedMotion: "reduce",
//       userAgent: "ForgeAI-WebsiteImporter/1.0"
//     });

//     const checkedHosts = new Map();

//     await context.route("**/*", async (route) => {
//       const requestUrl = route.request().url();

//       if (!/^https?:/i.test(requestUrl)) {
//         await route.continue();
//         return;
//       }

//       try {
//         const host = new URL(requestUrl).hostname;

//         if (!checkedHosts.has(host)) {
//           checkedHosts.set(host, assertPublicHttpUrl(requestUrl));
//         }

//         await checkedHosts.get(host);
//         await route.continue();
//       } catch {
//         await route.abort("blockedbyclient");
//       }
//     });

//     const page = await context.newPage();

//     page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
//     page.setDefaultTimeout(8_000);

//     page.on("dialog", (dialog) => {
//       void dialog.dismiss();
//     });

//     return await callback(page);
//   } finally {
//     await context?.close().catch(() => undefined);
//     await browser?.close().catch(() => undefined);
//   }
// }

// async function visitPage(page, url, allowedOrigin) {
//   await assertPublicHttpUrl(url, { allowedOrigin });
//   const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
//   if (!response || response.status() >= 400) {
//     throw httpError(422, 'Page returned HTTP ' + (response?.status() || 'error') + '.');
//   }
//   await assertPublicHttpUrl(page.url(), { allowedOrigin });
//   await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
//   await page.evaluate(() => {
//     window.scrollTo(0, 0);
//     document.querySelectorAll('[autoplay]').forEach((element) => element.removeAttribute('autoplay'));
//   });
//   await page.waitForTimeout(250);
// }

// async function collectPageData(page) {
//   const captured = await page.evaluate(() => {
//     const cleanText = (value, limit = 240) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
//     const isVisible = (element) => {
//       const rect = element.getBoundingClientRect();
//       const style = getComputedStyle(element);
//       return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
//     };
//     const selectorFor = (element) => {
//       const id = element.id ? '#' + CSS.escape(element.id) : '';
//       const classes = [...element.classList].slice(0, 3).map((name) => '.' + CSS.escape(name)).join('');
//       return (element.tagName.toLowerCase() + id + classes).slice(0, 180);
//     };
//     const candidates = [...document.querySelectorAll('body *')]
//       .filter((element) => isVisible(element))
//       .filter((element) => /^(HEADER|NAV|MAIN|SECTION|ARTICLE|ASIDE|FOOTER|H1|H2|H3|BUTTON|A|FORM|INPUT|IMG)$/.test(element.tagName) || element.classList.length)
//       .slice(0, 160);
//     const computedStyles = candidates.map((element) => {
//       const style = getComputedStyle(element);
//       const rect = element.getBoundingClientRect();
//       const hasBackgroundImage = style.backgroundImage && style.backgroundImage !== 'none';
//       const hasImageRole = /^(IMG|PICTURE|SOURCE|VIDEO|AUDIO|IMAGE)$/.test(element.tagName) || hasBackgroundImage;
//       return {
//         selector: selectorFor(element),
//         tag: element.tagName.toLowerCase(),
//         role: element.getAttribute('role') || '',
//         text: cleanText(element.textContent, 160),
//         assetRole: hasImageRole ? 'mock-asset' : '',
//         rect: {
//           x: Math.round(rect.x),
//           y: Math.round(rect.y + window.scrollY),
//           width: Math.round(rect.width),
//           height: Math.round(rect.height)
//         },
//         display: style.display,
//         position: style.position,
//         color: style.color,
//         backgroundColor: style.backgroundColor,
//         fontFamily: style.fontFamily,
//         fontSize: style.fontSize,
//         fontWeight: style.fontWeight,
//         lineHeight: style.lineHeight,
//         letterSpacing: style.letterSpacing,
//         padding: style.padding,
//         margin: style.margin,
//         gap: style.gap,
//         border: style.border,
//         borderRadius: style.borderRadius,
//         boxShadow: style.boxShadow
//       };
//     });
//     const rootStyle = getComputedStyle(document.documentElement);
//     const cssVariables = {};
//     for (const name of [...rootStyle]) {
//       if (!name.startsWith('--') || Object.keys(cssVariables).length >= 80) continue;
//       const value = rootStyle.getPropertyValue(name).trim();
//       if (value && value.length < 240 && !/(?:url\s*\(|https?:|data:|blob:)/i.test(value)) cssVariables[name] = value;
//     }
//     const clone = document.documentElement.cloneNode(true);
//     clone.querySelectorAll('script,noscript,iframe,object,embed,style,link,meta,base').forEach((element) => element.remove());
//     clone.querySelectorAll('*').forEach((element) => {
//       for (const attribute of [...element.attributes]) {
//         if (
//           /^on/i.test(attribute.name)
//           || attribute.name === 'nonce'
//           || attribute.name === 'src'
//           || attribute.name === 'srcset'
//           || attribute.name === 'poster'
//           || attribute.name === 'style'
//           || attribute.name.startsWith('data-')
//           || attribute.value.startsWith('data:')
//         ) {
//           element.removeAttribute(attribute.name);
//         }
//       }
//       if ('value' in element) element.removeAttribute('value');
//     });
//     clone.querySelectorAll('image,use').forEach((element) => {
//       element.removeAttribute('href');
//       element.removeAttribute('xlink:href');
//     });
//     clone.querySelectorAll('img,picture,source,video,audio,image').forEach((element) => {
//       element.setAttribute(
//         'data-forgeai-mock-asset',
//         /^(VIDEO|AUDIO)$/.test(element.tagName) ? 'media' : 'image'
//       );
//     });
//     return {
//       dom: '<!doctype html>\n' + clone.outerHTML,
//       textExcerpt: cleanText(document.body?.innerText, 20_000),
//       computedStyles,
//       cssVariables,
//       dimensions: {
//         width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
//         height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
//       },
//       structure: {
//         lang: document.documentElement.lang || '',
//         landmarks: [...document.querySelectorAll('header,nav,main,section,article,aside,footer')].filter(isVisible).slice(0, 80).map((element) => ({
//           tag: element.tagName.toLowerCase(),
//           selector: selectorFor(element),
//           text: cleanText(element.textContent, 220)
//         })),
//         headings: [...document.querySelectorAll('h1,h2,h3')].filter(isVisible).slice(0, 80).map((element) => ({
//           level: element.tagName.toLowerCase(),
//           text: cleanText(element.textContent, 220)
//         })),
//         navigation: [...document.querySelectorAll('nav a,header a')].filter(isVisible).slice(0, 80).map((element) => ({
//           text: cleanText(element.textContent, 100),
//           href: element.href
//         })),
//         actions: [...document.querySelectorAll('button,[role=\"button\"],input[type=\"submit\"]')].filter(isVisible).slice(0, 80).map((element) => cleanText(element.textContent || element.value, 120)).filter(Boolean),
//         forms: [...document.forms].slice(0, 20).map((form) => ({
//           action: form.action,
//           method: form.method,
//           fields: [...form.elements].slice(0, 40).map((element) => ({
//             name: element.name || '',
//             type: element.type || element.tagName.toLowerCase(),
//             placeholder: element.placeholder || ''
//           }))
//         }))
//       }
//     };
//   });
//   return {
//     ...captured,
//     dom: String(captured.dom || '').slice(0, MAX_DOM_CHARS),
//     textExcerpt: String(captured.textExcerpt || '').slice(0, MAX_TEXT_CHARS)
//   };
// }

// async function captureBoundedFullPage(page, dimensions) {
//   const width = Math.max(1, Math.min(1440, Number(dimensions?.width) || 1440));
//   const originalHeight = Math.max(1, Number(dimensions?.height) || 900);
//   const height = Math.min(MAX_SCREENSHOT_HEIGHT, originalHeight);
//   let buffer = await page.screenshot({
//     type: 'jpeg',
//     quality: 62,
//     clip: { x: 0, y: 0, width, height },
//     animations: 'disabled',
//     caret: 'hide',
//     scale: 'css',
//     timeout: NAVIGATION_TIMEOUT_MS
//   });
//   if (buffer.byteLength > MAX_SCREENSHOT_BYTES) {
//     buffer = await page.screenshot({
//       type: 'jpeg',
//       quality: 36,
//       clip: { x: 0, y: 0, width, height },
//       animations: 'disabled',
//       caret: 'hide',
//       scale: 'css',
//       timeout: NAVIGATION_TIMEOUT_MS
//     });
//   }
//   if (buffer.byteLength > MAX_SCREENSHOT_BYTES) {
//     throw httpError(413, 'A selected page screenshot is too large to process safely.');
//   }
//   return {
//     buffer,
//     metadata: {
//       width,
//       height,
//       originalHeight,
//       truncated: originalHeight > height,
//       format: 'jpeg'
//     }
//   };
// }

// async function resolveChromiumExecutable() {
//   const candidates = [
//     process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
//     '/usr/bin/google-chrome',
//     '/usr/bin/google-chrome-stable',
//     '/usr/bin/chromium',
//     '/usr/bin/chromium-browser'
//   ].filter(Boolean);
//   for (const candidate of candidates) {
//     try {
//       await fs.access(candidate);
//       return candidate;
//     } catch {
//       // Try the next known executable.
//     }
//   }
//   return undefined;
// }

// function normalizeMode(mode) {
//   return String(mode || '').toLowerCase() === 'reference' ? 'reference' : 'clone';
// }

// function dedupeByUrl(pages) {
//   return [...new Map(pages.map((page) => [page.url, page])).values()];
// }

// function safePageError(error) {
//   return /timed out/i.test(error?.message || '') ? 'Page timed out while rendering.' : 'Page could not be rendered.';
// }



import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { RecursiveUrlLoader } from './recursiveUrlLoader.js';
import {
  assertPublicHttpUrl,
  normalizeInternalUrl
} from './publicUrl.js';
import { httpError } from '../../utils/httpError.js';

const MAX_DISCOVERED_PAGES = 12;
const MAX_SELECTED_PAGES = 4;
const MAX_CRAWL_DEPTH = 2;

const NAVIGATION_TIMEOUT_MS = 18_000;
const PAGE_DELAY_MS = 700;

const MAX_SCREENSHOT_HEIGHT = 10_000;
const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;

const MAX_DOM_CHARS = 60_000;
const MAX_TEXT_CHARS = 8_000;

/**
 * Discover pages belonging to a website and generate thumbnails.
 *
 * First attempts discovery using RecursiveUrlLoader.
 * If normal HTTP crawling is blocked, it falls back to Playwright.
 */
export async function discoverWebsite(inputUrl) {
  let discovered;

  try {
    const loader = new RecursiveUrlLoader(inputUrl, {
      maxDepth: MAX_CRAWL_DEPTH,
      maxPages: MAX_DISCOVERED_PAGES
    });

    discovered = await loader.load();
  } catch (error) {
    if (!shouldFallbackToBrowserDiscovery(error)) {
      throw error;
    }

    console.warn(
      'Recursive URL loading was blocked. Falling back to browser-based discovery.',
      {
        message: error?.message,
        status:
          error?.status ||
          error?.statusCode ||
          error?.response?.status ||
          null
      }
    );

    discovered = await discoverWithBrowser(inputUrl);
  }

  if (
    !Array.isArray(discovered?.pages) ||
    discovered.pages.length === 0
  ) {
    console.warn(
      'Recursive URL loading returned no pages. Falling back to browser-based discovery.'
    );

    discovered = await discoverWithBrowser(inputUrl);
  }

  const thumbnails = await withBrowserPage(async (page) => {
    const pages = [];

    for (
      const candidate of discovered.pages.slice(
        0,
        MAX_DISCOVERED_PAGES
      )
    ) {
      try {
        await visitPage(
          page,
          candidate.url,
          discovered.origin
        );

        const finalUrl = normalizeInternalUrl(
          page.url(),
          discovered.sourceUrl,
          discovered.origin
        );

        if (!finalUrl) {
          continue;
        }

        const thumbnail = await page.screenshot({
          type: 'jpeg',
          quality: 52,
          animations: 'disabled',
          caret: 'hide',
          scale: 'css'
        });

        pages.push({
          ...candidate,
          url: finalUrl,
          path:
            new URL(finalUrl).pathname +
            new URL(finalUrl).search,
          title:
            (await page.title()).trim().slice(0, 180) ||
            candidate.title,
          thumbnail:
            'data:image/jpeg;base64,' +
            thumbnail.toString('base64')
        });
      } catch (error) {
        console.warn('Website thumbnail capture failed.', {
          url: candidate.url,
          message: error?.message
        });

        pages.push({
          ...candidate,
          thumbnail: '',
          error: safePageError(error)
        });
      }

      await page.waitForTimeout(PAGE_DELAY_MS);
    }

    return pages;
  });

  const pages = dedupeByUrl(thumbnails).slice(
    0,
    MAX_DISCOVERED_PAGES
  );

  if (!pages.some((page) => page.thumbnail)) {
    const blockedPage = pages.find((page) => page.error);

    throw httpError(
      422,
      blockedPage?.error ||
        'Pages were discovered, but the website blocked browser capture..'
    );
  }

  return {
    sourceUrl: discovered.sourceUrl,
    pages
  };
}

/**
 * Capture detailed design information for the pages selected by the user.
 */
export async function captureWebsiteSelection({
  sourceUrl,
  urls,
  mode = 'clone'
}) {
  const source = await assertPublicHttpUrl(sourceUrl);
  const allowedOrigin = source.origin;

  const selected = [
    ...new Set(
      (Array.isArray(urls) ? urls : [])
        .map((url) =>
          normalizeInternalUrl(
            url,
            source.href,
            allowedOrigin
          )
        )
        .filter(Boolean)
    )
  ];

  if (!selected.length) {
    throw httpError(
      400,
      'Select at least one website page.'
    );
  }

  if (selected.length > MAX_SELECTED_PAGES) {
    throw httpError(
      400,
      'Select no more than four website pages.'
    );
  }

  const pages = await withBrowserPage(async (page) => {
    const captured = [];

    for (const url of selected) {
      await visitPage(page, url, allowedOrigin);

      const finalUrl = normalizeInternalUrl(
        page.url(),
        source.href,
        allowedOrigin
      );

      if (!finalUrl) {
        throw httpError(
          422,
          'A selected page redirected outside the website.'
        );
      }

      const pageData = await collectPageData(page);

      const screenshot = await captureBoundedFullPage(
        page,
        pageData.dimensions
      );

      captured.push({
        url: finalUrl,
        path:
          new URL(finalUrl).pathname +
          new URL(finalUrl).search,
        title: (await page.title())
          .trim()
          .slice(0, 180),
        screenshot:
          'data:image/jpeg;base64,' +
          screenshot.buffer.toString('base64'),
        screenshotMetadata: screenshot.metadata,
        ...pageData
      });

      await page.waitForTimeout(PAGE_DELAY_MS);
    }

    return captured;
  });

  return {
    version: 1,
    mode: normalizeMode(mode),
    sourceUrl: source.href,
    capturedAt: new Date().toISOString(),
    pages
  };
}

/**
 * Convert captured website data into a smaller reference
 * for the code-generation agent.
 */
export function buildGeneratorWebsiteReference(
  context,
  prompt = ''
) {
  if (!context?.pages?.length) {
    return null;
  }

  const mode = resolveWebsiteMode(
    prompt,
    context.mode
  );

  return {
    version: 1,
    mode,
    sourceUrl: context.sourceUrl,
    capturedAt: context.capturedAt,

    assetPolicy: {
      mode: 'mock_only',
      preserve: [
        'placement',
        'dimensions',
        'aspect_ratio',
        'visual_role'
      ],
      forbidden: [
        'source_asset_urls',
        'source_cdn_urls',
        'hotlinking'
      ]
    },

    instruction:
      mode === 'clone'
        ? 'Closely reproduce the selected pages as an original React implementation, preserving layout hierarchy, page flow, visual tokens, responsive behavior, and content structure. Replace every source image or media asset with a stable mock or locally generated placeholder while preserving its placement and aspect ratio.'
        : 'Use the selected pages as visual and UX inspiration while creating a distinct implementation for the user request. Replace every source image or media asset with a stable mock or locally generated placeholder.',

    pages: context.pages.map((page) => ({
      url: page.url,
      path: page.path,
      title: page.title,

      screenshotMetadata:
        page.screenshotMetadata,

      structure: page.structure,

      cssVariables: page.cssVariables,

      computedStyles: (
        page.computedStyles || []
      ).slice(0, 40),

      textExcerpt: String(
        page.textExcerpt || ''
      ).slice(0, 4_000),

      domExcerpt: redactCapturedAssetUrls(
        page.dom
      ).slice(0, 12_000)
    }))
  };
}

/**
 * Build context for the requirement-expansion agent.
 *
 * Unlike the generator reference, this includes screenshots.
 */
export function buildExpansionWebsiteContext(
  context,
  prompt = ''
) {
  const reference =
    buildGeneratorWebsiteReference(
      context,
      prompt
    );

  if (!reference) {
    return null;
  }

  return {
    ...reference,

    pages: reference.pages.map(
      (page, index) => ({
        ...page,
        screenshot:
          context.pages[index]?.screenshot || ''
      })
    )
  };
}

/**
 * Create the safe client response after selected pages are captured.
 *
 * Large DOM data and screenshots are not included here.
 */
export function summarizeCaptureForClient(
  captureId,
  context
) {
  return {
    captureId,
    mode: context.mode,
    sourceUrl: context.sourceUrl,
    pageCount: context.pages.length,

    pages: context.pages.map((page) => ({
      url: page.url,
      path: page.path,
      title: page.title,
      screenshotMetadata:
        page.screenshotMetadata
    }))
  };
}

/**
 * Resolve whether the user wants a close clone or only inspiration.
 */
export function resolveWebsiteMode(
  prompt,
  selectedMode = 'clone'
) {
  const text = String(prompt || '').toLowerCase();

  if (
    /\b(?:use|take|treat).{0,35}\b(?:reference|inspiration|inspire|guide)\b|\b(?:reference|inspiration)\s+(?:only|for)\b/.test(
      text
    )
  ) {
    return 'reference';
  }

  if (
    /\b(?:clone|copy|replicate|recreate|match)\b/.test(
      text
    )
  ) {
    return 'clone';
  }

  return normalizeMode(selectedMode);
}

/**
 * Remove original asset URLs and unsafe markup from captured HTML.
 */
export function redactCapturedAssetUrls(dom) {
  let sanitized = String(dom || '')
    .replace(
      /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,
      ''
    )
    .replace(
      /<(?:link|meta|base)\b[^>]*\/?>/gi,
      ''
    )
    .replace(
      /\s(?:src|srcset|poster)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
      ''
    )
    .replace(
      /\sdata-(?!forgeai-mock-asset\b)[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
      ''
    )
    .replace(
      /\sstyle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
      ''
    )
    .replace(
      /(<(?:image|use)\b[^>]*?)\s(?:href|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
      '$1'
    );

  sanitized = sanitized.replace(
    /<(img|picture|source|video|audio|image)\b([^>]*)>/gi,
    (
      match,
      tag,
      rawAttributes
    ) => {
      if (
        /\bdata-forgeai-mock-asset\s*=/i.test(
          rawAttributes
        )
      ) {
        return match;
      }

      const selfClosing =
        /\/\s*$/.test(rawAttributes);

      const attributes =
        rawAttributes.replace(/\/\s*$/, '');

      const kind =
        /^(?:video|audio)$/i.test(tag)
          ? 'media'
          : 'image';

      return `<${tag}${attributes} data-forgeai-mock-asset="${kind}"${
        selfClosing ? ' /' : ''
      }>`;
    }
  );

  return sanitized;
}

/**
 * Discover internal links by using a real browser.
 *
 * This is used when the RecursiveUrlLoader gets blocked.
 */
async function discoverWithBrowser(inputUrl) {
  const source =
    await assertPublicHttpUrl(inputUrl);

  const sourceUrl = source.href;
  const origin = source.origin;

  const pages = await withBrowserPage(
    async (page) => {
      const discovered = new Map();

      const queued = new Set([
        sourceUrl
      ]);

      const queue = [
        {
          url: sourceUrl,
          depth: 0
        }
      ];

      while (
        queue.length &&
        discovered.size <
          MAX_DISCOVERED_PAGES
      ) {
        const current = queue.shift();

        if (
          !current ||
          current.depth >
            MAX_CRAWL_DEPTH
        ) {
          continue;
        }

        try {
          await visitPage(
            page,
            current.url,
            origin
          );

          const finalUrl =
            normalizeInternalUrl(
              page.url(),
              sourceUrl,
              origin
            );

          if (
            !finalUrl ||
            discovered.has(finalUrl)
          ) {
            continue;
          }

          const title =
            (await page.title())
              .trim()
              .slice(0, 180) ||
            new URL(finalUrl).pathname ||
            'Untitled page';

          discovered.set(finalUrl, {
            url: finalUrl,
            title,
            depth: current.depth
          });

          if (
            current.depth >=
            MAX_CRAWL_DEPTH
          ) {
            continue;
          }

          const links =
            await page.evaluate(() =>
              [
                ...document.querySelectorAll(
                  'a[href]'
                )
              ]
                .map(
                  (anchor) =>
                    anchor.href
                )
                .filter(Boolean)
            );

          for (const link of links) {
            const normalized =
              normalizeInternalUrl(
                link,
                sourceUrl,
                origin
              );

            if (
              !normalized ||
              discovered.has(normalized) ||
              queued.has(normalized)
            ) {
              continue;
            }

            if (
              queue.length >=
              MAX_DISCOVERED_PAGES * 3
            ) {
              break;
            }

            queued.add(normalized);

            queue.push({
              url: normalized,
              depth:
                current.depth + 1
            });
          }
        } catch (error) {
          console.warn(
            'Browser discovery skipped a page.',
            {
              url: current.url,
              depth: current.depth,
              message: error?.message
            }
          );

          if (
            current.depth === 0 &&
            discovered.size === 0
          ) {
            throw error;
          }
        }

        await page.waitForTimeout(
          PAGE_DELAY_MS
        );
      }

      return [
        ...discovered.values()
      ];
    }
  );

  if (!pages.length) {
    throw httpError(
      422,
      'This website blocks both direct crawling and browser capture. Ask the user to upload screenshots instead.'
    );
  }

  return {
    sourceUrl,
    origin,
    pages
  };
}

/**
 * Start Chromium and give one reusable Playwright page
 * to the supplied callback.
 */
async function withBrowserPage(callback) {
  const executablePath =
    await resolveChromiumExecutable();

  let browser;

  try {
    console.log('Starting Chromium', {
      customExecutablePath:
        executablePath || null,

      playwrightExecutablePath:
        chromium.executablePath()
    });

    browser = await chromium.launch({
      headless: true,

      ...(executablePath
        ? {
            executablePath
          }
        : {}),

      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });
  } catch (error) {
    console.error(
      'Chromium launch failed:',
      {
        message: error?.message,
        stack: error?.stack,

        playwrightExecutablePath:
          chromium.executablePath(),

        customExecutablePath:
          executablePath || null,

        browsersPath:
          process.env
            .PLAYWRIGHT_BROWSERS_PATH ||
          null
      }
    );

    throw httpError(
      503,
      'Website capture browser could not start. Check the server logs for the Chromium launch error.'
    );
  }

  let context;

  try {
    context =
      await browser.newContext({
        viewport: {
          width: 1440,
          height: 900
        },

        screen: {
          width: 1440,
          height: 900
        },

        deviceScaleFactor: 1,
        colorScheme: 'light',
        reducedMotion: 'reduce',
        locale: 'en-US',

        extraHTTPHeaders: {
          'Accept-Language':
            'en-US,en;q=0.9'
        }
      });

    const checkedHosts = new Map();

    await context.route(
      '**/*',
      async (route) => {
        const requestUrl =
          route.request().url();

        if (
          !/^https?:/i.test(
            requestUrl
          )
        ) {
          await route.continue();
          return;
        }

        try {
          const host =
            new URL(
              requestUrl
            ).hostname;

          if (
            !checkedHosts.has(host)
          ) {
            checkedHosts.set(
              host,
              assertPublicHttpUrl(
                requestUrl
              )
            );
          }

          await checkedHosts.get(host);

          await route.continue();
        } catch {
          await route.abort(
            'blockedbyclient'
          );
        }
      }
    );

    const page =
      await context.newPage();

    page.setDefaultNavigationTimeout(
      NAVIGATION_TIMEOUT_MS
    );

    page.setDefaultTimeout(8_000);

    page.on(
      'dialog',
      (dialog) => {
        void dialog.dismiss();
      }
    );

    return await callback(page);
  } finally {
    await context
      ?.close()
      .catch(() => undefined);

    await browser
      ?.close()
      .catch(() => undefined);
  }
}

/**
 * Navigate to one website page and validate its HTTP response.
 */
async function visitPage(
  page,
  url,
  allowedOrigin
) {
  await assertPublicHttpUrl(url, {
    allowedOrigin
  });

  const response = await page.goto(
    url,
    {
      waitUntil:
        'domcontentloaded',
      timeout:
        NAVIGATION_TIMEOUT_MS
    }
  );

  if (!response) {
    throw httpError(
      422,
      'The website did not return a navigation response.'
    );
  }

  const status =
    response.status();

  if (status === 403) {
    const details =
      await getBlockedPageDetails(
        page,
        response
      );

    console.warn(
      'Website returned HTTP 403.',
      {
        requestedUrl: url,
        finalUrl: page.url(),
        server: details.server,
        title: details.title,
        bodyExcerpt:
          details.bodyExcerpt
      }
    );

    throw httpError(
      422,
      details.isCloudflare
        ? 'This website is protected by Cloudflare and is blocking cloud browser capture. Ask the user to upload screenshots instead.'
        : 'This website is blocking automated or cloud-hosted browser capture. Ask the user to upload screenshots instead.'
    );
  }

  if (status === 401) {
    throw httpError(
      422,
      'This page requires authentication and cannot be captured from the server.'
    );
  }

  if (status === 429) {
    throw httpError(
      429,
      'The website temporarily rate-limited capture requests. Wait a moment and try again.'
    );
  }

  if (status >= 400) {
    throw httpError(
      422,
      `Page returned HTTP ${status}.`
    );
  }

  await assertPublicHttpUrl(
    page.url(),
    {
      allowedOrigin
    }
  );

  await page
    .waitForLoadState(
      'networkidle',
      {
        timeout: 3_000
      }
    )
    .catch(() => undefined);

  await page.evaluate(() => {
    window.scrollTo(0, 0);

    document
      .querySelectorAll(
        '[autoplay]'
      )
      .forEach((element) => {
        element.removeAttribute(
          'autoplay'
        );
      });
  });

  await page.waitForTimeout(500);
}

/**
 * Extract useful details from a blocked page.
 */
async function getBlockedPageDetails(
  page,
  response
) {
  const headers =
    response.headers();

  const server =
    headers.server || '';

  const title =
    await page
      .title()
      .catch(() => '');

  const bodyExcerpt =
    await page
      .locator('body')
      .innerText({
        timeout: 2_000
      })
      .then((text) =>
        String(text || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 500)
      )
      .catch(() => '');

  const combined =
    `${server} ${title} ${bodyExcerpt}`.toLowerCase();

  return {
    server,
    title,
    bodyExcerpt,

    isCloudflare:
      combined.includes(
        'cloudflare'
      ) ||
      combined.includes(
        'cf-ray'
      ) ||
      combined.includes(
        'attention required'
      ) ||
      combined.includes(
        'checking your browser'
      )
  };
}

/**
 * Extract DOM structure, text, computed styles,
 * CSS variables and page landmarks.
 */
async function collectPageData(page) {
  const captured =
    await page.evaluate(() => {
      const cleanText = (
        value,
        limit = 240
      ) =>
        String(value || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, limit);

      const isVisible = (
        element
      ) => {
        const rect =
          element.getBoundingClientRect();

        const style =
          getComputedStyle(element);

        return (
          rect.width > 1 &&
          rect.height > 1 &&
          style.display !==
            'none' &&
          style.visibility !==
            'hidden'
        );
      };

      const selectorFor = (
        element
      ) => {
        const id = element.id
          ? '#' +
            CSS.escape(
              element.id
            )
          : '';

        const classes = [
          ...element.classList
        ]
          .slice(0, 3)
          .map(
            (name) =>
              '.' +
              CSS.escape(name)
          )
          .join('');

        return (
          element.tagName.toLowerCase() +
          id +
          classes
        ).slice(0, 180);
      };

      const candidates = [
        ...document.querySelectorAll(
          'body *'
        )
      ]
        .filter((element) =>
          isVisible(element)
        )
        .filter(
          (element) =>
            /^(HEADER|NAV|MAIN|SECTION|ARTICLE|ASIDE|FOOTER|H1|H2|H3|BUTTON|A|FORM|INPUT|IMG)$/.test(
              element.tagName
            ) ||
            element.classList
              .length
        )
        .slice(0, 160);

      const computedStyles =
        candidates.map(
          (element) => {
            const style =
              getComputedStyle(
                element
              );

            const rect =
              element.getBoundingClientRect();

            const hasBackgroundImage =
              style.backgroundImage &&
              style.backgroundImage !==
                'none';

            const hasImageRole =
              /^(IMG|PICTURE|SOURCE|VIDEO|AUDIO|IMAGE)$/.test(
                element.tagName
              ) ||
              hasBackgroundImage;

            return {
              selector:
                selectorFor(
                  element
                ),

              tag:
                element.tagName.toLowerCase(),

              role:
                element.getAttribute(
                  'role'
                ) || '',

              text: cleanText(
                element.textContent,
                160
              ),

              assetRole:
                hasImageRole
                  ? 'mock-asset'
                  : '',

              rect: {
                x: Math.round(
                  rect.x
                ),

                y: Math.round(
                  rect.y +
                    window.scrollY
                ),

                width: Math.round(
                  rect.width
                ),

                height: Math.round(
                  rect.height
                )
              },

              display:
                style.display,

              position:
                style.position,

              color:
                style.color,

              backgroundColor:
                style.backgroundColor,

              fontFamily:
                style.fontFamily,

              fontSize:
                style.fontSize,

              fontWeight:
                style.fontWeight,

              lineHeight:
                style.lineHeight,

              letterSpacing:
                style.letterSpacing,

              padding:
                style.padding,

              margin:
                style.margin,

              gap:
                style.gap,

              border:
                style.border,

              borderRadius:
                style.borderRadius,

              boxShadow:
                style.boxShadow
            };
          }
        );

      const rootStyle =
        getComputedStyle(
          document.documentElement
        );

      const cssVariables = {};

      for (
        const name of [
          ...rootStyle
        ]
      ) {
        if (
          !name.startsWith('--') ||
          Object.keys(cssVariables)
            .length >= 80
        ) {
          continue;
        }

        const value =
          rootStyle
            .getPropertyValue(name)
            .trim();

        if (
          value &&
          value.length < 240 &&
          !/(?:url\s*\(|https?:|data:|blob:)/i.test(
            value
          )
        ) {
          cssVariables[name] =
            value;
        }
      }

      const clone =
        document.documentElement.cloneNode(
          true
        );

      clone
        .querySelectorAll(
          'script,noscript,iframe,object,embed,style,link,meta,base'
        )
        .forEach(
          (element) =>
            element.remove()
        );

      clone
        .querySelectorAll('*')
        .forEach((element) => {
          for (
            const attribute of [
              ...element.attributes
            ]
          ) {
            if (
              /^on/i.test(
                attribute.name
              ) ||
              attribute.name ===
                'nonce' ||
              attribute.name ===
                'src' ||
              attribute.name ===
                'srcset' ||
              attribute.name ===
                'poster' ||
              attribute.name ===
                'style' ||
              attribute.name.startsWith(
                'data-'
              ) ||
              attribute.value.startsWith(
                'data:'
              )
            ) {
              element.removeAttribute(
                attribute.name
              );
            }
          }

          if ('value' in element) {
            element.removeAttribute(
              'value'
            );
          }
        });

      clone
        .querySelectorAll(
          'image,use'
        )
        .forEach((element) => {
          element.removeAttribute(
            'href'
          );

          element.removeAttribute(
            'xlink:href'
          );
        });

      clone
        .querySelectorAll(
          'img,picture,source,video,audio,image'
        )
        .forEach((element) => {
          element.setAttribute(
            'data-forgeai-mock-asset',
            /^(VIDEO|AUDIO)$/.test(
              element.tagName
            )
              ? 'media'
              : 'image'
          );
        });

      return {
        dom:
          '<!doctype html>\n' +
          clone.outerHTML,

        textExcerpt:
          cleanText(
            document.body
              ?.innerText,
            20_000
          ),

        computedStyles,
        cssVariables,

        dimensions: {
          width: Math.max(
            document
              .documentElement
              .scrollWidth,

            document.body
              ?.scrollWidth || 0
          ),

          height: Math.max(
            document
              .documentElement
              .scrollHeight,

            document.body
              ?.scrollHeight || 0
          )
        },

        structure: {
          lang:
            document
              .documentElement
              .lang || '',

          landmarks: [
            ...document.querySelectorAll(
              'header,nav,main,section,article,aside,footer'
            )
          ]
            .filter(isVisible)
            .slice(0, 80)
            .map((element) => ({
              tag:
                element.tagName.toLowerCase(),

              selector:
                selectorFor(element),

              text: cleanText(
                element.textContent,
                220
              )
            })),

          headings: [
            ...document.querySelectorAll(
              'h1,h2,h3'
            )
          ]
            .filter(isVisible)
            .slice(0, 80)
            .map((element) => ({
              level:
                element.tagName.toLowerCase(),

              text: cleanText(
                element.textContent,
                220
              )
            })),

          navigation: [
            ...document.querySelectorAll(
              'nav a,header a'
            )
          ]
            .filter(isVisible)
            .slice(0, 80)
            .map((element) => ({
              text: cleanText(
                element.textContent,
                100
              ),

              href: element.href
            })),

          actions: [
            ...document.querySelectorAll(
              'button,[role="button"],input[type="submit"]'
            )
          ]
            .filter(isVisible)
            .slice(0, 80)
            .map((element) =>
              cleanText(
                element.textContent ||
                  element.value,
                120
              )
            )
            .filter(Boolean),

          forms: [
            ...document.forms
          ]
            .slice(0, 20)
            .map((form) => ({
              action:
                form.action,

              method:
                form.method,

              fields: [
                ...form.elements
              ]
                .slice(0, 40)
                .map((element) => ({
                  name:
                    element.name ||
                    '',

                  type:
                    element.type ||
                    element.tagName.toLowerCase(),

                  placeholder:
                    element.placeholder ||
                    ''
                }))
            }))
        }
      };
    });

  return {
    ...captured,

    dom: String(
      captured.dom || ''
    ).slice(0, MAX_DOM_CHARS),

    textExcerpt: String(
      captured.textExcerpt || ''
    ).slice(0, MAX_TEXT_CHARS)
  };
}

/**
 * Capture a bounded full-page screenshot.
 */
async function captureBoundedFullPage(
  page,
  dimensions
) {
  const width = Math.max(
    1,
    Math.min(
      1440,
      Number(dimensions?.width) ||
        1440
    )
  );

  const originalHeight =
    Math.max(
      1,
      Number(
        dimensions?.height
      ) || 900
    );

  const height = Math.min(
    MAX_SCREENSHOT_HEIGHT,
    originalHeight
  );

  let buffer =
    await page.screenshot({
      type: 'jpeg',
      quality: 62,

      clip: {
        x: 0,
        y: 0,
        width,
        height
      },

      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      timeout:
        NAVIGATION_TIMEOUT_MS
    });

  if (
    buffer.byteLength >
    MAX_SCREENSHOT_BYTES
  ) {
    buffer =
      await page.screenshot({
        type: 'jpeg',
        quality: 36,

        clip: {
          x: 0,
          y: 0,
          width,
          height
        },

        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
        timeout:
          NAVIGATION_TIMEOUT_MS
      });
  }

  if (
    buffer.byteLength >
    MAX_SCREENSHOT_BYTES
  ) {
    throw httpError(
      413,
      'A selected page screenshot is too large to process safely.'
    );
  }

  return {
    buffer,

    metadata: {
      width,
      height,
      originalHeight,

      truncated:
        originalHeight > height,

      format: 'jpeg'
    }
  };
}

/**
 * Use a configured system Chrome path when available.
 *
 * Otherwise Playwright automatically uses the Chromium
 * downloaded through:
 *
 * npx playwright install chromium
 */
async function resolveChromiumExecutable() {
  const candidates = [
    process.env
      .PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,

    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next known executable.
    }
  }

  return undefined;
}

function normalizeMode(mode) {
  return String(mode || '')
    .toLowerCase() === 'reference'
    ? 'reference'
    : 'clone';
}

function dedupeByUrl(pages) {
  return [
    ...new Map(
      pages.map((page) => [
        page.url,
        page
      ])
    ).values()
  ];
}

/**
 * Decide whether RecursiveUrlLoader should be replaced
 * with Playwright-based discovery.
 */
function shouldFallbackToBrowserDiscovery(
  error
) {
  const status = Number(
    error?.status ||
      error?.statusCode ||
      error?.response?.status
  );

  const message = String(
    error?.message || ''
  ).toLowerCase();

  return (
    status === 403 ||
    status === 429 ||
    message.includes('403') ||
    message.includes('forbidden') ||
    message.includes('blocked') ||
    message.includes(
      'too many requests'
    )
  );
}

/**
 * Convert internal errors into safe messages for the frontend.
 */
function safePageError(error) {
  const message = String(
    error?.message || ''
  );

  if (/timed out/i.test(message)) {
    return 'Page timed out while rendering.';
  }

  if (/cloudflare/i.test(message)) {
    return 'This website is protected by Cloudflare and blocks cloud browser capture.';
  }

  if (
    /403|forbidden|blocking automated|blocking cloud-hosted/i.test(
      message
    )
  ) {
    return 'This website blocks automated or cloud-hosted browser capture.';
  }

  if (
    /429|rate-limit|too many requests/i.test(
      message
    )
  ) {
    return 'The website temporarily rate-limited capture requests.';
  }

  if (
    /authentication|requires authentication|401/i.test(
      message
    )
  ) {
    return 'This page requires authentication and cannot be captured.';
  }

  return 'Page could not be rendered.';
}


