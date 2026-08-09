import { randomUUID } from 'crypto';
import { applyFileChanges, createSnapshot, restoreLatestSnapshot } from './versioningService.js';
import { runQualityReview } from './reviewAgent.js';
import { runStaticValidation } from './staticValidation.js';
import { storeVerifiedFixCandidate } from '../memory/verifiedFixMemory.js';
import { runGenerationRepairGraph } from '../ai/langGraphAgent.js';
import { isOpenAiCredentialError } from '../ai/openAiErrors.js';
import { repairMissingRelativeImports } from '../generation/importRepair.js';
import { repairCssImportOrder, repairKnownPackageImports } from '../generation/deterministicRepair.js';
import { buildFocusedRepairContext } from './repairContext.js';
import { languageForPath, normalizeProjectPath } from '../generation/pathSafety.js';
import { toPlainGeneratedFiles } from '../generation/generatedFileObjects.js';
import path from 'path';
import { withProjectCallLog } from '../observability/centralCallLogger.js';
import { httpError } from '../../utils/httpError.js';

export function assertRepairableProject(project) {
  if (!project?.generatedFiles?.length) {
    throw httpError(409, 'Project has no persisted generated files to repair. Generate the project again before running preview repair.');
  }
}

export function applyRepairVerification(project, { buildPassed, previewPassed, changedFiles = [], error = '' }) {
  const normalizedChangedFiles = [...new Set((changedFiles || []).map(normalizeProjectPath))];
  const expected = new Set((project.lastChangedFiles || []).map(normalizeProjectPath));
  const verifiedFiles = normalizedChangedFiles.filter((filePath) => expected.has(filePath));
  const completeChangedSet = expected.size > 0 && verifiedFiles.length === expected.size;
  const verificationPassed = project.operationStatus === 'fix_applied' && buildPassed === true && previewPassed === true && completeChangedSet;
  const failedChanges = verificationPassed ? [] : (project.generatedFiles || [])
    .filter((file) => verifiedFiles.includes(normalizeProjectPath(file.path)))
    .slice(0, 4)
    .map((file) => ({ path: normalizeProjectPath(file.path), content: String(file.content || '').slice(0, 4_000) }));
  const latestReview = project.reviewHistory?.[project.reviewHistory.length - 1];
  const verificationResult = {
    buildPassed: buildPassed === true,
    previewPassed: previewPassed === true,
    changedFiles: verifiedFiles,
    failedChanges,
    error: String(error || '').slice(0, 4_000),
    verifiedAt: new Date()
  };
  if (latestReview) latestReview.verificationResult = verificationResult;
  if (verificationPassed) {
    project.operationStatus = 'repair_verified';
    project.lastSuccessfulPreviewAt = new Date();
    return { status: 'passed', verificationResult, rolledBack: false };
  }
  const snapshot = restoreLatestSnapshot(project);
  project.operationStatus = 'repair_verification_failed';
  return {
    status: 'failed',
    reason: verificationResult.error || 'WebContainer build or preview verification failed.',
    verificationResult,
    rolledBack: Boolean(snapshot)
  };
}

export async function runFixLoop(project, options = {}) {
  assertRepairableProject(project);
  const runtimeOutput = String(options.runtimeOutput || '');
  const runtimeEvidence = options.runtimeEvidence || {};
  const maxAttempts = options.maxAttempts || 2;
  return withProjectCallLog({
    projectId: project.projectId,
    operation: 'project_repair',
    qualityMode: project.qualityMode,
    metadata: { maxAttempts, hasRuntimeEvidence: Boolean(runtimeOutput.trim() || runtimeEvidence?.errorType) }
  }, async (telemetry) => {
    if (runtimeOutput.trim() || runtimeEvidence?.errorType) {
      telemetry.recordEvent('preview_error_detected', { errorType: runtimeEvidence?.errorType || 'runtime_error' }, 'ERROR');
    }
    const result = await runFixLoopInternal(project, { runtimeOutput, runtimeEvidence, maxAttempts }, telemetry);
    const failed = ['no_progress', 'escalated'].includes(result.status);
    telemetry.recordEvent('repair_' + result.status, { attemptCount: result.attempts?.length || 0 }, failed ? 'ERROR' : 'DEFAULT');
    telemetry.recordOutcome(result.status, { attemptCount: result.attempts?.length || 0 }, failed ? 'ERROR' : 'DEFAULT');
    return result;
  });
}

