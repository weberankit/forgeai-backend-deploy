import { httpError } from '../../utils/httpError.js';

export function stripMarkdownFences(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

export function parseStructuredResponse(text, validator) {
  let parsed;
  try {
    parsed = JSON.parse(stripMarkdownFences(text));
  } catch {
    throw httpError(502, 'AI provider returned invalid JSON.');
  }

  const result = validator(parsed);
  if (!result.valid) {
    throw httpError(502, `AI provider returned invalid structured output: ${result.message}`);
  }
  return parsed;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) return `${field} must be an array`;
  return null;
}

export function validateExpansionSpec(value) {
  const requiredStrings = ['projectName', 'projectSummary'];
  for (const field of requiredStrings) {
    if (!value[field] || typeof value[field] !== 'string') return { valid: false, message: `${field} is required` };
  }
  const arrays = [
    'targetUsers',
    'pages',
    'routes',
    'sharedComponents',
    'coreFeatures',
    'dataRequirements',
    'reduxRequirements',
    'localStorageRequirements',
    'responsiveRequirements',
    'accessibilityRequirements',
    'designDirection',
    'assumptions',
    'blockingQuestions'
  ];
  for (const field of arrays) {
    const error = requireArray(value[field], field);
    if (error) return { valid: false, message: error };
  }
  return { valid: true };
}

export function validateBlueprint(value) {
  const arrays = [
    'requiredDependencies',
    'folderStructure',
    'fileList',
    'routes',
    'reduxSlices',
    'sharedComponentContracts',
    'mockDataRequirements',
    'localStorageBehavior',
    'implementationPhases',
    'acceptanceCriteria'
  ];
  for (const field of arrays) {
    const error = requireArray(value[field], field);
    if (error) return { valid: false, message: error };
  }
  return { valid: true };
}
