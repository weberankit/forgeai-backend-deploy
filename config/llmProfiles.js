// Edit this table to choose the default LLM behavior for each backend task.
// Environment variables can override any profile without changing source code.

//cheap

const STANDARD_LLM_PROFILES = Object.freeze({
  expansion: profile('Turn a user request into a detailed specification', 'gpt-4.1-mini', 0.2, 8000),
  planning: profile('Create the project blueprint and file plan', 'gpt-5.4-mini', undefined, 10000),
  code_generation: codeGenerationProfile(
    'Generate complete frontend source files',
    'gpt-5.4-mini',
    undefined,
    16000,
    {
      project_setup: profile('Create the React, Vite, and Tailwind foundation', 'gpt-4.1-mini', 0.1, 6000),
      component_registry: profile('Create reusable components and their contracts', 'gpt-5.4-mini', undefined, 12000),
      layout_and_routing: profile('Create responsive layouts, navigation, and routing', 'gpt-5.4-mini', undefined, 14000),
      pages_and_features: profile('Create application pages and interactive features', 'gpt-5.4-mini', undefined, 16000),
      styling_system: profile('Create the Tailwind design system and global styles', 'gpt-5.4-mini', undefined, 10000),
      integration: profile('Integrate routes, providers, and the application entry point', 'gpt-5.4-mini', undefined, 8000)
    }
  ),
  generation_repair: profile('Repair invalid or incomplete generated files', 'gpt-5.4-mini', undefined, 16000),
  edit: profile('Apply requested edits to generated files', 'gpt-5.4-mini', undefined, 12000),
  explain: profile('Explain the generated application and code flow', 'gpt-4.1-mini', 0.3, 6000),
  vision: profile('Analyze an uploaded UI reference image', 'gpt-4.1-mini', 0.2, 4000),
  intent: profile('Classify a chat message into edit/explain/build', 'gpt-4.1-nano', 0, 300)
});

const DEEP_LLM_PROFILES = Object.freeze({
  ...STANDARD_LLM_PROFILES,
  planning: profile('Create a detailed premium project blueprint and file plan', 'gpt-5.2', undefined, 10000),
  code_generation: codeGenerationProfile(
    'Generate complete frontend source files with phase-aware quality routing',
    'gpt-5.4-mini',
    undefined,
    16000,
    {
      ...STANDARD_LLM_PROFILES.code_generation.phaseProfiles,
      layout_and_routing: profile('Create premium responsive layouts, navigation, and routing', 'gpt-5.2', undefined, 14000),
      pages_and_features: profile('Create visually polished pages and interactive features', 'gpt-5.2', undefined, 16000),
      styling_system: profile('Create a premium Tailwind design system and global styles', 'gpt-5.2', undefined, 10000)
    }
  )
});

export const LLM_QUALITY_PROFILES = Object.freeze({
  standard: STANDARD_LLM_PROFILES,
  deep: DEEP_LLM_PROFILES
});

export const LLM_PROFILES = LLM_QUALITY_PROFILES.standard;

export function getLlmProfile(task, qualityMode = 'standard', context = {}) {
  const taskProfile = LLM_QUALITY_PROFILES[qualityMode]?.[task];
  if (task === 'code_generation' && context.phase) {
    return taskProfile?.phaseProfiles?.[context.phase] || taskProfile;
  }
  return taskProfile;
}

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

function codeGenerationProfile(description, model, temperature, maxOutputTokens, phaseProfiles) {
  return Object.freeze({
    ...profile(description, model, temperature, maxOutputTokens),
    phaseProfiles: Object.freeze({ ...phaseProfiles })
  });
}
