# AI ForeMan Frontend Software Engineer — Backend

Node.js + Express + MongoDB backend for a platform that turns a text prompt or UI sketch into a frontend-only React application specification, blueprint, and generated implementation.

## Repository Layout

The frontend and backend are intentionally separated. There is no root npm workspace and no root `node_modules`. Install dependencies inside each app folder.

```text
client/   Vite React frontend
server/   Express + MongoDB backend
```

## Stack

- Node.js
- Express.js
- MongoDB
- Mongoose

## Setup

```bash
cd server
npm install
cp .env.example .env
npm run dev
```

MongoDB must be running before the backend can stay up.

### Environment Variables

```env
PORT=4000
MONGODB_URI=mongodb://127.0.0.1:27017/ai_frontend_engineer
CLIENT_ORIGIN=http://localhost:5173
AI_PROVIDER=mock
VISION_PROVIDER=mock
MAX_IMAGE_SIZE_MB=5
DEMO_MODE=false
DEPLOY_PROVIDER=mock
VERCEL_TOKEN=
VERCEL_TEAM_ID=
```

The server does not read a shared OpenAI API key. Each browser tab supplies its user key through the `x-openai-api-key` header for AI routes. The frontend validates the key, stores it in `sessionStorage`, and removes it when that tab session ends.

## Visitor Continuity

There is no authentication. The browser generates a UUID with `crypto.randomUUID()` and stores it in `localStorage` under `ai_frontend_engineer_visitor_id`. The frontend sends it on every request as the `x-visitor-id` header. Chats and projects are stored by `visitorId`.

## API Routes

### Chats

```text
POST   /api/chats
GET    /api/chats
GET    /api/chats/:chatId
POST   /api/chats/:chatId/messages
```

### Projects

```text
POST   /api/projects/expand
POST   /api/projects/plan
GET    /api/projects/:projectId
GET    /api/projects/:projectId/files
PATCH  /api/projects/:projectId/files
POST   /api/projects/:projectId/generate
POST   /api/projects/:projectId/regenerate
PATCH  /api/projects/:projectId/approval
POST   /api/projects/:projectId/review
POST   /api/projects/:projectId/fix
POST   /api/projects/:projectId/edit
GET    /api/projects/:projectId/reviews
GET    /api/projects/:projectId/dependency-graph
POST   /api/projects/:projectId/restore
POST   /api/projects/:projectId/explain
POST   /api/projects/:projectId/deploy
GET    /api/projects/:projectId/deployments
GET    /api/projects/deployments/:deploymentId/status
GET    /api/projects/memory/verified-fixes
```

### Health

```text
GET    /api/health
```

## Core Product Flow

```text
visitor opens app
  -> browser creates/stores UUID in localStorage
  -> frontend sends UUID as x-visitor-id
  -> user creates a chat and submits a prompt or image
  -> backend stores chat/project under visitorId
  -> expansion agent creates a frontend-only specification
  -> planning agent creates an implementation blueprint
  -> user approves the blueprint
  -> generation creates dependency-ordered React/Vite files
  -> files are stored on Project.generatedFiles
  -> frontend displays a file tree and code viewer
  -> WebContainer mounts the files
  -> WebContainer runs npm install, then npm run dev -- --host 0.0.0.0
  -> preview iframe loads the generated app
  -> review, fix, edit, explain, and deploy operate on the persisted files
```

## AI / Agent Orchestration

LLM orchestration is LangGraph-based. Primary file:

```text
server/services/ai/langGraphAgent.js
```

Graph-backed stages:

- `expansion_agent` — prompt/image to specification
- `planning_agent` — specification to blueprint
- `code_generation_agent` — dependency-batched file generation

Public service calls route through LangGraph:

```text
expandSpecification()   -> runExpansionGraph()
planFrontendProject()    -> runPlanningGraph()
generateProjectFiles()   -> runCodeGenerationGraph() (per batch)
```

With `AI_PROVIDER=openai`, LangGraph nodes call the OpenAI API and validate structured JSON output, retrying once on invalid output.

### LangGraph State Graph Structure

The core build pipeline (`runExpansionGraph` / `runPlanningGraph` /
`runCodeGenerationGraph`) is not one monolithic graph — it is three
separate compiled StateGraphs, invoked in sequence by the controller layer,
each with its own internal nodes/edges and conditional routing. The edit/
explain/review/fix/deploy agents are separate services invoked directly
from `projectController.js` on their own routes, not nodes inside these
three graphs.

**1. Expansion Graph**

