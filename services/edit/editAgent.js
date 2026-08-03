import { randomUUID } from 'crypto';
import { resolveEditTargets } from './editTargeting.js';
import { selectSemanticEditTargets } from './intentRouter.js';
import { createSnapshot } from '../review/versioningService.js';
import { restoreLatestSnapshot } from '../review/versioningService.js';
import { applyEditOperationsToFiles, validateEditOperations } from './editOperations.js';
import { runStaticValidation } from '../review/staticValidation.js';
import { runEditGraph } from '../ai/langGraphAgent.js';
import { isOpenAiCredentialError } from '../ai/openAiErrors.js';
import { buildKnownPitfallsPrompt, retrieveVerifiedFixes } from '../memory/verifiedFixMemory.js';
import { validateMinimalEditChanges } from './editChangeValidator.js';
import { withProjectCallLog } from '../observability/centralCallLogger.js';

export async function applyNaturalLanguageEdit(project, message) {
  return withProjectCallLog({
    projectId: project.projectId,
    operation: 'project_edit',
    qualityMode: project.qualityMode,
    metadata: { messageLength: String(message || '').length }
  }, (telemetry) => applyNaturalLanguageEditInternal(project, message, telemetry));
}

async function applyNaturalLanguageEditInternal(project, message, telemetry) {
  const request = buildEditRequest(project.pendingEditClarification, message);
  const refreshed = runStaticValidation(project.generatedFiles || []);
  project.dependencyGraph = refreshed.graph;
  const fallbackTargeting = resolveEditTargets(project, request.effectiveMessage);
  const targeting = await selectSemanticEditTargets(project, request.effectiveMessage, fallbackTargeting);
  telemetry.recordEvent('edit_targets_selected', {
    strategy: targeting.strategy,
    editableTargets: targeting.editableTargets || targeting.targets,
    readOnlyTargets: targeting.readOnlyTargets || [],
    creatableFiles: targeting.creatableFiles || []
  });
  if (targeting.needsClarification) {
    const result = await saveClarification(project, {
      question: targeting.clarificationQuestion || defaultClarificationQuestion(targeting),
      originalRequest: request.originalRequest,
      latestAnswer: request.latestAnswer,
      reason: targeting.clarificationReason || targeting.scope || 'request_unclear',
      targets: targeting.targets
    });
    telemetry.recordOutcome('needs_clarification', { reason: result.reason });
    return result;
  }
  let editResult = { changes: [], warnings: [] };
  let changes = [];
  let validation = null;
  let validationFeedback = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    editResult = await produceEditChanges(project, request.effectiveMessage, targeting, validationFeedback);
    const verifiedUnexpected = (editResult.rejectedChanges || []).filter((change) => canApproveUnexpectedTarget(project, targeting, change.path));
    if (verifiedUnexpected.length) {
      targeting.editableTargets = [...new Set([...(targeting.editableTargets || targeting.targets || []), ...verifiedUnexpected.map((change) => change.path)])].slice(0, 8);
      targeting.targets = [...new Set([...(targeting.targets || []), ...verifiedUnexpected.map((change) => change.path)])].slice(0, 8);
      validationFeedback = 'A related returned file was verified and is now editable. Return the complete patch using only the updated permissions.';
      telemetry.recordEvent('edit_target_permission_expanded', { attempt, files: verifiedUnexpected.map((change) => change.path) });
      continue;
    }
    if (!editResult.changes.length) {
      validationFeedback = 'No permitted file change was returned. Use only editableFiles/creatableFiles and implement the requested behavior.';
      telemetry.recordEvent('edit_no_permitted_changes', { attempt, rejectedFiles: (editResult.rejectedChanges || []).map((change) => change.path) }, 'ERROR');
      if ((editResult.warnings || []).some((warning) => /Edit LLM failed|unavailable/i.test(String(warning)))) break;
      continue;
    }
    try {
      changes = validateEditOperations(project.generatedFiles || [], editResult.changes, targeting.editableTargets || targeting.targets, request.effectiveMessage);
      const minimal = validateMinimalEditChanges(project.generatedFiles || [], changes, request.effectiveMessage);
      if (!minimal.valid) throw new Error(minimal.errors.join('; '));
      const proposedFiles = applyEditOperationsToFiles(project.generatedFiles || [], changes, 'validation-preview');
      validation = runStaticValidation(proposedFiles);
      if (!validation.passed) throw new Error(validation.errors.map((error) => (error.file ? error.file + ': ' : '') + error.message).join('; '));
      break;
    } catch (error) {
      changes = [];
      validationFeedback = 'Previous edit failed validation: ' + String(error.message || error).slice(0, 4_000) + '. Return a smaller corrected patch that preserves existing imports, exports, routes, and behavior.';
      telemetry.recordEvent('edit_validation_failed', { attempt, message: String(error.message || error).slice(0, 500) }, 'ERROR');
    }
  }
  if (!changes.length || !validation?.passed) {
    const result = await saveClarification(project, {
      question: failedEditClarification(targeting),
      originalRequest: request.originalRequest,
      latestAnswer: request.latestAnswer,
      reason: editResult.changes.length ? 'edit_validation_failed' : 'edit_generation_failed',
      targets: targeting.targets
    });
    telemetry.recordOutcome('needs_clarification', { reason: result.reason }, 'ERROR');
    return result;
  }
  createSnapshot(project, 'edit', request.effectiveMessage);
  const operationId = randomUUID();
  project.generatedFiles = applyEditOperationsToFiles(project.generatedFiles || [], changes, operationId);
  project.lastChangedFiles = changes.map((change) => change.path);
  project.lastEditMessage = request.effectiveMessage;
  project.pendingEditClarification = null;
  project.operationStatus = 'validating';
  project.dependencyGraph = validation.graph;
  project.operationStatus = 'edit_verification_pending';
  await project.save();
  const result = { status: project.operationStatus, changes, targets: targeting.targets, warnings: editResult.warnings, validation };
  telemetry.recordOutcome('applied', { changedFiles: changes.map((change) => change.path), validationPassed: true });
  return result;
}

