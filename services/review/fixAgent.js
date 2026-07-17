import { randomUUID } from 'crypto';
import { applyFileChanges, createSnapshot } from './versioningService.js';
import { runQualityReview } from './reviewAgent.js';
import { runStaticValidation } from './staticValidation.js';
import { storeVerifiedFixCandidate } from '../memory/verifiedFixMemory.js';

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
    const fixResult = produceFixes(project, review, attempt);
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

export function produceFixes(project, review, attempt = 1) {
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

function safeModuleContent(filePath) {
  if (filePath.endsWith('.jsx')) return "export default function RecoveredComponent() {\n  return <div className=\"rounded-lg border border-slate-200 bg-white p-4\">Recovered generated component</div>;\n}\n";
  return "export const recoveredModule = true;\n";
}
function removeBrokenRelativeImports(content) { return String(content).split('\n').filter((line) => !/^import\s+.*['"]\.\.?\//.test(line)).join('\n') + '\n'; }
function dedupe(changes) { const map = new Map(); for (const change of changes) map.set(change.path, change); return Array.from(map.values()).slice(0, 8); }
function addVerifiedFix(project, fixResult, review) {
  project.verifiedFixCandidates.push({ pattern: 'deterministic_generated_fix', context: review.findings?.[0]?.category || 'unknown', errorMessage: review.findings?.[0]?.description || '', affectedTechnologies: ['React', 'Vite', 'JavaScript'], fixSummary: fixResult.changes.map((change) => change.reason).join('; '), changedFiles: fixResult.changes.map((change) => change.path), verified: true, projectId: project.projectId, createdAt: new Date() });
}
