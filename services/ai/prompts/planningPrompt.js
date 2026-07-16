export function buildPlanningPrompt({ specification, clarification }) {
  return `You are creating a dependency-ordered implementation blueprint for a frontend-only React Vite app.

Return strict JSON only. Do not include Markdown fences.

Rules:
- Generated applications must not include Express, databases, authentication, or server-side architecture.
- Order planned files by dependency so foundational utilities and store files appear before components/pages that consume them.

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
