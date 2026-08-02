import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';

// Always load the backend's own .env before importing telemetry packages.
// Some Langfuse internals read their configuration during module initialization.
loadEnv({ path: fileURLToPath(new URL('.env', import.meta.url)) });

const [{ NodeSDK }, { LangfuseSpanProcessor }] = await Promise.all([
  import('@opentelemetry/sdk-node'),
  import('@langfuse/otel')
]);

const enabled = process.env.LANGFUSE_ENABLED !== 'false'
  && Boolean(process.env.LANGFUSE_PUBLIC_KEY)
  && Boolean(process.env.LANGFUSE_SECRET_KEY);

let sdk = null;
let spanProcessor = null;

if (enabled) {
  try {
    spanProcessor = new LangfuseSpanProcessor({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
      environment: process.env.LANGFUSE_TRACING_ENVIRONMENT || process.env.NODE_ENV || 'development',
      release: process.env.LANGFUSE_RELEASE,
      mediaUploadEnabled: false,
      exportMode: process.env.LANGFUSE_EXPORT_MODE === 'batched' ? 'batched' : 'immediate'
    });
    sdk = new NodeSDK({ spanProcessors: [spanProcessor] });
    sdk.start();
    console.log('Langfuse full tracing enabled');
  } catch (error) {
    console.warn('Langfuse initialization failed; AI pipeline will continue without remote tracing', {
      message: error?.message || String(error)
    });
    sdk = null;
    spanProcessor = null;
  }
}

export function isLangfuseConfigured() {
  return enabled;
}

export async function flushLangfuse() {
  if (!spanProcessor) return;
  try {
    await spanProcessor.forceFlush();
  } catch (error) {
    console.warn('Langfuse flush failed; AI pipeline was not affected', { message: error?.message || String(error) });
  }
}

export async function shutdownLangfuse() {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch (error) {
    console.warn('Langfuse shutdown failed', { message: error?.message || String(error) });
  } finally {
    sdk = null;
    spanProcessor = null;
  }
}
