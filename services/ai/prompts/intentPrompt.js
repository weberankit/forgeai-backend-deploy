export function buildIntentPrompt(message) {
  return [
    'Classify a message sent after a frontend project has been generated.',
    'Return strict JSON only: {"intent":"edit|explain|build|unknown"}.',
    'edit means the user wants any generated UI, code, content, style, layout, or behavior changed, including polite questions such as Can you edit the FAQ?',
    'explain means the user wants information without changing files.',
    'build means the user asks to create or regenerate a project.',
    'Message: ' + JSON.stringify(message)
  ].join('\n');
}