```text
START
  │
  ▼
expansion_agent
  (calls OpenAI/mock, produces structured spec JSON,
   validates against schema, retries once on invalid JSON)
  │
  ▼
[conditional edge] blockingQuestions.length > 0 ?
  │                              │
  ▼ yes                          ▼ no
awaiting_clarification         END
  │  (graph pauses here -            (spec is complete,
  │   returns to controller,          returned as-is)
  │   which surfaces ONE
  │   question at a time via
  │   the chat API)
  │
  ▼ (user answers -> controller
     re-invokes the graph with
     the original input + the
     new answer appended)
  │
  └──────────────► back to expansion_agent
                   (re-runs with additional context; loop continues
                   until blockingQuestions is empty)
```

**2. Planning Graph**

```text
START
  │
  ▼
planning_agent
  (calls OpenAI/mock, takes the finalized spec from the
   Expansion Graph, produces the blueprint JSON: folder
   structure, data models, API routes, Redux slices, file
   list with dependsOn/order, implementation phases)
  │
  ▼
validate_blueprint
  (checks: every file path unique, every dependsOn resolves
   to a planned file or an installed package, no cycles)
  │
  ▼
[conditional edge] validation passed?
  │                       │
  ▼ yes                   ▼ no
END                    planning_agent
(blueprint returned    (re-run once with the validation
 to controller for      errors appended as correction
 human approval)         context, then END regardless of
                         outcome on the retry - surfaced to
                         review/approval either way)
```

**3. Code Generation Graph**

```text
START
  │
  ▼
prepare_batches
  (topologicalSort.js + generationBatches.js run here as a
   plain function node - not an LLM call - producing an
   ordered list of file batches from the approved blueprint)
  │
  ▼
code_generation_agent  ◄─────────────┐
  (generates complete file contents   │
   for the CURRENT batch only, given   │
   existing generated files + any      │
   registered component/API contracts) │
  │                                    │
  ▼                                    │
validate_batch                         │
  (generatedFileValidation.js +        │
   pathSafety.js + packageSafety.js    │
   run here as function nodes)         │
  │                                    │
  ▼                                    │
[conditional edge] batch valid?        │
  │                    │               │
  ▼ yes                ▼ no            │
persist_batch      code_generation_agent
  (writes valid       (re-run THIS batch only,
   files to            with validation errors
   Project.            appended as correction
   generatedFiles)      context)
  │
  ▼
[conditional edge] more batches remaining?
  │                              │
  ▼ yes                          ▼ no
  └──────────────────────────►  END
  (advance to next batch,        (all batches persisted,
   loop back to                   project status becomes
   code_generation_agent)         "ready_for_preview")
```

**Why three separate graphs instead of one continuous graph:** each stage
has a distinct human-in-the-loop checkpoint the controller layer needs to
own (clarifying questions after expansion, blueprint approval after
planning) — modeling these as separate compiled graphs invoked by the
controller keeps each graph's retry/validation logic focused on one
concern, rather than one large graph with many long-lived conditional
branches spanning stages that don't actually share state requirements.

### Non-graph agent services

Review, Fix, Edit, Explain, and Deploy are implemented as direct service
calls (see their dedicated flow sections below) rather than as LangGraph
nodes — they are invoked individually from `projectController.js` on their
own REST routes, since each is triggered by an independent user action
(not a continuous pipeline step), and several of them (staticValidation,
dependencyGraph, pathSafety, packageSafety) are deterministic
function-based checks with no LLM call at all.

### Expansion Agent Flow

```text
raw prompt (or image -> vision description)
  -> Requirement Expansion Agent (LangGraph node, calls OpenAI/mock)
  -> infers pages, entities, core features, backend requirement
  -> returns structured JSON spec (see codeGenerationPrompt.js schema)
  -> if blockingQuestions is non-empty:
       -> POST /api/chats/:chatId/messages surfaces one question at a time
       -> user answers -> expansion agent re-runs with the answer appended
  -> if blockingQuestions is empty:
       -> spec is stored on the Project, flow proceeds directly to Planning Agent
```

### Planning Agent Flow

```text
approved/expanded specification
  -> Project Planner Agent (LangGraph node)
  -> orders work by file dependency (components before pages,
     models/routes before frontend features that call them)
  -> produces: folder structure, data models, API routes (if full-stack),
     Redux slices, file list with "dependsOn" and "order", implementation
     phases, acceptance criteria
  -> blueprint stored on Project, returned to frontend for review
  -> user reviews via ReviewPanels.jsx -> PATCH /api/projects/:projectId/approval
  -> on approval, flow proceeds automatically to Code Generation Agent
```

### Code Generation Agent Flow

