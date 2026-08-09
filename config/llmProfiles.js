// Provider-specific model names live here. Switching LLM_PROVIDER selects the
// complete matching standard/deep profile without changing pipeline code.

const OPENAI_MODELS = Object.freeze({
  expansion: 'gpt-4.1-mini',
  planning: 'gpt-5.4-mini',
  generation_repair: 'gpt-5.4-mini',
  edit: 'gpt-5.4-mini',
  explain: 'gpt-4.1-mini',
  vision: 'gpt-4.1-mini',
  intent: 'gpt-4.1-nano',
  phases: Object.freeze({
    project_setup: 'gpt-4.1-mini',
    component_registry: 'gpt-5.4-mini',
    layout_and_routing: 'gpt-5.4-mini',
    pages_and_features: 'gpt-5.4-mini',
    styling_system: 'gpt-5.4-mini',
    integration: 'gpt-5.4-mini'
  }),
  deep: Object.freeze({
    planning: 'gpt-5.2',
    layout_and_routing: 'gpt-5.2',
    pages_and_features: 'gpt-5.2',
    styling_system: 'gpt-5.2'
  })
});

const MISTRAL_MODELS = Object.freeze({
  expansion: 'mistral-small-latest',
  planning: 'mistral-large-latest',
  generation_repair: 'mistral-large-latest',
  edit: 'mistral-small-latest',
  explain: 'mistral-small-latest',
  vision: 'mistral-small-latest',
  intent: 'mistral-small-latest',
  phases: Object.freeze({
    project_setup: 'mistral-small-latest',
    component_registry: 'mistral-large-latest',
    layout_and_routing: 'mistral-large-latest',
    pages_and_features: 'mistral-large-latest',
    styling_system: 'mistral-large-latest',
    integration: 'mistral-large-latest'
  }),
  deep: Object.freeze({
    planning: 'mistral-large-latest',
    layout_and_routing: 'mistral-large-latest',
    pages_and_features: 'mistral-large-latest',
    styling_system: 'mistral-large-latest'
  })
});


// const MISTRAL_MODELS = Object.freeze({
//   expansion: 'ministral-3b-latest',
//   planning: 'ministral-8b-latest',
//   generation_repair: 'ministral-8b-latest',
//   edit: 'ministral-8b-latest',
//   explain: 'ministral-3b-latest',
//   vision: 'mistral-small-latest',
//   intent: 'ministral-3b-latest',

//   phases: Object.freeze({
//     project_setup: 'ministral-3b-latest',
//     component_registry: 'ministral-8b-latest',
//     layout_and_routing: 'ministral-8b-latest',
//     pages_and_features: 'ministral-8b-latest',
//     styling_system: 'ministral-8b-latest',
//     integration: 'ministral-3b-latest'
//   }),

//   deep: Object.freeze({
//     planning: 'mistral-small-latest',
//     layout_and_routing: 'mistral-small-latest',
//     pages_and_features: 'mistral-small-latest',
//     styling_system: 'mistral-small-latest'
//   })
// });

// const MISTRAL_MODELS = Object.freeze({
//   expansion: 'ministral-3b-latest',
//   planning: 'ministral-8b-latest',
//   generation_repair: 'ministral-8b-latest',
//   edit: 'ministral-8b-latest',
//   explain: 'ministral-3b-latest',
//   vision: 'mistral-small-latest',
//   intent: 'ministral-3b-latest',

//   phases: Object.freeze({
//     project_setup: 'ministral-3b-latest',
//     component_registry: 'ministral-8b-latest',
//     layout_and_routing: 'ministral-8b-latest',
//     pages_and_features: 'ministral-8b-latest',
//     styling_system: 'ministral-8b-latest',
//     integration: 'ministral-3b-latest'
//   }),

//   deep: Object.freeze({
//     planning: 'mistral-large-latest',
//     layout_and_routing: 'mistral-large-latest',
//     pages_and_features: 'mistral-large-latest',
//     styling_system: 'mistral-large-latest'
//   })
// });

export const PROVIDER_MODELS = Object.freeze({
  openai: OPENAI_MODELS,
  mistral: MISTRAL_MODELS
});

