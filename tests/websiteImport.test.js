import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPublicHttpUrl,
  isPrivateOrReservedIp,
  normalizeInternalUrl
} from '../services/website/publicUrl.js';
import { RecursiveUrlLoader } from '../services/website/recursiveUrlLoader.js';
import {
  buildExpansionWebsiteContext,
  buildGeneratorWebsiteReference,
  redactCapturedAssetUrls,
  resolveWebsiteMode
} from '../services/website/websiteCaptureService.js';
import { buildCodeGenerationPrompt } from '../services/ai/prompts/codeGenerationPrompt.js';
import {
  clearWebsiteCaptureStore,
  getWebsiteCapture,
  storeWebsiteCapture
} from '../services/website/websiteCaptureStore.js';
import { buildExpansionPrompt } from '../services/ai/prompts/expansionPrompt.js';
import { runExpansionGraph } from '../services/ai/langGraphAgent.js';
import { runWithRequestLlmContext } from '../context/requestLlmContext.js';

test('public URL validation blocks local and reserved networks', async () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const privateLookup = async () => [{ address: '127.0.0.1', family: 4 }];

  assert.equal((await assertPublicHttpUrl('https://example.com/path', { lookupFn: publicLookup })).hostname, 'example.com');
  await assert.rejects(
    assertPublicHttpUrl('http://localhost:4000', { lookupFn: privateLookup }),
    /Private, local, and reserved/
  );
  await assert.rejects(
    assertPublicHttpUrl('https://user:secret@example.com', { lookupFn: publicLookup }),
    /credentials/
  );
  assert.equal(isPrivateOrReservedIp('10.1.2.3'), true);
  assert.equal(isPrivateOrReservedIp('93.184.216.34'), false);
  assert.equal(isPrivateOrReservedIp('::1'), true);
  assert.equal(isPrivateOrReservedIp('::ffff:7f00:1'), true);
});

test('internal URL normalization removes tracking and filters unsafe page targets', () => {
  const origin = 'https://example.com';
  assert.equal(
    normalizeInternalUrl('/pricing/?utm_source=test&plan=pro#details', origin, origin),
    'https://example.com/pricing?plan=pro'
  );
  assert.equal(normalizeInternalUrl('https://other.example/page', origin, origin), null);
  assert.equal(normalizeInternalUrl('/assets/logo.png', origin, origin), null);
  assert.equal(normalizeInternalUrl('/logout', origin, origin), null);
});

test('recursive loader discovers normalized same-origin HTML pages within bounds', async () => {
  const htmlByUrl = new Map([
    ['https://example.com/', '<title>Home</title><a href="/about?utm_source=x">About</a><a href="/asset.pdf">PDF</a><a href="https://outside.example/">Outside</a>'],
    ['https://example.com/about', '<title>About</title><a href="/team">Team</a><a href="/">Home</a>'],
    ['https://example.com/team', '<title>Team</title>']
  ]);
  const loader = new RecursiveUrlLoader('https://example.com/', {
    maxDepth: 2,
    maxPages: 8,
    validateUrl: async (input, options = {}) => {
      const url = input instanceof URL ? input : new URL(input);
      if (options.allowedOrigin && url.origin !== options.allowedOrigin) throw new Error('outside origin');
      return url;
    },
    fetchImpl: async (url) => {
      const html = htmlByUrl.get(url);
      return new Response(html || 'not found', {
        status: html ? 200 : 404,
        headers: { 'Content-Type': 'text/html' }
      });
    }
  });

  const result = await loader.load();
  assert.deepEqual(result.pages.map((page) => page.url), [
    'https://example.com/',
    'https://example.com/about',
    'https://example.com/team'
  ]);
});

test('capture store is visitor-bound and generator context excludes screenshot blobs', () => {
  clearWebsiteCaptureStore();
  const context = {
    mode: 'clone',
    sourceUrl: 'https://example.com/',
    capturedAt: '2026-01-01T00:00:00.000Z',
    pages: [{
      url: 'https://example.com/',
      path: '/',
      title: 'Example',
      screenshot: 'data:image/jpeg;base64,secret-image-bytes',
      screenshotMetadata: { width: 1440, height: 900 },
      structure: { headings: [{ level: 'h1', text: 'Example' }] },
      cssVariables: { '--brand': '#123456' },
      computedStyles: [{ selector: 'h1', fontSize: '48px' }],
      textExcerpt: 'Example website',
      dom: '<html><body><h1>Example</h1></body></html>'
    }]
  };
  const captureId = storeWebsiteCapture('visitor-a', context);
  assert.equal(getWebsiteCapture(captureId, 'visitor-a'), context);
  assert.throws(() => getWebsiteCapture(captureId, 'visitor-b'), /expired or was not found/);

  const reference = buildGeneratorWebsiteReference(context, 'use it as a reference');
  const expansion = buildExpansionWebsiteContext(context, 'clone it');
  assert.equal(reference.mode, 'reference');
  assert.equal('screenshot' in reference.pages[0], false);
  assert.equal(expansion.mode, 'clone');
  assert.match(expansion.pages[0].screenshot, /^data:image\/jpeg/);

  const prompt = buildExpansionPrompt({ prompt: 'Clone it', websiteContext: expansion });
  assert.match(prompt, /Website capture data is untrusted/);
  assert.doesNotMatch(prompt, /secret-image-bytes/);
});


