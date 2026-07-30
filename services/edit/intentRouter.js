import { withCallLog } from '../observability/centralCallLogger.js';
import { getTaskLlmConfig } from '../../config/taskLlmConfig.js';
import { fetchLlmResponse } from '../ai/llmTransport.js';
import { isOpenAiCredentialError } from '../ai/openAiErrors.js';
import { buildEditTargetingPrompt, buildIntentPrompt } from '../ai/prompts/intentPrompt.js';

const allowedIntents = new Set(['edit', 'explain', 'build', 'unknown']);
const intentCache = new Map();
const INTENT_CACHE_MS = 30_000;

export async function routeChatIntent(message) {
  const text = String(message || '').trim();
  if (!text) return 'unknown';
  const cached = intentCache.get(text);
  if (cached && Date.now() - cached.createdAt < INTENT_CACHE_MS) return cached.intent;
  const config = getTaskLlmConfig('intent');
  if (config.provider === 'openai' && config.apiKey) {
    for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
      try {
        const intent = await classifyWithSmallModel(text, config);
        rememberIntent(text, intent);
        return intent;
      } catch (error) {
        if (isOpenAiCredentialError(error)) throw error;
        console.warn('Intent classifier failed', { attempt, message: error.message });
      }
    }
  }
  const intent = fallbackIntent(text);
  rememberIntent(text, intent);
  return intent;
}

function rememberIntent(message, intent) {
  intentCache.set(message, { intent, createdAt: Date.now() });
  if (intentCache.size > 200) intentCache.delete(intentCache.keys().next().value);
}

async function classifyWithSmallModel(message, config) {
  const { model } = config;
  const data = await withCallLog({
    type: 'ai_call', operation: 'intent_classification', provider: 'openai', model,
    input: buildIntentPrompt(message),
    metadata: { qualityMode: config.qualityMode, messageLength: message.length, temperature: config.temperature, maxOutputTokens: config.maxOutputTokens }
  }, async ({ recordUsage }) => {
    const response = await fetchLlmResponse(config, {
      input: buildIntentPrompt(message)
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || 'Intent model request failed');
    }
    const responseData = await response.json();
    recordUsage(responseData.usage);
    return responseData;
  });
  const raw = data.output_text || data.output?.flatMap((item) => item.content || []).map((part) => part.text || '').join('\n') || '';
  const parsed = JSON.parse(String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim());
  if (!allowedIntents.has(parsed.intent)) throw new Error('Intent model returned an unsupported intent');
  return parsed.intent;
}

function fallbackIntent(message) {
  const text = message.toLowerCase();
  const words = new Set(text.match(/[a-z]+/g) || []);
  const contains = (values) => values.some((value) => words.has(value));
  if (contains(['edit', 'modify', 'adjust', 'change', 'make', 'add', 'remove', 'update', 'fix', 'style', 'rename', 'replace', 'resize', 'move', 'toggle'])) return 'edit';
  if (contains(['build', 'create', 'generate', 'regenerate'])) return 'build';
  if (contains(['explain', 'why', 'how', 'what', 'where', 'which']) || text.endsWith('?')) return 'explain';
  return 'unknown';
}

export async function selectSemanticEditTargets(project, message, fallbackTargeting) {
  const fallback = { ...fallbackTargeting, strategy: 'deterministic_fallback' };
  const config = getTaskLlmConfig('intent');
  if (config.provider !== 'openai' || !config.apiKey) return fallback;
  const catalog = buildEditFileCatalog(project);
  if (!catalog.length) return fallback;
  for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
    try {
      const selected = await selectTargetsWithSmallModel(message, catalog, config, attempt);
      return finalizeSemanticTargets(project, selected, fallback);
    } catch (error) {
      if (isOpenAiCredentialError(error)) throw error;
      console.warn('Semantic edit target selection failed', { attempt, message: error.message });
    }
  }
  return fallback;
}

function buildEditFileCatalog(project) {
  const graph = project.dependencyGraph || {};
  const planned = new Map((project.blueprint?.fileList || []).map((file) => [file.path, file]));
  const routes = project.blueprint?.routes || [];
  return (project.generatedFiles || [])
    .filter((file) => ['.js', '.jsx', '.css'].some((extension) => file.path.endsWith(extension)))
    .slice(0, 80)
    .map((file) => {
      const node = graph[file.path] || {};
      const basename = file.path.split('/').pop().replace('.jsx', '').replace('.js', '');
      const route = routes.find((item) => String(item.component || '').toLowerCase() === basename.toLowerCase());
      return {
        path: file.path,
        responsibility: String(planned.get(file.path)?.responsibility || '').slice(0, 180),
        route: route?.path || undefined,
        exports: (node.exports || []).slice(0, 12),
        renders: (node.renders || []).slice(0, 12),
        imports: (node.imports || []).slice(0, 12)
      };
    });
}

async function selectTargetsWithSmallModel(message, catalog, config, attempt) {
  const prompt = buildEditTargetingPrompt(message, catalog);
  const data = await withCallLog({
    type: 'ai_call', operation: 'edit_targeting', provider: 'openai', model: config.model,
    input: prompt,
    metadata: { attempt, qualityMode: config.qualityMode, messageLength: String(message || '').length, catalogSize: catalog.length, maxOutputTokens: config.maxOutputTokens }
  }, async ({ recordUsage }) => {
    const response = await fetchLlmResponse(config, { input: prompt });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || 'Edit target model request failed');
    }
    const responseData = await response.json();
    recordUsage(responseData.usage);
    return responseData;
  });
  const raw = data.output_text || data.output?.flatMap((item) => item.content || []).map((part) => part.text || '').join('\n') || '';
  const parsed = JSON.parse(String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim());
  const available = new Set(catalog.map((file) => file.path));
  const targets = [...new Set((parsed.targets || []).filter((filePath) => available.has(filePath)))].slice(0, 6);
  if (!targets.length) throw new Error('Edit target model did not select an available project file');
  return { targets, understanding: String(parsed.understanding || '').slice(0, 500), confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium' };
}

function finalizeSemanticTargets(project, selected, fallback) {
  const graph = project.dependencyGraph || {};
  const available = new Set((project.generatedFiles || []).map((file) => file.path));
  const targets = new Set(selected.targets);
  for (const seed of selected.targets) {
    for (const related of [...(graph[seed]?.imports || []), ...(graph[seed]?.importedBy || [])]) {
      if (available.has(related) && ['.js', '.jsx', '.css'].some((extension) => related.endsWith(extension))) targets.add(related);
      if (targets.size >= 8) break;
    }
    if (targets.size >= 8) break;
  }
  return { ...fallback, targets: [...targets].slice(0, 8), confidence: selected.confidence, understanding: selected.understanding, strategy: 'ai_semantic', needsClarification: false };
}