export const PROVIDER_LLM_QUALITY_PROFILES = Object.freeze({
  openai: buildQualityProfiles('openai', OPENAI_MODELS),
  mistral: buildQualityProfiles('mistral', MISTRAL_MODELS)
});

// Backward-compatible OpenAI exports used by existing diagnostics and tests.
export const LLM_QUALITY_PROFILES = PROVIDER_LLM_QUALITY_PROFILES.openai;
export const LLM_PROFILES = LLM_QUALITY_PROFILES.standard;

export function getLlmProfile(task, qualityMode = 'standard', context = {}, provider = 'openai') {
  const taskProfile = PROVIDER_LLM_QUALITY_PROFILES[provider]?.[qualityMode]?.[task];
  if (task === 'code_generation' && context.phase) {
    return taskProfile?.phaseProfiles?.[context.phase] || taskProfile;
  }
  return taskProfile;
}

function buildQualityProfiles(provider, models) {
  const standard = Object.freeze({
    expansion: profile('Turn a user request into a detailed specification', models.expansion, 0.2, 8000, provider),
    planning: profile('Create the project blueprint and file plan', models.planning, undefined, 10000, provider),
    code_generation: codeGenerationProfile(
      'Generate complete frontend source files',
      models.phases.pages_and_features,
      undefined,
      16000,
      {
        project_setup: profile('Create the React, Vite, and Tailwind foundation', models.phases.project_setup, 0.1, 6000, provider),
        component_registry: profile('Create reusable components and their contracts', models.phases.component_registry, undefined, 12000, provider),
        layout_and_routing: profile('Create responsive layouts, navigation, and routing', models.phases.layout_and_routing, undefined, 14000, provider),
        pages_and_features: profile('Create application pages and interactive features', models.phases.pages_and_features, undefined, 16000, provider),
        styling_system: profile('Create the Tailwind design system and global styles', models.phases.styling_system, undefined, 10000, provider),
        integration: profile('Integrate routes, providers, and the application entry point', models.phases.integration, undefined, 8000, provider)
      },
      provider
    ),
    generation_repair: profile('Repair invalid or incomplete generated files', models.generation_repair, undefined, 16000, provider),
    edit: Object.freeze({
      ...profile('Apply requested edits to generated files', models.edit, undefined, 6000, provider),
      timeoutMs: 60000
    }),
    explain: profile('Explain the generated application and code flow', models.explain, 0.3, 6000, provider),
    vision: profile('Analyze an uploaded UI reference image', models.vision, 0.2, 4000, provider),
    intent: profile('Classify a chat message into edit/explain/build', models.intent, 0, 300, provider)
  });
  const deep = Object.freeze({
    ...standard,
    planning: profile('Create a detailed premium project blueprint and file plan', models.deep.planning || models.planning, undefined, 10000, provider),
    code_generation: codeGenerationProfile(
      'Generate complete frontend source files with phase-aware quality routing',
      models.phases.pages_and_features,
      undefined,
      16000,
      {
        ...standard.code_generation.phaseProfiles,
        layout_and_routing: profile('Create premium responsive layouts, navigation, and routing', models.deep.layout_and_routing || models.phases.layout_and_routing, undefined, 14000, provider),
        pages_and_features: profile('Create visually polished pages and interactive features', models.deep.pages_and_features || models.phases.pages_and_features, undefined, 16000, provider),
        styling_system: profile('Create a premium Tailwind design system and global styles', models.deep.styling_system || models.phases.styling_system, undefined, 10000, provider)
      },
      provider
    )
  });
  return Object.freeze({ standard, deep });
}

function profile(description, model, temperature, maxOutputTokens, provider) {
  return Object.freeze({ description, provider, model, temperature, maxOutputTokens, timeoutMs: 120000, maxRetries: 2 });
}

function codeGenerationProfile(description, model, temperature, maxOutputTokens, phaseProfiles, provider) {
  return Object.freeze({
    ...profile(description, model, temperature, maxOutputTokens, provider),
    phaseProfiles: Object.freeze({ ...phaseProfiles })
  });
}
