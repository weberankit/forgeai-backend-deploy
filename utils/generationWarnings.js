export function normalizeGenerationWarnings(values = []) {
  const items = Array.isArray(values) ? values : [values];
  const normalized = items.slice(0, 100).map((warning) => {
    if (typeof warning === 'string') return warning.trim();
    if (warning === null || warning === undefined) return '';
    if (typeof warning !== 'object') return String(warning);
    const path = typeof warning.path === 'string' ? warning.path.trim() : '';
    const detail = warning.message ?? warning.warning ?? warning.reason ?? warning.description ?? warning.code;
    let message = '';
    if (typeof detail === 'string') message = detail.trim();
    else if (detail !== undefined) {
      try { message = JSON.stringify(detail); } catch { message = String(detail); }
    }
    if (!message) {
      try { message = JSON.stringify(warning); } catch { message = 'Unstructured generation warning'; }
    }
    return [path, message].filter(Boolean).join(': ');
  }).map((warning) => warning.slice(0, 1000)).filter(Boolean);
  return [...new Set(normalized)];
}
