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

export function buildEditTargetingPrompt(message, fileCatalog) {
  return [
    'You are a semantic file-selection agent for edits to an existing React/Vite frontend.',
    'Understand the user\'s intended outcome even when wording is conversational, vague, or misspelled. Do not depend on exact keyword matches.',
    'Choose only files from the supplied catalog that the Edit Agent must read or update to implement the request.',
    'Select the primary page/component plus directly relevant styling, content, or integration files. Prefer 1-6 files and never select unrelated pages.',
    'Return strict JSON only: {"understanding":"concise interpretation","targets":["exact/path.jsx"],"confidence":"high|medium|low"}.',
    'User request: ' + JSON.stringify(message),
    'Available project file catalog:\n' + JSON.stringify(fileCatalog, null, 2)
  ].join('\n');
}
