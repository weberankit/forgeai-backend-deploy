const allowedIntents = new Set(['edit', 'explain', 'build', 'unknown']);
const intentCache = new Map();
const INTENT_CACHE_MS = 30_000;

export async function routeChatIntent(message) {
  const text = String(message || '').trim();
  if (!text) return 'unknown';
  const cached = intentCache.get(text);
  if (cached && Date.now() - cached.createdAt < INTENT_CACHE_MS) return cached.intent;
  if ((process.env.AI_PROVIDER || 'mock') === 'openai' && process.env.OPENAI_API_KEY) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const intent = await classifyWithSmallModel(text);
        rememberIntent(text, intent);
        return intent;
      } catch (error) {
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

async function classifyWithSmallModel(message) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_INTENT_MODEL || 'gpt-4.1-mini',
      input: [
        'Classify a message sent after a frontend project has been generated.',
        'Return strict JSON only: {"intent":"edit|explain|build|unknown"}.',
        'edit means the user wants any generated UI, code, content, style, layout, or behavior changed, including polite questions such as Can you edit the FAQ?',
        'explain means the user wants information without changing files.',
        'build means the user asks to create or regenerate a project.',
        'Message: ' + JSON.stringify(message)
      ].join('\n')
    })
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error?.message || 'Intent model request failed');
  }
  const data = await response.json();
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