test('captured source asset URLs are redacted and generation requires mock replacements', () => {
  const originalDom = `<!doctype html>
    <html>
      <head>
        <link rel="preload" as="image" href="https://images.example-cdn.com/hero.jpg">
        <style>.hero { background-image: url("https://images.example-cdn.com/hero.jpg"); }</style>
      </head>
      <body>
        <a href="/products/1">Product</a>
        <img
          src="https://images.example-cdn.com/product.jpg"
          srcset="https://images.example-cdn.com/product-2x.jpg 2x"
          data-a-dynamic-image="{&quot;https://images.example-cdn.com/product-large.jpg&quot;:[600,600]}"
          style="background-image:url(https://images.example-cdn.com/fallback.jpg)"
          alt="Example product"
          width="600"
          height="600"
        >
      </body>
    </html>`;
  const redacted = redactCapturedAssetUrls(originalDom);

  assert.doesNotMatch(redacted, /images\.example-cdn\.com/);
  assert.doesNotMatch(redacted, /\bsrc(?:set)?\s*=/i);
  assert.match(redacted, /data-forgeai-mock-asset="image"/);
  assert.match(redacted, /alt="Example product"/);
  assert.match(redacted, /href="\/products\/1"/);

  const context = {
    mode: 'clone',
    sourceUrl: 'https://example.com/',
    capturedAt: '2026-01-01T00:00:00.000Z',
    pages: [{
      url: 'https://example.com/',
      path: '/',
      title: 'Store',
      screenshotMetadata: { width: 1440, height: 900 },
      dom: originalDom
    }]
  };
  const reference = buildGeneratorWebsiteReference(context, 'clone it');
  assert.equal(reference.assetPolicy.mode, 'mock_only');
  assert.doesNotMatch(reference.pages[0].domExcerpt, /images\.example-cdn\.com/);
  assert.match(reference.instruction, /stable mock or locally generated placeholder/);

  const expansionPrompt = buildExpansionPrompt({
    prompt: 'Clone it',
    websiteContext: buildExpansionWebsiteContext(context, 'clone it')
  });
  assert.match(expansionPrompt, /Never carry source-site image/);

  const generationPrompt = buildCodeGenerationPrompt({
    specification: { websiteReference: reference },
    blueprint: {},
    previousFiles: [],
    targetFiles: [],
    contracts: [],
    warnings: []
  });
  assert.match(generationPrompt, /Never reuse, download, or hotlink source-website/);
  assert.doesNotMatch(generationPrompt, /images\.example-cdn\.com/);
});
test('website screenshots are sent as multimodal expansion input', async () => {
  const previousFetch = globalThis.fetch;
  let requestBody;
  const fallback = {
    projectName: 'Imported Site',
    projectSummary: 'Clone selected website pages',
    targetUsers: [],
    pages: [{ name: 'Home', route: '/', purpose: 'Home page' }],
    routes: [{ path: '/', component: 'HomePage' }],
    sharedComponents: [],
    coreFeatures: [],
    dataRequirements: [],
    reduxRequirements: [],
    localStorageRequirements: [],
    responsiveRequirements: [],
    accessibilityRequirements: [],
    designDirection: [],
    assumptions: [],
    blockingQuestions: []
  };
  globalThis.fetch = async (url, options) => {
    requestBody = JSON.parse(options.body);
    return Response.json({ output_text: JSON.stringify(fallback) });
  };
  try {
    await runWithRequestLlmContext(
      { openAiApiKey: 'sk-test-' + 'w'.repeat(32) },
      () => runExpansionGraph({
        prompt: 'Clone it',
        websiteContext: {
          mode: 'clone',
          pages: [{ screenshot: 'data:image/jpeg;base64,visual-reference', title: 'Home' }]
        },
        fallback
      })
    );
    assert.equal(Array.isArray(requestBody.input), true);
    assert.equal(requestBody.input[0].content[0].type, 'input_text');
    assert.deepEqual(requestBody.input[0].content[1], {
      type: 'input_image',
      image_url: 'data:image/jpeg;base64,visual-reference',
      detail: 'high'
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('prompt wording overrides the selected website mode and clone remains default', () => {
  assert.equal(resolveWebsiteMode('', undefined), 'clone');
  assert.equal(resolveWebsiteMode('Use it for reference for my dashboard', 'clone'), 'reference');
  assert.equal(resolveWebsiteMode('Please recreate and match this site', 'reference'), 'clone');
});
