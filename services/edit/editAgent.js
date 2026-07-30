import { randomUUID } from 'crypto';
import { resolveEditTargets } from './editTargeting.js';
import { selectSemanticEditTargets } from './intentRouter.js';
import { createSnapshot } from '../review/versioningService.js';
import { applyEditOperationsToFiles, validateEditOperations } from './editOperations.js';
import { runStaticValidation } from '../review/staticValidation.js';
import { runFixLoop } from '../review/fixAgent.js';
import { runEditGraph } from '../ai/langGraphAgent.js';
import { isOpenAiCredentialError } from '../ai/openAiErrors.js';
import { buildKnownPitfallsPrompt, retrieveVerifiedFixes } from '../memory/verifiedFixMemory.js';

export async function applyNaturalLanguageEdit(project, message) {
  const refreshed = runStaticValidation(project.generatedFiles || []);
  project.dependencyGraph = refreshed.graph;
  const fallbackTargeting = resolveEditTargets(project, message);
  const targeting = await selectSemanticEditTargets(project, message, fallbackTargeting);
  if (targeting.needsClarification) return saveClarification(project, 'Which file or section should I update?', targeting.targets);
  const editResult = await produceEditChanges(project, message, targeting);
  if (!editResult.changes.length) {
    const detail = editResult.warnings.length ? ' ' + editResult.warnings.join(' ') : '';
    return saveClarification(project, 'Edit was not applied because no valid file changes were produced.' + detail, targeting.targets, editResult.warnings);
  }
  let changes;
  try {
    changes = validateEditOperations(project.generatedFiles || [], editResult.changes, targeting.targets, message);
  } catch (error) {
    return saveClarification(project, 'Edit was not applied: ' + error.message, targeting.targets, [error.message]);
  }
  createSnapshot(project, 'edit', message);
  const operationId = randomUUID();
  project.generatedFiles = applyEditOperationsToFiles(project.generatedFiles || [], changes, operationId);
  project.lastChangedFiles = changes.map((change) => change.path);
  project.lastEditMessage = message;
  project.operationStatus = 'validating';
  const validation = runStaticValidation(project.generatedFiles || []);
  project.dependencyGraph = validation.graph;
  if (!validation.passed) await runFixLoop(project, { maxAttempts: 2 });
  else project.operationStatus = 'preview_ready';
  await project.save();
  return { status: project.operationStatus, changes, targets: targeting.targets, warnings: editResult.warnings, validation };
}

async function produceEditChanges(project, message, targeting) {
  const targets = targeting.targets;
  const targetFiles = (project.generatedFiles || [])
    .filter((file) => targets.includes(file.path))
    .map((file) => ({ path: file.path, language: file.language, content: file.content }));
  const fallbackChanges = produceDeterministicEditChanges(project, message, targets);
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
    allowedCreateRoots: ['src/pages/', 'src/components/', 'src/layouts/', 'src/hooks/', 'src/utils/', 'src/data/'],
    knownPitfalls: buildKnownPitfallsPrompt(knownPitfalls)
  };
  const result = await runEditGraph({
    project: { name: project.name, expandedSpec: project.expandedSpec, blueprint: project.blueprint },
    message,
    targetFiles,
    dependencyContext,
    fallback: { changes: fallbackChanges, warnings: ['Edit LLM is unavailable; deterministic fallback was used.'] }
  }).catch((error) => {
    if (isOpenAiCredentialError(error)) throw error;
    return { changes: fallbackChanges, warnings: ['Edit LLM failed: ' + error.message] };
  });
  const allowedTargets = new Set(targets);
  const changes = (result.changes || [])
    .filter((change) => change.operation === 'create' || change.changeType === 'create' || allowedTargets.has(change.path))
    .map((change) => ({ ...change, operation: change.operation || change.changeType || 'update', reason: change.reason || 'Applied requested edit: ' + message, addressesFindingIds: [] }))
    .slice(0, 8);
  return { changes, warnings: result.warnings || [] };
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

async function saveClarification(project, clarification, targets = [], warnings = []) {
  project.operationStatus = 'needs_clarification';
  await project.save();
  return { status: 'needs_clarification', clarification, targets, warnings };
}
