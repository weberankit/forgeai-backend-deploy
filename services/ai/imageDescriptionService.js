const fallbackReason = 'Unable to inspect pixels without configured vision provider. Treat as a sketch/reference.';

export async function describeImage(image) {
  if (!image) return null;

  const fallback = fallbackDescription(image);
  if ((process.env.AI_PROVIDER || 'mock') !== 'openai' || !process.env.OPENAI_API_KEY) return fallback;

  try {
    const model = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
    const dataUrl = 'data:' + image.mimetype + ';base64,' + image.buffer.toString('base64');
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        input: [{
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                'Analyze this uploaded UI sketch/reference image for a frontend React app generator.',
                'Return strict JSON only with this shape:',
                '{"layout":"string","visibleSections":["string"],"navigation":"string","components":["string"],"visualStyle":"string","textContent":["string"],"metadata":{}}',
                'Focus on layout, UI sections, components, visual hierarchy, colors, and any readable labels. Do not invent backend requirements.'
              ].join('\n')
            },
            {
              type: 'input_image',
              image_url: dataUrl,
              detail: process.env.OPENAI_IMAGE_DETAIL || 'auto'
            }
          ]
        }]
      })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error?.message || 'OpenAI vision request failed');
    }
    const data = await response.json();
    const text = data.output_text || data.output?.flatMap((item) => item.content || []).map((part) => part.text || '').join('\n') || '';
    return normalizeVisionResult(parseJson(text), image, model);
  } catch (error) {
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
