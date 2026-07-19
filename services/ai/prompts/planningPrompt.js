export function buildPlanningPrompt({ specification, clarification }) {
  return `You are creating a dependency-ordered implementation blueprint for a frontend-only React Vite app.

Return strict JSON only. Do not include Markdown fences.

Rules:
- Generated applications must not include Express, databases, authentication, or server-side architecture.
- Order planned files by dependency so foundational utilities and store files appear before components/pages that consume them.
- The blueprint must directly implement the specification's requested pages, sections, interactions, visual direction, and data—not a generic dashboard.
- Use src/App.jsx as the only application integration entry and src/main.jsx as the only React root entry.
- Include a concrete route for /. Every route component must have a matching src/pages/<Component>.jsx file.
- List every browser npm package actually required by planned code in requiredDependencies. Do not list server packages.
- Give every file one complete responsibility and explicit dependsOn paths. Never plan the same path twice.

Specification:
${JSON.stringify(specification, null, 2)}

Clarification:
${clarification || 'No clarification.'}

Required JSON shape:
{
  "requiredDependencies": ["string"],
  "folderStructure": ["string"],
  "fileList": [{"path": "string", "responsibility": "string", "dependsOn": ["string"]}],
  "routes": [{"path": "string", "component": "string"}],
  "reduxSlices": [{"name": "string", "state": ["string"], "responsibility": "string"}],
  "sharedComponentContracts": [{"name": "string", "props": ["string"], "responsibility": "string"}],
  "mockDataRequirements": ["string"],
  "localStorageBehavior": ["string"],
  "implementationPhases": ["string"],
  "acceptanceCriteria": ["string"]
}`;
}


// export function buildPlanningPrompt({ specification, clarification }) {
//   return `You are creating a dependency-ordered implementation blueprint for a frontend-only React Vite app.

// Return strict JSON only. Do not include Markdown fences.

// Rules:
// - Generated applications must not include Express, databases, authentication, or server-side architecture.
// - This is a hard platform constraint, not a per-request choice: no planned file may
//   call, fetch from, or depend on a real external API, backend, or auth provider,
//   regardless of what the user's prompt implies or requests.
// - ALL data is mock or local. If the specification describes login, payments,
//   search, user accounts, dashboards, or any other feature that would normally
//   call a real service, implement it fully as UI + interaction logic backed by
//   mock data (hardcoded arrays/objects, in-memory state, or localStorage) —
//   never a real network call. Example: a "login page" request means a complete
//   login form with client-side validation and a mock credential check (e.g.
//   against a hardcoded user list, or accepting any non-empty input), followed
//   by mock-authenticated app state — not a call to a real auth endpoint.
// - If the user's prompt explicitly asks to integrate a real, named third-party
//   API, do not silently ignore this — instead plan the feature's full UI and
//   interaction flow using realistic mock data shaped like that API's expected
//   response, and note the omission in acceptanceCriteria (e.g. "Stripe checkout
//   UI implemented with mock payment flow; real Stripe integration not included").
// - Order planned files by dependency so foundational utilities and store files appear before components/pages that consume them.
// - The blueprint must directly implement the specification's requested pages, sections, interactions, visual direction, and data—not a generic dashboard.
// - Use src/App.jsx as the only application integration entry and src/main.jsx as the only React root entry.
// - Include a concrete route for /. Every route component must have a matching src/pages/<Component>.jsx file.
// - List every browser npm package actually required by planned code in requiredDependencies. Do not list server packages.
// - Give every file one complete responsibility and explicit dependsOn paths. Never plan the same path twice.

// Specification:
// ${JSON.stringify(specification, null, 2)}

// Clarification:
// ${clarification || 'No clarification.'}

// Required JSON shape:
// {
//   "requiredDependencies": ["string"],
//   "folderStructure": ["string"],
//   "fileList": [{"path": "string", "responsibility": "string", "dependsOn": ["string"]}],
//   "routes": [{"path": "string", "component": "string"}],
//   "reduxSlices": [{"name": "string", "state": ["string"], "responsibility": "string"}],
//   "sharedComponentContracts": [{"name": "string", "props": ["string"], "responsibility": "string"}],
//   "mockDataRequirements": ["string"],
//   "localStorageBehavior": ["string"],
//   "implementationPhases": ["string"],
//   "acceptanceCriteria": ["string"]
// }`;
// }