export function applyEditVerification(project, { buildPassed, previewPassed, changedFiles = [], error = '' }) {
  const expected = new Set((project.lastChangedFiles || []).map(String));
  const received = new Set((changedFiles || []).map(String));
  const complete = expected.size > 0 && [...expected].every((filePath) => received.has(filePath));
  const passed = project.operationStatus === 'edit_verification_pending' && buildPassed === true && previewPassed === true && complete;
  const verification = {
    buildPassed: buildPassed === true,
    previewPassed: previewPassed === true,
    changedFiles: [...received].filter((filePath) => expected.has(filePath)),
    error: String(error || '').slice(0, 4_000),
    verifiedAt: new Date()
  };
  if (passed) {
    project.operationStatus = 'preview_ready';
    project.lastSuccessfulPreviewAt = new Date();
    return { status: 'passed', verification, rolledBack: false };
  }
  const snapshot = restoreLatestSnapshot(project);
  project.operationStatus = 'edit_verification_failed';
  return { status: 'failed', reason: verification.error || 'The edited project failed WebContainer verification.', verification, rolledBack: Boolean(snapshot) };
}

async function produceEditChanges(project, message, targeting, validationFeedback = '') {
  const targets = targeting.targets || [];
  const editableTargets = targeting.editableTargets?.length ? targeting.editableTargets : targets;
  const readOnlyTargets = targeting.readOnlyTargets || targets.filter((target) => !editableTargets.includes(target));
  const targetFiles = (project.generatedFiles || [])
    .filter((file) => targets.includes(file.path))
    .map((file) => ({ path: file.path, language: file.language, access: editableTargets.includes(file.path) ? 'editable' : 'read_only', content: file.content }));
  const boundedFiles = boundEditFiles(targetFiles);
  const fallbackChanges = produceDeterministicEditChanges(project, message, editableTargets);
  const graph = project.dependencyGraph || {};
  const knownPitfalls = await retrieveVerifiedFixes({
    category: 'edit',
    technologies: ['React', 'Vite', 'JavaScript'],
    message,
    file: targets[0]
  });
  const dependencyContext = {
    targetGraph: Object.fromEntries(targets.map((target) => [target, graph[target] || {}])),
    targetSelection: targeting,
    editableFiles: editableTargets,
    readOnlyFiles: readOnlyTargets,
    creatableFiles: targeting.creatableFiles || [],
    requestedRoute: targeting.requestedRoute,
    interactionEvidence: (targeting.interactionEvidence || []).map((item) => ({ path: item.path, score: item.score, evidence: item.evidence, interactions: item.interactions })),
    validationFeedback,
    allowedCreateRoots: ['src/pages/', 'src/components/', 'src/layouts/', 'src/hooks/', 'src/utils/', 'src/data/'],
    knownPitfalls: buildKnownPitfallsPrompt(knownPitfalls)
  };
  const result = await runEditGraph({
    project: focusedEditProjectSummary(project, targets),
    message,
    targetFiles: boundedFiles,
    dependencyContext,
    fallback: { changes: fallbackChanges, warnings: ['Edit LLM is unavailable; deterministic fallback was used.'] }
  }).catch((error) => {
    if (isOpenAiCredentialError(error)) throw error;
    return { changes: fallbackChanges, warnings: ['Edit LLM failed: ' + error.message] };
  });
  const allowedTargets = new Set(editableTargets);
  const creatableFiles = new Set(targeting.creatableFiles || []);
  const rejectedChanges = (result.changes || []).filter((change) => {
    const operation = change.operation || change.changeType || 'update';
    return operation === 'create' ? !creatableFiles.has(change.path) : !allowedTargets.has(change.path);
  });
  const changes = (result.changes || [])
    .filter((change) => {
      const operation = change.operation || change.changeType || 'update';
      return operation === 'create' ? creatableFiles.has(change.path) : allowedTargets.has(change.path);
    })
    .map((change) => ({ ...change, operation: change.operation || change.changeType || 'update', reason: change.reason || 'Applied requested edit: ' + message, addressesFindingIds: [] }))
    .slice(0, 8);
  return { changes, rejectedChanges, warnings: result.warnings || [] };
}

