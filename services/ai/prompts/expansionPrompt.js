export function buildExpansionPrompt({ prompt, imageDescription }) {
  return `You are expanding a request into a frontend-only React application specification.

Return strict JSON only. Do not include Markdown fences.

Rules:
- Generated applications use React.js with Vite, JavaScript, Tailwind CSS, and React Router when useful.
- Redux Toolkit is included only when useful.
- Do not propose generated Express backends, databases, authentication, or server architecture.
- Infer requirements where possible and list only genuine blocking questions.
- Treat routes as the authoritative page list. Every pages entry must have exactly one matching routes entry, and every routes entry must have exactly one matching pages entry.
- Use the same component name in routes that planning should use for src/pages/<Component>.jsx.
- Do not ask the user to choose router, state, styling, data-fetching, provider, or folder architecture; record product assumptions here and let the planner lock implementation architecture.

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

// export function buildExpansionPrompt({ prompt, imageDescription }) {
//   return `You are expanding a request into a frontend-only React application specification.

// Return strict JSON only. Do not include Markdown fences.

// Rules:
// - Generated applications use React.js with Vite, JavaScript, Tailwind CSS, and React Router when useful.
// - Redux Toolkit is included only when useful.
// - Do not propose generated Express backends, databases, authentication, or server architecture.
// - This is always a frontend-only application with mock/local data throughout.
//   This is a hard platform constraint: no real backend, API call, or auth
//   provider will ever be integrated, regardless of what the user asks for.
//   Never ask a blocking question about whether a backend, real API, or real
//   auth should exist — the answer is always no, it will be mocked.

// BLOCKING QUESTIONS — strict scope:
// Only include a question in "blockingQuestions" if the answer would change the
// fundamental shape of the generated app's UI/UX AND no reasonable default exists.
// This means:
// - What shape or behavior the mock data for a named third-party integration
//   should simulate (e.g. "Stripe checkout" mentioned but no details on
//   which payment methods/fields to mock).
// - Whether data must persist across page reloads (localStorage) or in-memory
//   state for the session is acceptable.
// - Whether "login"/"auth" mentioned in the prompt implies specific role-based
//   UI (e.g. admin vs regular user views) that changes page/route structure —
//   not whether the auth itself is real (it never is).
// - Whether an existing brand/design system must be matched, if the prompt
//   references one without providing details.

// Do NOT ask about:
// - Backend/database/server/real-API existence (never applicable — always
//   frontend-only, always mocked).
// - Router choice, state management library choice, folder structure, or any
//   other implementation detail — decide these yourself and record them under
//   "assumptions" instead.
// - Visual style, copy, or content specifics — infer a reasonable default and
//   record it under "assumptions" or "designDirection".

// If you are unsure whether something qualifies, default to putting it in
// "assumptions" rather than "blockingQuestions". Prefer generating a complete,
// reasonable app over stalling for clarification.

// User prompt:
// ${prompt}

// Image description:
// ${imageDescription ? JSON.stringify(imageDescription, null, 2) : 'No image provided.'}

// Required JSON shape:
// {
//   "projectName": "string",
//   "projectSummary": "string",
//   "targetUsers": ["string"],
//   "pages": [{"name": "string", "route": "string", "purpose": "string"}],
//   "routes": [{"path": "string", "component": "string"}],
//   "sharedComponents": ["string"],
//   "coreFeatures": ["string"],
//   "dataRequirements": ["string"],
//   "mockIntegrations": ["string"],
//   "reduxRequirements": ["string"],
//   "localStorageRequirements": ["string"],
//   "responsiveRequirements": ["string"],
//   "accessibilityRequirements": ["string"],
//   "designDirection": ["string"],
//   "assumptions": ["string"],
//   "blockingQuestions": ["string"]
// }`;
// }