async function runFixLoopInternal(project, { runtimeOutput = '', runtimeEvidence = {}, maxAttempts = 2 } = {}, telemetry) {
  const runs = [];
  const appliedChanges = [];
  const requiresPreviewVerification = Boolean(String(runtimeOutput || '').trim() || runtimeEvidence?.errorType);
  let pendingVerifiedFix = null;
  let previousAttempt = previousFailedRepair(project);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    telemetry.recordEvent('repair_attempt_started', { attempt });
    const review = await runQualityReview({ project, runtimeOutput, runtimeEvidence, attempt });
    runs.push(review);
    project.reviewHistory.push(review);
    if (review.status === 'passed') {
      if (requiresPreviewVerification && !appliedChanges.length) {
        telemetry.recordEvent('repair_no_progress', { attempt, reason: 'preview_failure_unresolved' }, 'ERROR');
        runtimeOutput = [
          runtimeOutput,
          'The original preview failure is still unresolved and no repair has been applied. Do not report success until a meaningful file change passes validation.'
        ].filter(Boolean).join('\n\n');
        if (attempt < maxAttempts) continue;
        project.operationStatus = 'human_escalation';
        await project.save();
        return { status: 'no_progress', reason: 'Preview failure remained unresolved and no validated file changes were applied.', review, attempts: runs, appliedChanges };
      }
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
      return { status: 'passed', review, attempts: runs, appliedChanges };
    }
    const fixResult = await produceFixes(project, review, attempt, previousAttempt);
    const meaningfulChanges = filterMeaningfulChanges(project.generatedFiles || [], fixResult.changes || []);
    if (!meaningfulChanges.length) {
      telemetry.recordEvent('repair_no_progress', { attempt }, 'ERROR');
      runtimeOutput = [runtimeOutput, 'Previous repair attempt made no meaningful file changes. Diagnose a different root cause and do not return identical content.'].filter(Boolean).join('\n');
      if (attempt < maxAttempts) continue;
      review.status = 'escalated';
      project.operationStatus = 'human_escalation';
      await project.save();
      return { status: 'no_progress', reason: 'Repair attempts returned no meaningful file changes.', review, attempts: runs, fixResult, appliedChanges };
    }
    fixResult.changes = meaningfulChanges;
    const proposedFiles = applyChangesInMemory(project.generatedFiles || [], meaningfulChanges);
    const validation = runStaticValidation(proposedFiles);
    review.fixChanges = fixResult.changes.map((change) => ({ path: change.path, reason: change.reason }));
    if (!validation.passed) {
      telemetry.recordEvent('repair_validation_failed', { attempt, errorCount: validation.errors.length }, 'ERROR');
      project.operationStatus = 'fix_validation_failed';
      const validationOutput = validation.errors.map((error) => (error.file ? error.file + ': ' : '') + error.message).join('; ');
      previousAttempt = { changes: meaningfulChanges, validationError: validationOutput };
      runtimeOutput = [
        runtimeOutput,
        'The proposed repair failed static validation:\n' + validationOutput
      ].filter(Boolean).join('\n\n');
      continue;
    }
    createSnapshot(project, 'fix', 'Attempt ' + attempt + ' for findings ' + fixResult.resolvedFindingIds.join(', '));
    applyFileChanges(project, meaningfulChanges, 'fix', randomUUID());
    appliedChanges.push(...meaningfulChanges.map((change) => change.path));
    project.dependencyGraph = validation.graph;
    project.operationStatus = 'fix_applied';
    telemetry.recordEvent('repair_changes_applied', { attempt, changedFileCount: meaningfulChanges.length });
    if (!requiresPreviewVerification) addVerifiedFix(project, fixResult, review);
    pendingVerifiedFix = { review, changes: fixResult.changes, attempt };
    runtimeOutput = '';
    await project.save();
    if (requiresPreviewVerification) {
      return {
        status: 'verification_required',
        reason: 'Static validation passed; the browser preview must now confirm the runtime repair.',
        review,
        attempts: runs,
        fixResult,
        appliedChanges: [...new Set(appliedChanges)]
      };
    }
  }
  // A runtime/build failure is never cleared by an extra review. The only valid
  // success path is an applied patch followed by WebContainer verification.
  if (requiresPreviewVerification) {
    project.operationStatus = 'human_escalation';
    await project.save();
    return {
      status: 'no_progress',
      reason: 'Repair attempts were exhausted without a statically valid patch. The original preview failure remains unresolved.',
      attempts: runs,
      appliedChanges: [...new Set(appliedChanges)]
    };
  }
  const finalReview = await runQualityReview({ project, runtimeOutput, runtimeEvidence, attempt: maxAttempts + 1 });
  runs.push(finalReview);
  project.reviewHistory.push(finalReview);
  if (finalReview.status === 'passed') {
    project.operationStatus = 'review_passed';
    project.dependencyGraph = finalReview.staticValidation.graph;
    if (pendingVerifiedFix) await storeVerifiedFixCandidate({ project, review: pendingVerifiedFix.review, fixChanges: pendingVerifiedFix.changes, validationPassed: true, previewEvidence: ['final review passed after fix attempt ' + pendingVerifiedFix.attempt] }).catch(() => null);
    await project.save();
    return { status: 'passed', review: finalReview, attempts: runs, appliedChanges: [...new Set(appliedChanges)] };
  }
  project.operationStatus = 'human_escalation';
  await project.save();
  return { status: 'escalated', attempts: runs, appliedChanges: [...new Set(appliedChanges)] };
}