function boundEditFiles(files, budget = 26_000) {
  let remaining = budget;
  return files.map((file) => {
    const content = String(file.content || '').slice(0, Math.max(0, remaining));
    remaining -= content.length;
    return { ...file, content, truncated: content.length < String(file.content || '').length };
  });
}

function focusedEditProjectSummary(project, targets) {
  const relevant = new Set(targets || []);
  return {
    name: project.name,
    summary: project.expandedSpec?.projectSummary,
    routes: (project.blueprint?.routes || []).filter((route) => relevant.has('src/App.jsx') || relevant.has('src/pages/' + route.component + '.jsx')).slice(0, 30),
    files: (project.blueprint?.fileList || []).filter((file) => relevant.has(file.path)).map((file) => ({ path: file.path, responsibility: file.responsibility, exports: file.exports || file.expectedExports || [] }))
  };
}

function canApproveUnexpectedTarget(project, targeting, filePath) {
  if (!(project.generatedFiles || []).some((file) => file.path === filePath)) return false;
  if ((targeting.readOnlyTargets || []).includes(filePath)) return false;
  if ((targeting.interactionEvidence || []).some((item) => item.path === filePath && item.score >= 8)) return true;
  const editable = new Set(targeting.editableTargets || targeting.targets || []);
  const graph = project.dependencyGraph || {};
  return [...editable].some((seed) => [...(graph[seed]?.imports || []), ...(graph[seed]?.importedBy || [])].includes(filePath));
}

function produceDeterministicEditChanges(project, message, targets) {
  const text = String(message || '').toLowerCase();
  const changes = [];
  for (const file of project.generatedFiles || []) {
    if (!targets.includes(file.path)) continue;
    let content = file.content;
    if (/dark/.test(text)) content = makeDarker(content);
    if (/button text|navbar button|button/.test(text)) content = replaceButtonText(content, message);
    if (/pricing.*three|three.*pricing|pricing card/.test(text)) content = addPricingCards(content);
    if (/compact|summary|card/.test(text)) content = compactCards(content);
    if (/progress|completed/.test(text)) content = addProgressBar(content);
    if (/mobile menu.*work|menu.*work/.test(text)) content = content.replace('<Menu className="text-slate-400 md:hidden" size={22} />', '<button className="rounded-md p-2 text-slate-500 md:hidden" aria-label="Open menu"><Menu size={22} /></button>');
    if (/save|persist|refresh|localstorage/.test(text)) content = addLocalStorageHint(content);
    if (content !== file.content) changes.push({ path: file.path, changeType: 'update', content, reason: 'Applied requested edit: ' + message, addressesFindingIds: [] });
  }
  return changes.slice(0, 8);
}

