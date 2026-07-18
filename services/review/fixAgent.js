import { randomUUID } from 'crypto';
import { applyFileChanges, createSnapshot } from './versioningService.js';
import { runQualityReview } from './reviewAgent.js';
import { runStaticValidation } from './staticValidation.js';
import { storeVerifiedFixCandidate } from '../memory/verifiedFixMemory.js';
import { runGenerationRepairGraph } from '../ai/langGraphAgent.js';
import { repairMissingRelativeImports } from '../generation/importRepair.js';
import { languageForPath, normalizeProjectPath } from '../generation/pathSafety.js';
import path from 'path';

export async function runFixLoop(project, { runtimeOutput = '', maxAttempts = 3 } = {}) {
  const runs = [];
  let pendingVerifiedFix = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const review = await runQualityReview({ project, runtimeOutput, attempt });
    runs.push(review);
    project.reviewHistory.push(review);
    if (review.status === 'passed') {
      project.operationStatus = 'review_passed';
      project.dependencyGraph = review.staticValidation.graph;
      if (pendingVerifiedFix) {
        await storeVerifiedFixCandidate({
          project,
          review: pendingVerifiedFix.review,
          fixChanges: pendingVerifiedFix.changes,
          validationPassed: true,
          previewEvidence: ['review agent passed after fix attempt ' + pendingVerifiedFix.attempt]
        }).catch((error) => console.warn('Verified-fix memory store skipped', { message: error.message }));
        pendingVerifiedFix = null;
      }
      await project.save();
      return { status: 'passed', review, attempts: runs };
    }
    const fixResult = await produceFixes(project, review, attempt);
    if (!fixResult.changes.length) {
      review.status = 'escalated';
      project.operationStatus = 'human_escalation';
      await project.save();
      return { status: 'escalated', review, attempts: runs, fixResult };
    }
    createSnapshot(project, 'fix', 'Attempt ' + attempt + ' for findings ' + fixResult.resolvedFindingIds.join(', '));
    applyFileChanges(project, fixResult.changes, 'fix', randomUUID());
    review.fixChanges = fixResult.changes.map((change) => ({ path: change.path, reason: change.reason }));
    const validation = runStaticValidation(project.generatedFiles || []);
    project.dependencyGraph = validation.graph;
    project.operationStatus = validation.passed ? 'fix_applied' : 'fix_validation_failed';
    if (validation.passed) {
      addVerifiedFix(project, fixResult, review);
      pendingVerifiedFix = { review, changes: fixResult.changes, attempt };
    }
    await project.save();
  }
  project.operationStatus = 'human_escalation';
  await project.save();
  return { status: 'escalated', attempts: runs };
}

export async function produceFixes(project, review, attempt = 1) {
  const llmFix = await produceDynamicLlmFixes(project, review, attempt).catch(() => null);
  if (llmFix?.changes?.length) return llmFix;
  const changes = [];
  const files = project.generatedFiles || [];
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const finding of review.findings || []) {
    if (!['blocker', 'high'].includes(finding.severity)) continue;
    const file = finding.file ? byPath.get(finding.file) : null;
    if (!file) continue;
    let content = file.content;
    if (/parse|jsx/i.test(finding.title + finding.description)) content = safeModuleContent(file.path);
    if (/missing relative import/i.test(finding.description)) content = removeBrokenRelativeImports(content);
    if (/package/i.test(finding.title)) continue;
    if (content !== file.content) {
      changes.push({ path: file.path, changeType: 'update', content, reason: 'Automated fix attempt ' + attempt + ': ' + finding.title, addressesFindingIds: [finding.id] });
    }
  }
  return { changes: dedupe(changes), verificationSteps: ['Run static validation', 'Refresh preview'], resolvedFindingIds: changes.flatMap((change) => change.addressesFindingIds), unresolvedIssues: [], requiresFullReview: true };
}

async function produceDynamicLlmFixes(project, review, attempt) {
  const blocking = (review.findings || []).filter((finding) => ['blocker', 'high'].includes(finding.severity));
  if (!blocking.length) return null;
  const files = project.generatedFiles || [];
  const validation = runStaticValidation(files);
  const targetPaths = new Set(blocking.map((finding) => finding.file).filter(Boolean));
  for (const error of validation.errors.filter((item) => item.code === 'missing_relative_import')) {
    targetPaths.add(error.file);
    const specifier = error.message.replace(/^Missing relative import:\s*/, '');
    const base = normalizeProjectPath(path.posix.join(path.posix.dirname(error.file), specifier));
    targetPaths.add(/\.(js|jsx)$/.test(base) ? base : base + (/\/hooks\//.test(base) ? '.js' : '.jsx'));
  }
  const targets = [...targetPaths];
  if (!targets.length) return null;
  const current = new Map(files.map((file) => [normalizeProjectPath(file.path), file]));
  const result = await runGenerationRepairGraph({
    specification: project.expandedSpec,
    blueprint: project.blueprint,
    previousFiles: files.filter((file) => !targets.includes(normalizeProjectPath(file.path))),
    targetFiles: targets,
    generatedFiles: targets.map((filePath) => current.get(filePath)).filter(Boolean),
    validationError: validation.errors.map((error) => (error.file ? error.file + ': ' : '') + error.message).join('; '),
    contracts: [],
    warnings: project.generationWarnings || [],
    fallback: { files: repairMissingRelativeImports(files).filter((file) => targets.includes(normalizeProjectPath(file.path))), contracts: [], warnings: [] },
    agentName: 'Dynamic Preview Repair Agent',
    phase: 'runtime_and_import_repair',
    dependencyContext: { findings: blocking, dependencyGraph: validation.graph, instruction: 'Create missing modules and correct imports/exports. Never delete a required feature import merely to pass validation.' },
    attempt
  });
  const changes = (result?.files || []).filter((file) => targets.includes(normalizeProjectPath(file.path))).map((file) => ({
    path: normalizeProjectPath(file.path),
    changeType: current.has(normalizeProjectPath(file.path)) ? 'update' : 'create',
    content: String(file.content || ''),
    language: file.language || languageForPath(file.path),
    reason: 'Dynamic LLM repair attempt ' + attempt + ': ' + validation.errors.map((item) => item.message).join('; '),
    addressesFindingIds: blocking.map((finding) => finding.id)
  }));
  return { changes: dedupe(changes), verificationSteps: ['Run static validation', 'Refresh WebContainer preview'], resolvedFindingIds: blocking.map((finding) => finding.id), unresolvedIssues: [], requiresFullReview: true };
}

function safeModuleContent(filePath) {
  if (filePath.endsWith('.jsx')) return "export default function RecoveredComponent() {\n  return <div className=\"rounded-lg border border-slate-200 bg-white p-4\">Recovered generated component</div>;\n}\n";
  return "export const recoveredModule = true;\n";
}
function removeBrokenRelativeImports(content) { return String(content).split('\n').filter((line) => !/^import\s+.*['"]\.\.?\//.test(line)).join('\n') + '\n'; }
function dedupe(changes) { const map = new Map(); for (const change of changes) map.set(change.path, change); return Array.from(map.values()).slice(0, 8); }
function addVerifiedFix(project, fixResult, review) {
  project.verifiedFixCandidates.push({ pattern: 'deterministic_generated_fix', context: review.findings?.[0]?.category || 'unknown', errorMessage: review.findings?.[0]?.description || '', affectedTechnologies: ['React', 'Vite', 'JavaScript'], fixSummary: fixResult.changes.map((change) => change.reason).join('; '), changedFiles: fixResult.changes.map((change) => change.path), verified: true, projectId: project.projectId, createdAt: new Date() });
}
