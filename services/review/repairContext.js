import { normalizeProjectPath } from '../generation/pathSafety.js';
import { toPlainGeneratedFiles } from '../generation/generatedFileObjects.js';

export const MAX_REPAIR_CONTEXT_CHARS = 40_000;
const TARGET_CONTENT_BUDGET = 18_000;
const SUPPORT_CONTENT_BUDGET = 4_000;
const PREVIOUS_ATTEMPT_BUDGET = 2_500;

export function buildFocusedRepairContext({ project, review, targetPaths, validation, previousAttempt = null }) {
  const files = toPlainGeneratedFiles(project.generatedFiles || []);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const graph = validation?.graph || project.dependencyGraph || {};
  const requestedTargets = [...new Set((targetPaths || []).map(normalizeProjectPath))].filter((filePath) => byPath.has(filePath));
  const selectedTargets = selectWithinBudget(requestedTargets, byPath, TARGET_CONTENT_BUDGET, 6);
  const selectedSet = new Set(selectedTargets);
  const relatedPaths = [];
  for (const target of selectedTargets) {
    for (const related of [...(graph[target]?.imports || []), ...(graph[target]?.importedBy || [])]) {
      const normalized = normalizeProjectPath(related);
      if (!selectedSet.has(normalized) && byPath.has(normalized) && !relatedPaths.includes(normalized)) relatedPaths.push(normalized);
    }
  }
  if (byPath.has('package.json') && !selectedSet.has('package.json')) relatedPaths.unshift('package.json');
  const supportingFiles = selectSupportFiles(relatedPaths, byPath, SUPPORT_CONTENT_BUDGET);
  const targetFiles = boundedTargetFiles(selectedTargets, byPath, TARGET_CONTENT_BUDGET);
  const relevantPaths = new Set([...selectedTargets, ...supportingFiles.map((file) => file.path)]);
  const packageDependencies = relevantPackageDependencies(byPath.get('package.json'));
  const packageContracts = {
    'tailwind-merge': { validExports: ['twMerge', 'twJoin', 'extendTailwindMerge', 'createTailwindMerge', 'getDefaultConfig', 'mergeConfigs'] },
    'react-router-dom': { rule: 'Use only exports provided by the installed dependency version.' },
    'lucide-react': { rule: 'Use only icon exports provided by the installed dependency version.' },
    '@reduxjs/toolkit': { rule: 'Use documented named exports; do not invent hooks or action exports.' },
    clsx: { validExports: ['default', 'clsx'] }
  };
  const previousRepair = compactPreviousAttempt(previousAttempt);
  const compactBlueprint = {
    routes: (project.blueprint?.routes || []).slice(0, 30),
    fileList: (project.blueprint?.fileList || []).filter((file) => relevantPaths.has(normalizeProjectPath(file.path))).map((file) => ({
      path: file.path,
      responsibility: file.responsibility,
      dependsOn: file.dependsOn || [],
      exports: file.exports || file.expectedExports || []
    }))
  };
  const dependencyContext = {
    runtimeEvidence: compactRuntimeEvidence(review.runtimeEvidence),
    findings: (review.findings || []).filter((finding) => ['blocker', 'high'].includes(finding.severity)).slice(0, 8).map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      category: finding.category,
      file: finding.file,
      description: String(finding.description || '').slice(0, 1_500),
      recommendedChange: String(finding.recommendedChange || '').slice(0, 500)
    })),
    selectedTargets,
    allowedFiles: selectedTargets,
    relatedFiles: supportingFiles.map((file) => file.path),
    dependencyGraph: Object.fromEntries([...relevantPaths].map((filePath) => [filePath, graph[filePath] || {}])),
    packageDependencies,
    packageContracts,
    previousRepair,
    instruction: 'Modify only allowedFiles. Treat target contents as authoritative. Use relatedFiles only as read-only contracts. Diagnose the smallest root-cause fix and never repeat a failed patch.'
  };
  const contextChars = JSON.stringify({ targetFiles, supportingFiles, compactBlueprint, dependencyContext }).length;
  return {
    targetPaths: selectedTargets,
    targetFiles,
    supportingFiles,
    specification: compactSpecification(project.expandedSpec),
    blueprint: compactBlueprint,
    dependencyContext,
    stats: {
      contextChars,
      maxContextChars: MAX_REPAIR_CONTEXT_CHARS,
      targetCount: targetFiles.length,
      supportingFileCount: supportingFiles.length,
      selectedTargets
    }
  };
}

function selectWithinBudget(paths, byPath, budget, maxFiles) {
  const selected = [];
  let used = 0;
  for (const filePath of paths) {
    const size = byPath.get(filePath)?.content.length || 0;
    if (selected.length && used + size > budget) continue;
    selected.push(filePath);
    used += size;
    if (selected.length >= maxFiles) break;
  }
  return selected;
}

function selectSupportFiles(paths, byPath, budget) {
  const selected = [];
  let used = 0;
  for (const filePath of paths) {
    const file = byPath.get(filePath);
    if (!file) continue;
    const remaining = budget - used;
    if (remaining <= 0) break;
    const content = file.content.slice(0, Math.min(remaining, 4_000));
    selected.push({ ...publicFile(file), content, truncated: content.length < file.content.length });
    used += content.length;
  }
  return selected;
}

function publicFile(file) {
  return { path: file.path, language: file.language, content: file.content };
}

function boundedTargetFiles(paths, byPath, budget) {
  let remaining = budget;
  return paths.map((filePath) => {
    const file = byPath.get(filePath);
    const content = file.content.slice(0, Math.max(0, remaining));
    remaining -= content.length;
    return { ...publicFile(file), content, truncated: content.length < file.content.length };
  });
}

function compactRuntimeEvidence(value = {}) {
  return {
    errorType: value.errorType,
    message: String(value.message || '').slice(0, 2_000),
    stack: String(value.stack || '').slice(-3_000),
    source: String(value.source || '').slice(0, 500),
    line: value.line,
    column: value.column,
    previewPath: String(value.previewPath || '').slice(0, 500),
    verificationError: String(value.verificationError || '').slice(-3_000),
    lastChangedFiles: Array.isArray(value.lastChangedFiles) ? value.lastChangedFiles.slice(0, 12) : []
  };
}

function compactPreviousAttempt(previousAttempt) {
  if (!previousAttempt) return null;
  let remaining = PREVIOUS_ATTEMPT_BUDGET;
  return {
    validationError: String(previousAttempt.validationError || '').slice(0, 2_000),
    changes: (previousAttempt.changes || []).slice(0, 4).map((change) => {
      const content = String(change.content || '').slice(0, remaining);
      remaining -= content.length;
      return { path: change.path, content, truncated: content.length < String(change.content || '').length };
    })
  };
}

function relevantPackageDependencies(packageFile) {
  try {
    const value = JSON.parse(packageFile?.content || '{}');
    return { ...(value.dependencies || {}), ...(value.devDependencies || {}) };
  } catch {
    return {};
  }
}

function compactSpecification(specification) {
  if (!specification || typeof specification !== 'object') return {};
  return {
    projectName: specification.projectName,
    summary: specification.summary,
    appType: specification.appType,
    pages: (Array.isArray(specification.pages) ? specification.pages : []).slice(0, 20).map((page) => typeof page === 'string' ? page : { name: page.name, route: page.route, purpose: page.purpose })
  };
}