function makeDarker(content) { return String(content).replace(/bg-slate-950/g, 'bg-black').replace(/bg-slate-100/g, 'bg-slate-950').replace(/text-slate-950/g, 'text-slate-50').replace(/bg-white/g, 'bg-slate-900').replace(/border-slate-200/g, 'border-slate-800').replace(/text-slate-500/g, 'text-slate-400'); }
function replaceButtonText(content, message) { const match = String(message).match(/(?:text|to)\s+["']([^"']+)["']/i); const label = match?.[1] || 'Get Started'; return String(content).replace(/>(Submit|Save|Start|Get Started|Return home)</g, '>' + label + '<'); }
function addPricingCards(content) {
  if (content.includes('pricingPlans')) return content;
  const data = "\nconst pricingPlans = ['Starter', 'Growth', 'Scale'];\n";
  const cards = "\n      <section className=\"grid gap-4 md:grid-cols-3\">\n        {pricingPlans.map((plan) => (\n          <article key={plan} className=\"rounded-xl border border-slate-200 bg-white p-5 shadow-sm\">\n            <h3 className=\"text-lg font-semibold\">{plan}</h3>\n            <p className=\"mt-2 text-3xl font-bold\">$49</p>\n            <p className=\"mt-2 text-sm text-slate-500\">Plan for growing frontend teams.</p>\n          </article>\n        ))}\n      </section>";
  return data + String(content).replace('</div>\n  );', cards + '\n    </div>\n  );');
}
function compactCards(content) { return String(content).replace(/p-5/g, 'p-4').replace(/text-3xl/g, 'text-2xl').replace(/mt-3/g, 'mt-2'); }
function addProgressBar(content) {
  if (content.includes('completed-task-progress')) return content;
  const progress = "\n      <section className=\"completed-task-progress rounded-xl border border-slate-200 bg-white p-4 shadow-sm\">\n        <div className=\"flex items-center justify-between text-sm font-medium\"><span>Completed tasks</span><span>68%</span></div>\n        <div className=\"mt-3 h-2 overflow-hidden rounded-full bg-slate-200\"><div className=\"h-full w-[68%] rounded-full bg-emerald-500\" /></div>\n      </section>";
  return String(content).replace('</div>\n  );', progress + '\n    </div>\n  );');
}
function addLocalStorageHint(content) { if (content.includes('localStorage')) return content; return String(content).replace('export default function', "const storageKey = 'generated-app-state';\nfunction saveState(value) { localStorage.setItem(storageKey, JSON.stringify(value)); }\n\nexport default function"); }

function buildEditRequest(pending, latestMessage) {
  const answer = String(latestMessage || '').trim();
  const originalRequest = String(pending?.originalRequest || answer).trim();
  if (!pending?.originalRequest) return { originalRequest, latestAnswer: '', effectiveMessage: answer };
  return {
    originalRequest,
    latestAnswer: answer,
    effectiveMessage: [
      'Original edit request: ' + originalRequest,
      pending.question ? 'Previous clarification question: ' + String(pending.question) : '',
      'User clarification answer: ' + answer
    ].filter(Boolean).join('\n')
  };
}

function defaultClarificationQuestion(targeting) {
  if (targeting.scope === 'missing_target') return 'That page or component does not exist in this project. Should I create it, or would you like to change an existing page instead?';
  return 'Please tell me which page or component to change and what result you want, such as its styling, layout, content, or mobile behavior.';
}

function failedEditClarification(targeting) {
  const selected = (targeting.targets || []).slice(0, 3).join(', ');
  return selected
    ? 'I could not safely apply that edit. Please narrow the request by telling me what should change in ' + selected + ', such as the layout, styling, content, or mobile behavior.'
    : 'I could not safely apply that edit. Please tell me which page or component to change and describe the specific result you want.';
}

async function saveClarification(project, { question, originalRequest, latestAnswer = '', reason, targets = [] }) {
  project.operationStatus = 'needs_clarification';
  project.pendingEditClarification = {
    originalRequest,
    latestAnswer,
    question,
    reason,
    targets,
    createdAt: new Date().toISOString()
  };
  await project.save();
  return { status: 'needs_clarification', clarification: question, reason, targets, warnings: [] };
}