```text
approved blueprint + file plan
  -> topologicalSort.js orders files so dependencies generate first
  -> generationBatches.js groups files into dependency-safe batches
  -> for each batch:
       -> Code Generation Agent (LangGraph node) generates complete file
          contents for every file in that batch, given: existing generated
          files, registered component/API contracts, and the target file
          list for this batch only
       -> generatedFileValidation.js checks each returned file:
            - valid JSON shape
            - no partial files, no placeholder comments
            - all requested files returned, no extra files returned
       -> pathSafety.js rejects unsafe paths (../, .env, node_modules, Docker files)
       -> packageSafety.js rejects disallowed/unlisted packages and any
          lifecycle install scripts in package.json
       -> valid files are persisted to Project.generatedFiles in MongoDB
  -> once all batches complete, project status becomes "ready_for_preview"
  -> frontend polls/receives updated file tree, WebContainer boots the
     project (npm install -> npm run dev -- --host 0.0.0.0)
```

### Review Agent Flow

```text
POST /api/projects/:projectId/review
  -> staticValidation.js runs deterministic checks first (syntax, imports,
     lint-style rules) - cheap and doesn't need an LLM call
  -> dependencyGraph.js is built/refreshed from current generatedFiles
     (imports, importedBy, exports, JSX-rendered components, Redux/service
     imports)
  -> Review Agent (LangGraph node) reviews the project as a system, using
     the static validation results + dependency graph + latest build output
  -> returns structured findings: severity (blocker/high/medium/low),
     category (build/runtime/product/redux/backend/accessibility/
     responsive/maintainability), evidence, root cause, recommended change
  -> status is "failed" if any blocker/high finding exists, else "passed"
  -> findings persisted, returned to ReviewFindingsPanel.jsx
```

### Fix (Repair) Agent Flow

```text
POST /api/projects/:projectId/fix
  -> reads the latest review findings for the target file(s)
  -> versioningService.js snapshots the project BEFORE making changes
  -> Fix Agent (LangGraph node) attempts a targeted fix using the specific
     finding's evidence and recommendedChange - not a full file rewrite
     unless the finding requires it
  -> re-runs Review Agent (static validation + LLM review) on just the
     changed file(s) to confirm the fix actually resolved the finding
  -> loop: if still failing, retry (capped at 3 attempts per file)
  -> attempt 1 fails -> attempt 2 -> attempt 3 -> still failing:
       -> file is left flagged in filesNeedingChanges, NOT silently
          treated as fixed
       -> surfaced back to the user rather than looping indefinitely
  -> on success: changed file's version increments, snapshot retained for
     restore, Review Agent findings updated to reflect the resolved state
```

### Edit Agent Flow

```text
user sends a natural-language message (e.g. "make the summary cards
more compact")
  -> intentRouter.js classifies the message as build / edit / explain / unknown
  -> if "edit":
       -> editTargeting.js resolves the request to actual file(s) using
          the AST dependency graph - looks up components/sections by name
          and their importedBy relationships, rather than letting the LLM
          guess file paths
       -> versioningService.js snapshots the project before applying changes
       -> Edit Agent (LangGraph node) receives ONLY the resolved target
          file(s) plus relevant context, and applies the targeted change
       -> generatedFileValidation.js + pathSafety.js + packageSafety.js
          re-validate the edited file(s) exactly like fresh generation
       -> Review Agent re-runs on just the changed file(s)
       -> changed file(s) version increments, editStatus becomes
          "preview_ready"
       -> frontend refreshes the WebContainer mount with the updated
          file(s) and reloads the preview
  -> POST /api/projects/:projectId/restore reverts to the latest snapshot
     if the user wants to undo an edit or a failed fix attempt
```

### Explain Agent Flow

```text
user sends a question (e.g. "explain how task filtering works")
  -> intentRouter.js classifies the message as "explain"
  -> POST /api/projects/:projectId/explain
  -> Explain Agent (server/services/explain/explainAgent.js) is grounded
     in the generated files and the AST dependency graph:
       -> looks up relevant file(s) via the dependency graph (component
          registry, importedBy/imports relationships) rather than
          guessing from the question text alone
       -> walks the real call chain (e.g. UI component -> state handler
          -> Redux slice -> any service/API call it touches)
       -> reads the actual file contents for every file in that chain
  -> produces a grounded explanation referencing real file names and
     function names, with referenced files openable directly from the
     explanation panel (ExplanationPanel.jsx)
  -> does not execute or simulate UI interactions - it is static-analysis
     grounded, not a runtime trace
```

### Deploy Agent Flow

