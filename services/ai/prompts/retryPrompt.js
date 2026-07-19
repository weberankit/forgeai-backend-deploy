export function buildRetryPrompt(originalPrompt, error) {
  return originalPrompt + '\n\nYour previous response was rejected: ' + error.message + '\nReturn only valid JSON matching the exact requested shape. Do not include Markdown fences or commentary.';
}