function previousFailedRepair(project) {
  const reviews = project.reviewHistory || [];
  for (let index = reviews.length - 1; index >= 0; index -= 1) {
    const verification = reviews[index]?.verificationResult;
    if (verification?.buildPassed === false || verification?.previewPassed === false) {
      return { changes: verification.failedChanges || [], validationError: verification.error || 'Previous WebContainer verification failed.' };
    }
  }
  return null;
}

export async function produceFixes(project, review, attempt = 1, previousAttempt = null) {
  const knownFix = produceKnownPackageFixes(project, review, attempt);
  if (knownFix.changes.length) return knownFix;
  const internalImportFix = produceInternalSourceImportFixes(project, review, attempt);
  if (internalImportFix.changes.length) return internalImportFix;
  const llmFix = await produceDynamicLlmFixes(project, review, attempt, previousAttempt).catch((error) => {
    if (isOpenAiCredentialError(error)) throw error;
    return null;
  });
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

function produceInternalSourceImportFixes(project, review, attempt) {
  const files = toPlainGeneratedFiles(project.generatedFiles || []);
  const repairedFiles = repairMissingRelativeImports(files);
  const current = new Map(files.map((file) => [normalizeProjectPath(file.path), String(file.content || '')]));
  const findingIds = (review.findings || []).filter((finding) => ['blocker', 'high'].includes(finding.severity)).map((finding) => finding.id);
  const changes = repairedFiles
    .filter((file) => current.has(normalizeProjectPath(file.path)) && current.get(normalizeProjectPath(file.path)) !== String(file.content || ''))
    .map((file) => ({
      path: normalizeProjectPath(file.path),
      changeType: 'update',
      content: String(file.content || ''),
      language: file.language || languageForPath(file.path),
      reason: 'Deterministic runtime repair attempt ' + attempt + ': convert an invalid src/ import into a resolvable relative import.',
      addressesFindingIds: findingIds
    }));
  return {
    changes: dedupe(changes),
    verificationSteps: ['Run static validation', 'Refresh WebContainer preview'],
    resolvedFindingIds: findingIds,
    unresolvedIssues: [],
    requiresFullReview: true
  };
}

function produceKnownPackageFixes(project, review, attempt) {
  const files = new Map((project.generatedFiles || []).map((file) => [normalizeProjectPath(file.path), file]));
  const changes = [];
  for (const finding of review.findings || []) {
    if (!['blocker', 'high'].includes(finding.severity) || !finding.file) continue;
    const filePath = normalizeProjectPath(finding.file);
    const file = files.get(filePath);
    if (!file) continue;
    const description = finding.description || '';
    let repaired = file;
    if (/tailwind-merge does not export tailwindMerge/i.test(description)) repaired = repairKnownPackageImports(repaired);
    if (/css|@import|stylesheet/i.test(description + ' ' + filePath)) repaired = repairCssImportOrder(repaired);
    if (String(repaired.content || '') === String(file.content || '')) continue;
    changes.push({
      path: filePath,
      changeType: 'update',
      content: repaired.content,
      language: file.language || languageForPath(filePath),
      reason: 'Deterministic runtime repair attempt ' + attempt + ': repair a known package or stylesheet build failure.',
      addressesFindingIds: [finding.id]
    });
  }
  return {
    changes: dedupe(changes),
    verificationSteps: ['Run static validation', 'Refresh WebContainer preview'],
    resolvedFindingIds: changes.flatMap((change) => change.addressesFindingIds),
    unresolvedIssues: [],
    requiresFullReview: true
  };
}

async function produceDynamicLlmFixes(project, review, attempt, previousAttempt) {
  const blocking = (review.findings || []).filter((finding) => ['blocker', 'high'].includes(finding.severity));
  if (!blocking.length) return null;
  const files = project.generatedFiles || [];
  const validation = runStaticValidation(files);
  const targetPaths = new Set(blocking.map((finding) => finding.file).filter(Boolean));
  for (const target of resolveRuntimeRepairTargets(project, review.runtimeOutput, review.runtimeEvidence)) targetPaths.add(target);
  for (const error of validation.errors.filter((item) => item.code === 'missing_relative_import')) {
    targetPaths.add(error.file);
    const specifier = error.message.replace(/^Missing relative import:\s*/, '');
    const base = normalizeProjectPath(path.posix.join(path.posix.dirname(error.file), specifier));
    targetPaths.add(/\.(js|jsx)$/.test(base) ? base : base + (/\/hooks\//.test(base) ? '.js' : '.jsx'));
  }
  const requestedTargets = [...targetPaths];
  if (!requestedTargets.length) return null;
  const current = new Map(files.map((file) => [normalizeProjectPath(file.path), file]));
  const context = buildFocusedRepairContext({ project, review, targetPaths: requestedTargets, validation, previousAttempt });
  const targets = context.targetPaths;
  if (!targets.length) return null;
  const result = await runGenerationRepairGraph({
    specification: context.specification,
    blueprint: context.blueprint,
    previousFiles: context.supportingFiles,
    targetFiles: context.targetPaths,
    generatedFiles: context.targetFiles,
    validationError: [
      review.runtimeOutput ? 'Runtime error:\n' + review.runtimeOutput : '',
      validation.errors.length ? 'Static validation:\n' + validation.errors.map((error) => (error.file ? error.file + ': ' : '') + error.message).join('; ') : ''
    ].filter(Boolean).join('\n\n'),
    contracts: [],
    warnings: (project.generationWarnings || []).slice(-20),
    fallback: { files: repairMissingRelativeImports(files).filter((file) => targets.includes(normalizeProjectPath(file.path))), contracts: [], warnings: [] },
    agentName: 'Dynamic Preview Repair Agent',
    phase: 'runtime_and_import_repair',
    batchNumber: null,
    dependencyContext: { ...context.dependencyContext, repairContextStats: context.stats },
    attempt
  });
  const changes = (result?.files || []).filter((file) => targets.includes(normalizeProjectPath(file.path))).map((file) => ({
    path: normalizeProjectPath(file.path),
    changeType: current.has(normalizeProjectPath(file.path)) ? 'update' : 'create',
    content: String(file.content || ''),
    language: file.language || languageForPath(file.path),
    reason: 'Dynamic LLM repair attempt ' + attempt + ': ' + [review.runtimeOutput, ...validation.errors.map((item) => item.message)].filter(Boolean).join('; ').slice(0, 1000),
    addressesFindingIds: blocking.map((finding) => finding.id)
  }));
  return { changes: dedupe(changes), verificationSteps: ['Run static validation', 'Refresh WebContainer preview'], resolvedFindingIds: blocking.map((finding) => finding.id), unresolvedIssues: [], requiresFullReview: true };
}

export function resolveRuntimeRepairTargets(project, runtimeOutput = '', runtimeEvidence = {}, maxTargets = 8) {
  const files = toPlainGeneratedFiles(project.generatedFiles || []);
  const paths = files.map((file) => normalizeProjectPath(file.path));
  const pathSet = new Set(paths);
  const graph = project.dependencyGraph && Object.keys(project.dependencyGraph).length
    ? project.dependencyGraph
    : runStaticValidation(files).graph;
  const evidenceText = [runtimeOutput, runtimeEvidence.message, runtimeEvidence.stack, runtimeEvidence.source, ...(runtimeEvidence.serverLogs || [])].filter(Boolean).join('\n');
  const selected = new Set();
  const add = (filePath) => { if (pathSet.has(filePath) && selected.size < maxTargets) selected.add(filePath); };

  const errorLines = evidenceText.split('\n').filter((line) => /error|failed|cannot|unable|resolve|unexpected|warning|@import/i.test(line));
  const scores = paths.map((filePath) => {
    const basename = path.posix.basename(filePath);
    let score = evidenceText.includes(filePath) ? 100 : 0;
    if (basename.length > 3 && evidenceText.includes(basename)) score += 20;
    if (errorLines.some((line) => line.includes(filePath))) score += 300;
    if (basename.length > 3 && errorLines.some((line) => line.includes(basename))) score += 150;
    if (String(runtimeEvidence.source || '').includes(filePath) || String(runtimeEvidence.source || '').includes(basename)) score += 500;
    return { filePath, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
  for (const item of scores) add(item.filePath);
  for (const changed of [...(runtimeEvidence.lastChangedFiles || []), ...(project.lastChangedFiles || [])]) {
    try { add(normalizeProjectPath(changed)); } catch {}
  }

  const symbols = extractRuntimeSymbols(evidenceText);
  for (const file of files) {
    const filePath = normalizeProjectPath(file.path);
    const node = graph[filePath] || {};
    const indexedSymbols = [...(node.exports || []), ...(node.localFunctions || []), ...(node.renders || []), ...Object.values(node.importedSymbols || {}).flat()];
    if (symbols.some((symbol) => indexedSymbols.includes(symbol) || new RegExp('\\b' + escapeRegExp(symbol) + '\\b').test(String(file.content || '')))) add(filePath);
  }

  const route = String(runtimeEvidence.previewPath || '');
  if (route) {
    for (const file of files) {
      if (new RegExp("path\\s*=\\s*['\"]" + escapeRegExp(route) + "['\"]").test(String(file.content || ''))) add(normalizeProjectPath(file.path));
    }
  }

  if (!selected.size) {
    add('src/App.jsx');
    for (const filePath of paths.filter((filePath) => filePath.startsWith('src/pages/') && /\.jsx$/.test(filePath))) add(filePath);
  }

  for (const seed of [...selected]) {
    for (const related of [...(graph[seed]?.imports || []), ...(graph[seed]?.importedBy || [])]) add(related);
  }
  return [...selected];
}

function extractRuntimeSymbols(text) {
  const values = [];
  const patterns = [
    /(?:ReferenceError:\s*)?([A-Za-z_$][\w$]*) is not defined/g,
    /Cannot access ['\"]([A-Za-z_$][\w$]*)['\"]/g,
    /<([A-Z][A-Za-z0-9_$]*)>/g,
    /(?:export|import) named ['\"]?([A-Za-z_$][\w$]*)/g
  ];
  for (const pattern of patterns) for (const match of String(text || '').matchAll(pattern)) values.push(match[1]);
  return [...new Set(values)];
}

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function applyChangesInMemory(files, changes) {
  const map = new Map(toPlainGeneratedFiles(files).map((file) => [file.path, file]));
  for (const change of changes || []) {
    const filePath = normalizeProjectPath(change.path);
    map.set(filePath, { ...(map.get(filePath) || {}), path: filePath, language: change.language || languageForPath(filePath), content: String(change.content || '') });
  }
  return [...map.values()];
}

function filterMeaningfulChanges(files, changes) {
  const current = new Map((files || []).map((file) => [normalizeProjectPath(file.path), String(file.content || '')]));
  return (changes || []).filter((change) => {
    const filePath = normalizeProjectPath(change.path);
    return !current.has(filePath) || current.get(filePath) !== String(change.content || '');
  });
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
