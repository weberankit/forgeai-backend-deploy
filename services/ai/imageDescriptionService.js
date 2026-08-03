import { withCallLog } from '../observability/centralCallLogger.js';
import { getTaskLlmConfig } from '../../config/taskLlmConfig.js';
import { fetchLlmResponse, readLlmResponse } from './llmTransport.js';
import { isOpenAiCredentialError } from './openAiErrors.js';
import { buildVisionPrompt } from './prompts/visionPrompt.js';

const fallbackReason = 'Unable to inspect pixels without configured vision provider. Treat as a sketch/reference.';

export async function describeImage(image) {
  if (!image) return null;

  const fallback = fallbackDescription(image);
  const config = getTaskLlmConfig('vision');
  if (config.provider === 'mock' || !config.apiKey) return fallback;

  try {
    const { model } = config;
    const dataUrl = 'data:' + image.mimetype + ';base64,' + image.buffer.toString('base64');
    const data = await withCallLog({
      type: 'ai_call', operation: 'image_description', provider: config.provider, model,
      input: { prompt: buildVisionPrompt(), image: { mimeType: image.mimetype, imageBytes: image.size } },
      metadata: { qualityMode: config.qualityMode, mimeType: image.mimetype, imageBytes: image.size, temperature: config.temperature, maxOutputTokens: config.maxOutputTokens }
    }, async ({ recordUsage }) => {
      const response = await fetchLlmResponse(config, {
        input: [{
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: buildVisionPrompt()
            },
            {
              type: 'input_image',
              image_url: dataUrl,
              detail: config.imageDetail
            }
          ]
        }]
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || errorData.message || 'LLM vision request failed');
      }
      const result = await readLlmResponse(response, config);
      recordUsage(result.usage);
      return result;
    });
    const text = data.text || '';
    return normalizeVisionResult(parseJson(text), image, model);
  } catch (error) {
    if (isOpenAiCredentialError(error)) throw error;
    return { ...fallback, warning: 'Vision analysis failed: ' + error.message };
  }
}

function fallbackDescription(image) {
  return {
    layout: 'Development fallback: uploaded image accepted and queued for visual interpretation.',
    visibleSections: [fallbackReason],
    navigation: 'Infer navigation from prompt and visible context when a vision provider is configured.',
    components: ['Upload reference image', 'Prompt-derived UI sections'],
    visualStyle: 'Use prompt plus uploaded image metadata as design direction.',
    textContent: [],
    metadata: imageMetadata(image)
  };
}

function normalizeVisionResult(value, image, model) {
  return {
    layout: stringOr(value.layout, 'Uploaded reference image analyzed for layout direction.'),
    visibleSections: arrayOr(value.visibleSections, []),
    navigation: stringOr(value.navigation, ''),
    components: arrayOr(value.components, []),
    visualStyle: stringOr(value.visualStyle, ''),
    textContent: arrayOr(value.textContent, []),
    metadata: { ...imageMetadata(image), model, ...(value.metadata && typeof value.metadata === 'object' ? value.metadata : {}) }
  };
}

function parseJson(text) {
  const raw = String(text || '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('Vision model did not return JSON.');
  return JSON.parse(raw.slice(start, end + 1));
}

function imageMetadata(image) {
  return {
    originalName: image.originalname,
    mimeType: image.mimetype,
    size: image.size
  };
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function arrayOr(value, fallback) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : fallback;
}
