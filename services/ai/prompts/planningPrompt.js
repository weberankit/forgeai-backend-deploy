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
