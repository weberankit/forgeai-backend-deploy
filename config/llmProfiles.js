// Edit this table to choose the default LLM behavior for each backend task.
// Environment variables can override any profile without changing source code.

//cheap

// export const LLM_PROFILES = Object.freeze({
//   expansion: profile('Turn a user request into a detailed specification', 'gpt-4.1-mini', 0.2, 8000),
//   planning: profile('Create the project blueprint and file plan', 'gpt-4.1-mini', 0.15, 10000),
//   code_generation: profile('Generate complete frontend source files', 'gpt-4.1-mini', 0.1, 16000),
//   generation_repair: profile('Repair invalid or incomplete generated files', 'gpt-4.1-mini', 0.05, 16000),
//   edit: profile('Apply requested edits to generated files', 'gpt-4.1-mini', 0.1, 16000),
//   explain: profile('Explain the generated application and code flow', 'gpt-4.1-mini', 0.3, 8000),
//   vision: profile('Analyze an uploaded UI reference image', 'gpt-4.1-mini', 0.2, 4000),
//   intent: profile('Classify a chat message into edit/explain/build', 'gpt-4.1-mini', 0, 500)
// });


// // // Environment variables can override any profile without changing source code.
export const LLM_PROFILES = Object.freeze({
  expansion: profile(
    'Turn a user request into a detailed specification',
    'gpt-4.1-mini',
    0.2,
    8000
  ),

  planning: profile(
    'Create the project blueprint and file plan',
    'gpt-5.2',
    undefined,
    10000
  ),

  code_generation: profile(
    'Generate complete frontend source files',
    'gpt-5.2',
    undefined,
    16000
  ),

  generation_repair: profile(
    'Repair invalid or incomplete generated files',
    'gpt-5.2',
    undefined,
    16000
  ),

  edit: profile(
    'Apply requested edits to generated files',
    'gpt-5.2',
    undefined,
    16000
  ),

  explain: profile(
    'Explain the generated application and code flow',
    'gpt-4.1-mini',
    0.3,
    8000
  ),

  vision: profile(
    'Analyze an uploaded UI reference image',
    'gpt-4.1-mini',
    0.2,
    4000
  ),

  intent: profile(
    'Classify a chat message into edit/explain/build',
    'gpt-4.1-mini',
    0,
    500
  ),
});










function profile(description, model, temperature, maxOutputTokens, provider = 'openai') {
  return Object.freeze({
    description,
    provider,
    model,
    temperature,
    maxOutputTokens,
    timeoutMs: 120000,
    maxRetries: 2
  });
}
