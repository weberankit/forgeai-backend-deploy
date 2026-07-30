export const LLM_QUALITY_MODES = Object.freeze(['standard', 'deep']);

export function normalizeLlmQualityMode(value, fallback = 'standard') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (!LLM_QUALITY_MODES.includes(normalized)) {
    throw new Error('Unsupported LLM quality mode: ' + normalized + '. Expected standard or deep.');
  }
  return normalized;
}