```text
POST /api/projects/:projectId/deploy
  -> deploymentService.js checks DEPLOY_PROVIDER
  -> DEPLOY_PROVIDER=mock (default): creates a demo deployment record,
     returns a demo://deployment/... URL, clearly labeled as demo mode -
     no real hosting occurs
  -> DEPLOY_PROVIDER=<real adapter>: would call the configured provider
     (e.g. Vercel) using VERCEL_TOKEN / VERCEL_TEAM_ID - not enabled by
     default, requires adding a production provider adapter
  -> deployment status persisted, retrievable via
     GET /api/projects/:projectId/deployments and
     GET /api/projects/deployments/:deploymentId/status
```

### Memory (Verified Fix) Flow

```text
Fix Agent resolves a finding AND Review Agent confirms it's actually
resolved (not just attempted)
  -> verifiedFixMemory.js stores a flat record on the VerifiedFix model:
     { pattern, context, fixApplied, verified: true }
  -> before future generation/fix attempts on a similar pattern, keyword
     retrieval (GET /api/projects/memory/verified-fixes) surfaces past
     verified fixes as "known pitfalls to avoid" context
  -> retrieval is keyword-based in the current implementation, not vector/
     embedding-based
```

## Generation

```text
approved blueprint
  -> dependency-aware generation batches
  -> generated React/Vite files
  -> MongoDB file storage on Project.generatedFiles
  -> generated file validation and path/package safety checks
```

Generation services:

```text
server/services/generation/generationBatches.js
server/services/generation/topologicalSort.js
server/services/generation/codeGenerationService.js
server/services/generation/generatedFileValidation.js
server/services/generation/packageSafety.js
server/services/generation/pathSafety.js
server/services/ai/prompts/codeGenerationPrompt.js
```

### Generated Project Restrictions

Generated projects must remain frontend-only.

**Allowed:** React + Vite, JavaScript, Tailwind CSS, React Router, Redux Toolkit when useful, Lucide React, localStorage, mock data.

**Disallowed:** Express backend, MongoDB/Mongoose/SQL, authentication/JWT/OAuth, Docker, Next.js, server secrets or server routes.

Additional restrictions enforced at generation time:

- `package.json` dependencies are allowlisted.
- Lifecycle install scripts are rejected.
- Unsafe paths such as `../`, `.env`, `node_modules`, and Docker files are rejected.
- Generated file count and file size are limited.

## Quality Review, Fix Loop, Dependency Graph, and Editing

```text
generated files
  -> deterministic static validation
  -> AST dependency graph
  -> structured quality review findings
  -> max-three-attempt fix loop
  -> versioned file changes
  -> natural-language targeted edits
  -> restore previous snapshot
```

Services:

```text
server/services/review/dependencyGraph.js
server/services/review/staticValidation.js
server/services/review/reviewAgent.js
server/services/review/fixAgent.js
server/services/review/versioningService.js
server/services/edit/intentRouter.js
server/services/edit/editTargeting.js
server/services/edit/editAgent.js
```

The AST graph stores relative imports, imported-by relationships, imported symbols, exports, JSX-rendered components, local functions, event handlers, Redux imports, and service imports. It is intentionally lightweight, not a full compiler.

Natural-language edits route into build/edit/explain/unknown intent. File versioning snapshots the project before edit/fix operations; restore currently restores the latest snapshot.

## Explain Mode, Memory, and Deployment

```text
server/models/VerifiedFix.js
server/services/explain/explainAgent.js
server/services/deploy/deploymentService.js
server/services/memory/verifiedFixMemory.js
```

- **Explain Mode** is grounded in the generated files and the AST dependency graph — it reads real files before answering rather than guessing.
- **VerifiedFix memory** is a flat model with keyword-based retrieval (not vector search).
- **Deployment** defaults to a mock/demo provider (`DEPLOY_PROVIDER=mock`); demo URLs use the `demo://deployment/...` scheme and are clearly labeled as demo mode. A real Vercel provider adapter and `VERCEL_TOKEN` are required before enabling production deployment.

## Known Limitations

- UUID provides visitor continuity only, not authentication.
- Deployment is mock/demo unless a real provider adapter is added.
- Verified-fix retrieval is keyword-based, not vector-based.
- Explain Mode is static-analysis grounded; it does not execute UI interactions.
- Restore currently restores only the latest snapshot.
- Generated-project editing handles common cases and targeted transformations, not arbitrary full semantic refactors.

## Verification

```bash
cd server
npm test
npm audit --omit=dev
node -e "import('./app.js').then(() => console.log('server import ok'))"
```