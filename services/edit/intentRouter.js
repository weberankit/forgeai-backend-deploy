export function routeChatIntent(message) {
  const text = String(message || '').toLowerCase();
  if (/(change|make|add|remove|update|dark|toggle|rename|text|button|section|card|menu|save|persist)/.test(text)) return 'edit';
  if (/^(build|create|generate)\b/.test(text)) return 'build';
  if (/(explain|why|how|what)/.test(text)) return 'explain';
  return 'unknown';
}
