export function buildExpansionPrompt({ prompt, imageDescription }) {
  return `You are expanding a request into a frontend-only React application specification.

Return strict JSON only. Do not include Markdown fences.

Rules:
- Generated applications use React.js with Vite, JavaScript, Tailwind CSS, and React Router when useful.
- Redux Toolkit is included only when useful.
- Do not propose generated Express backends, databases, authentication, or server architecture.
- Infer requirements where possible and list only genuine blocking questions.

User prompt:
${prompt}

Image description:
${imageDescription ? JSON.stringify(imageDescription, null, 2) : 'No image provided.'}

Required JSON shape:
{
  "projectName": "string",
  "projectSummary": "string",
  "targetUsers": ["string"],
  "pages": [{"name": "string", "route": "string", "purpose": "string"}],
  "routes": [{"path": "string", "component": "string"}],
  "sharedComponents": ["string"],
  "coreFeatures": ["string"],
  "dataRequirements": ["string"],
  "reduxRequirements": ["string"],
  "localStorageRequirements": ["string"],
  "responsiveRequirements": ["string"],
  "accessibilityRequirements": ["string"],
  "designDirection": ["string"],
  "assumptions": ["string"],
  "blockingQuestions": ["string"]
}`;
}
