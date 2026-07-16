import { randomUUID } from 'crypto';
import { runStaticValidation } from './staticValidation.js';

export async function runQualityReview({ project, runtimeOutput = '', attempt = 1, changedFiles = null }) {
  const staticValidation = runStaticValidation(project.generatedFiles || []);
  const findings = [];
  let id = 1;
  for (const error of staticValidation.errors) findings.push(toFinding(id++, 'blocker', 'build', error));
  for (const warning of staticValidation.warnings) findings.push(toFinding(id++, warning.code === 'circular_import' ? 'medium' : 'low', 'maintainability', warning));
  if (/error|failed|exception/i.test(runtimeOutput || '')) {
    findings.push({
      id: formatId(id++), severity: 'high', category: 'runtime', title: 'Runtime output contains an error',
      description: trim(runtimeOutput), file: null, relatedFiles: changedFiles || [], rootCause: 'WebContainer or build output reported a runtime failure.',
      recommendedChange: 'Inspect the reported stack trace and update the smallest affected file set.', verification: ['Restart preview and confirm the error no longer appears.']
    });
  }
  const summary = summarize(findings);
  const status = summary.blocker === 0 && summary.high === 0 ? 'passed' : 'failed';
  return {
    reviewId: randomUUID(), attempt, status, summary, findings,
    filesNeedingChanges: [...new Set(findings.flatMap((finding) => [finding.file, ...(finding.relatedFiles || [])]).filter(Boolean))],
    verificationCommands: ['npm run build'], staticValidation, runtimeOutput, createdAt: new Date()
  };
}

function toFinding(index, severity, category, issue) {
  return {
    id: formatId(index), severity, category, title: humanTitle(issue.code), description: issue.message,
    file: issue.file || null, relatedFiles: [], rootCause: issue.message,
    recommendedChange: recommended(issue.code), verification: ['Run static validation again.', 'Refresh WebContainer preview.']
  };
}
function formatId(index) { return 'REV-' + String(index).padStart(3, '0'); }
function summarize(findings) { return findings.reduce((acc, finding) => { acc[finding.severity] += 1; return acc; }, { blocker: 0, high: 0, medium: 0, low: 0 }); }
function humanTitle(code) { return String(code || 'issue').replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function recommended(code) {
  if (code === 'missing_relative_import') return 'Add the missing file or correct the import path.';
  if (code === 'parse_error' || code === 'jsx_parse_error') return 'Fix JavaScript or JSX syntax in the reported file.';
  if (code === 'invalid_package_json') return 'Use only allowed frontend dependencies and safe scripts.';
  return 'Update the smallest affected generated file set.';
}
function trim(value) { return String(value || '').slice(0, 2000); }
