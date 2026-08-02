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
    'You are a semantic scope and file-selection agent for edits to an existing React/Vite frontend.',
    'Understand the user\'s intended outcome even when wording is conversational, vague, or misspelled. Do not depend on exact keyword matches.',
    'First decide whether the request is actionable and whether its requested page/component exists in the supplied catalog.',
    'Ask for clarification when the request is too broad to implement safely, lacks a concrete desired outcome, names a page/component that does not exist, or only says to fix/change everything.',
    'Do not ask for clarification when the user gives a specific target and concrete change. Do not invent missing files.',
    'When clarification is needed, write one concise question that tells the user what information or decision is required. For a missing page, ask whether it should be created.',
    'When the request is actionable, choose only files from the supplied catalog that the Edit Agent must read or update. Prefer 1-6 directly related files and never select unrelated pages.',
    'Return strict JSON only with this shape:',
    '{"understanding":"concise interpretation","scope":"focused|multi_file|whole_project|missing_target","clarity":"clear|ambiguous","needsClarification":false,"clarificationReason":"","clarificationQuestion":"","requestedTargets":["human-readable target"],"targets":["exact/path.jsx"],"confidence":"high|medium|low"}.',
    'If needsClarification is true, targets may be empty. If it is false, targets must contain at least one exact catalog path.',
    'User request: ' + JSON.stringify(message),
    'Available project file catalog:\n' + JSON.stringify(fileCatalog, null, 2)
  ].join('\n');
}
