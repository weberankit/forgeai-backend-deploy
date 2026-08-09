import { runCodeGenerationGraph, runGenerationRepairGraph } from '../ai/langGraphAgent.js';
import { buildAgentExecutionStages, buildGenerationBatches } from './generationBatches.js';
import { languageForPath, normalizeProjectPath } from './pathSafety.js';
import { mergeFiles, validateGeneratedFiles, validateGenerationBatch } from './generatedFileValidation.js';
import { runSmokeRenderTests } from '../review/testingAgent.js';
import { runFixLoop } from '../review/fixAgent.js';
import { runStaticValidation } from '../review/staticValidation.js';
import { repairMissingRelativeImports } from './importRepair.js';
import { buildKnownPitfallsPrompt, retrieveVerifiedFixes } from '../memory/verifiedFixMemory.js';
import { runDeterministicRepairs } from './deterministicRepair.js';
import { assertDisjointWriteSets, assertOwnedBatchFiles, buildProjectManifest, manifestForBatch } from './projectManifest.js';
import { withProjectCallLog } from '../observability/centralCallLogger.js';
import { managedDependencyVersions } from './packageSafety.js';
import { normalizeGenerationWarnings } from '../../utils/generationWarnings.js';

export function getGenerationPlan(blueprint) {
  return buildGenerationBatches(blueprint);
}

export function selectActiveGenerationBatches(batches, { selectedFiles = [], failedBatch = 0 } = {}) {
  if (Array.isArray(selectedFiles) && selectedFiles.length) {
    const selectedSet = new Set(selectedFiles.map(normalizeProjectPath));
    return batches
      .map((batch) => ({ ...batch, files: batch.files.filter((filePath) => selectedSet.has(filePath)) }))
      .filter((batch) => batch.files.length);
  }
  const retryFromBatch = Number(failedBatch || 0);
  if (Number.isInteger(retryFromBatch) && retryFromBatch > 0) {
    return batches.filter((batch) => batch.batchNumber >= retryFromBatch);
  }
  return batches;
}

export async function generateProjectFiles(project, options = {}) {
  const plannedBatches = buildGenerationBatches(project.blueprint || {});
  return withProjectCallLog({
    projectId: project.projectId,
    operation: options.selectedFiles?.length || project.failedBatch ? 'project_regeneration' : 'project_generation',
    qualityMode: project.qualityMode,
    metadata: { batchCount: plannedBatches.length, selectedFileCount: options.selectedFiles?.length || 0 }
  }, async (telemetry) => {
    telemetry.recordEvent('generation_started', { batchCount: plannedBatches.length });
    const result = await generateProjectFilesInternal(project, options, telemetry);
    telemetry.recordEvent('generation_ready', { fileCount: result.generatedFiles?.length || 0 });
    telemetry.recordOutcome('ready_for_preview', { fileCount: result.generatedFiles?.length || 0 });
    return result;
  });
}

async function generateProjectFilesInternal(project, options = {}, telemetry) {
  const batches = buildGenerationBatches(project.blueprint || {});
  const manifest = buildProjectManifest(project.blueprint || {}, batches);
  project.generationManifest = manifest;
  const retryFromBatch = Number(project.failedBatch || 0);
  const contracts = [];
  const warnings = normalizeGenerationWarnings(project.generationWarnings || []);
  let existingFiles = project.generatedFiles || [];
  let lastValidProjectFiles = [...existingFiles];

  project.generationStatus = 'preparing';
  project.currentBatch = 0;
  project.generationProgress = 2;
  project.generationError = '';
  project.generationDiagnostics = [];
  await project.save();

  try {
    const activeBatches = selectActiveGenerationBatches(batches, {
      selectedFiles: options.selectedFiles,
      failedBatch: retryFromBatch
    });

    if (activeBatches.length === 0) throw new Error('No matching files were selected for generation.');

    let completedBatches = 0;
    const stages = buildAgentExecutionStages(activeBatches);
    const parallelism = generationParallelism();
    for (const stage of stages) {
      if (stage.parallel && parallelism > 1) {
        assertDisjointWriteSets(stage.batches);
        const stagePreviousFiles = existingFiles;
        const stageContracts = [...contracts];
        const stageWarnings = [...warnings];
        project.generationStatus = 'generating_batch';
        project.currentBatch = stage.batches[0]?.batchNumber || completedBatches + 1;
        project.generationProgress = Math.max(5, Math.round((completedBatches / activeBatches.length) * 80));
        await project.save();

        const results = await mapWithConcurrency(stage.batches, parallelism, (batch, index) => withBatchTimeout(
          runGenerationBatch({
            project,
            batch,
            batchIndex: completedBatches + index,
            totalBatches: activeBatches.length,
            previousFiles: stagePreviousFiles,
            contracts: stageContracts,
            warnings: stageWarnings,
            manifest,
            skipSave: true
          }),
          Number(process.env.BATCH_TIMEOUT_MS || 300000),
          'parallel batch ' + batch.batchNumber + ' (' + batch.agentName + ')'
        ));

        // Collect all raw generated files from the stage (one entry per batch)

        const repairedStageFiles = [];
        for (const { batch, generated } of results) {
          // Sibling context: all raw generated files from OTHER batches in this stage
          // Use raw (not yet repaired) siblings — deterministic repair will fix them
          const siblingFiles = results
            .filter(({ batch: sibBatch }) => sibBatch.batchNumber !== batch.batchNumber)
            .flatMap(({ generated: sibGenerated }) => normalizeGenerationResult(sibGenerated).files || []);
          const repairContextFiles = mergeFiles(stagePreviousFiles, siblingFiles);
          const repairedGenerated = await repairGenerationBatch({ project, batch, generated, previousFiles: repairContextFiles, contracts, warnings, manifest, telemetry });
          for (const warning of repairedGenerated.warnings || []) warnings.push(warning);
          for (const contract of repairedGenerated.contracts || []) contracts.push(contract);
          repairedStageFiles.push(...(repairedGenerated.files || []));
        }

        const committed = await commitGeneratedFiles({
          project,
          newFiles: repairedStageFiles,
          previousFiles: existingFiles,
          warnings,
          completedBatches: completedBatches + stage.batches.length,
          totalBatches: activeBatches.length,
          manifest
        });
        existingFiles = committed.files;
        lastValidProjectFiles = [...committed.files];
        project.lastValidProjectFiles = lastValidProjectFiles;
        completedBatches += stage.batches.length;
        project.currentBatch = stage.batches.at(-1)?.batchNumber || project.currentBatch;
        await project.save();
        recordGenerationDiagnostic(project, {
          type: 'checkpoint_committed',
          stage: stage.phase,
          batches: stage.batches.map((batch) => batch.batchNumber),
          fileCount: committed.files.length
        });
        await options.onFiles?.(committed.changedFiles, project);
      } else {
        for (const batch of stage.batches) {
          const batchTimeoutMs = Number(process.env.BATCH_TIMEOUT_MS || 300000); // 5 minutes per batch default
          const batchLabel = 'batch ' + batch.batchNumber + ' (' + batch.agentName + ')';
          const generated = await withBatchTimeout(
            runGenerationBatch({
              project,
              batch,
              batchIndex: completedBatches,
              totalBatches: activeBatches.length,
              previousFiles: existingFiles,
              contracts,
              warnings,
              manifest
            }),
            batchTimeoutMs,
            batchLabel
          );
          const repairedGenerated = await withBatchTimeout(
            repairGenerationBatch({ project, batch, generated, previousFiles: existingFiles, contracts, warnings, manifest, telemetry }),
            batchTimeoutMs,
            batchLabel + ' repair'
          );
          for (const warning of repairedGenerated.warnings || []) warnings.push(warning);
          for (const contract of repairedGenerated.contracts || []) contracts.push(contract);
          const committed = await commitGeneratedFiles({
            project,
            newFiles: repairedGenerated.files,
            previousFiles: existingFiles,
            warnings,
            completedBatches: completedBatches + 1,
            totalBatches: activeBatches.length,
            manifest
          });
          existingFiles = committed.files;
          lastValidProjectFiles = [...committed.files];
          project.lastValidProjectFiles = lastValidProjectFiles;
          completedBatches += 1;
          recordGenerationDiagnostic(project, {
            type: 'checkpoint_committed',
            stage: stage.phase,
            batches: [batch.batchNumber],
            fileCount: committed.files.length
          });
          await project.save();
          await options.onFiles?.(committed.changedFiles, project);
        }
      }
    }

    telemetry.recordEvent('validation_started', { generatedFileCount: project.generatedFiles?.length || 0 });
    project.generationStatus = 'validating';
    project.generationProgress = 90;
    await project.save();
    project.generatedFiles = repairProjectFiles(project.generatedFiles || [], manifest, warnings);
    validateGeneratedFiles(project.generatedFiles || [], [], manifest);
    project.dependencyGraph = runStaticValidation(project.generatedFiles || []).graph;
    let smokeRenderTest = runSmokeRenderTests(project.generatedFiles || []);
    if (!smokeRenderTest.passed) {
      telemetry.recordEvent('smoke_render_failed', { errorCount: smokeRenderTest.errors.length }, 'ERROR');
      await runFixLoop(project, {
        runtimeOutput: 'Smoke/render test failed: ' + smokeRenderTest.errors.map((error) => (error.file ? error.file + ': ' : '') + error.message).join('; '),
        maxAttempts: 2
      });

      // LLM repair output can regress manifest contracts (for example by
      // replacing a page's default export with a named export). Re-apply the
      // deterministic project contract before judging the final smoke result.
      project.generatedFiles = repairProjectFiles(project.generatedFiles || [], manifest, warnings);
      validateGeneratedFiles(project.generatedFiles || [], [], manifest);
      project.dependencyGraph = runStaticValidation(project.generatedFiles || []).graph;
      smokeRenderTest = runSmokeRenderTests(project.generatedFiles || []);

      // Judge the repaired files themselves instead of the fix-loop status.
      // A fix loop may escalate even though deterministic contract repair has
      // produced a valid project.
      if (!smokeRenderTest.passed) {
        if (!isSmokeTestBlockingFailure(smokeRenderTest)) {
          warnings.push('Smoke/render test has minor issues that were not fully repaired: ' + smokeRenderTest.errors.map((error) => (error.file ? error.file + ': ' : '') + error.message).join('; '));
        } else {
          throw new Error('Smoke/render test failed after fix attempts: ' + smokeRenderTest.errors.map((error) => (error.file ? error.file + ': ' : '') + error.message).join('; '));
        }
      }
    }

    project.generationStatus = 'storing';
    project.generationProgress = 96;
    await project.save();

    project.generationStatus = 'ready_for_preview';
    project.generationProgress = 100;
    project.failedBatch = null;
    project.generationError = '';
    await project.save();
    return project;
  } catch (error) {
    telemetry.recordEvent('generation_failed', { errorType: error?.name || 'Error', batchNumber: project.currentBatch || 0 }, 'ERROR');
    project.generatedFiles = lastValidProjectFiles;
    project.lastValidProjectFiles = lastValidProjectFiles;
    project.dependencyGraph = runStaticValidation(lastValidProjectFiles).graph;
    project.generationStatus = 'failed';
    project.failedBatch = project.currentBatch || null;
    project.generationError = error.message;
    recordGenerationDiagnostic(project, {
      type: 'generation_failed',
      batchNumber: project.currentBatch || 0,
      error: error.message
    });
    project.generationWarnings = normalizeGenerationWarnings([...warnings, error.message]);
    await project.save();
    throw error;
  }
}

export async function repairGenerationBatch({ project, batch, generated, previousFiles, contracts, warnings, manifest = null, maxAttempts = 3, telemetry = null }) {
  const fallback = mockGenerateBatch({ project, targetFiles: batch.files, batch });
  let candidate = normalizeGenerationResult(generated);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const deterministic = runDeterministicRepairs(previousFiles, candidate.files, manifest);
    candidate.files = deterministic.files;
    const previousPaths = new Set((previousFiles || []).map((file) => normalizeProjectPath(file.path)));
    const candidatePaths = new Set(candidate.files.map((file) => normalizeProjectPath(file.path)));
    const importRepaired = repairMissingRelativeImports(mergeFiles(previousFiles || [], candidate.files));
    candidate.files = importRepaired.filter((file) => candidatePaths.has(normalizeProjectPath(file.path)) || !previousPaths.has(normalizeProjectPath(file.path)));
    const postImportDeterministic = runDeterministicRepairs(previousFiles, candidate.files, manifest);
    candidate.files = postImportDeterministic.files;
    const repairWarnings = [...deterministic.repairs, ...postImportDeterministic.repairs];
    if (repairWarnings.length) candidate.warnings = [...(candidate.warnings || []), ...repairWarnings.map((item) => 'Deterministic repair: ' + item.file + ' - ' + item.action)];
    try {
      validateGenerationBatch(candidate.files, batch.files, previousFiles, manifest);
      validateBatchGraph(candidate.files, previousFiles);
      validateBatchSmoke(candidate.files, previousFiles);
      if (attempt > 1) {
        candidate.warnings = [
          ...(candidate.warnings || []),
          'Generation Repair Agent fixed batch ' + batch.batchNumber + ' after validation error: ' + lastError
        ];
      }
      return candidate;
    } catch (error) {
      lastError = error.message;
      const diagnostic = {
        type: 'batch_validation_failed',
        batchNumber: batch.batchNumber,
        phase: batch.phase,
        agentName: batch.agentName,
        attempt,
        error: error.message
      };
      recordGenerationDiagnostic(project, diagnostic);
      telemetry?.recordEvent?.('batch_validation_failed', diagnostic, 'ERROR');
      if (attempt === maxAttempts) {
        const deterministicFallback = runDeterministicRepairs(previousFiles, fallback.files || [], manifest);
        const safeFallback = normalizeGenerationResult({
          ...fallback,
          files: deterministicFallback.files,
          warnings: [
            ...(fallback.warnings || []),
            'Batch ' + batch.batchNumber + ' used the safe runnable fallback after ' + maxAttempts + ' repair attempts: ' + lastError
          ]
        });
        validateGenerationBatch(safeFallback.files, batch.files, previousFiles, manifest);
        validateBatchGraph(safeFallback.files, previousFiles);
        validateBatchSmoke(safeFallback.files, previousFiles);
        telemetry?.recordEvent?.('batch_safe_fallback_used', {
          batchNumber: batch.batchNumber,
          phase: batch.phase,
          attempts: maxAttempts
        }, 'WARNING');
        return safeFallback;
      }
      const repairFallback = buildRepairFallback({ fallback, candidate, batch });
      const repair = await runGenerationRepairGraph({
        specification: project.expandedSpec,
        blueprint: project.blueprint,
        previousFiles,
        targetFiles: batch.files,
        generatedFiles: candidate.files,
        validationError: error.message,
        contracts,
        warnings,
        fallback: repairFallback,
        agentName: batch.agentName,
        phase: batch.phase,
        batchNumber: batch.batchNumber,
        dependencyContext: {
          manager: 'Frontend Manager Agent',
          repairOf: batch.agentName,
          phase: batch.phase,
          targetFiles: batch.files,
          attempt
        },
        attempt
      });
      candidate = mergeGenerationRepair(candidate, repair, batch);
    }
  }
  // Should never reach here but be safe
  return fillMissingTargetFiles(candidate, batch, fallback);
}

/**
 * Fill any target files still missing from the candidate with fallback content.
 */
function fillMissingTargetFiles(candidate, batch, fallback) {
  const candidateMap = new Map((candidate.files || []).map((file) => [normalizeProjectPath(file.path), file]));
  const targetSet = new Set((batch.files || []).map(normalizeProjectPath));
  for (const fallbackFile of fallback.files || []) {
    const filePath = normalizeProjectPath(fallbackFile.path);
    if (targetSet.has(filePath) && !candidateMap.has(filePath)) {
      candidateMap.set(filePath, fallbackFile);
    }
  }
  return {
    files: Array.from(candidateMap.values()),
    contracts: candidate.contracts || [],
    warnings: candidate.warnings || []
  };
}

function validateBatchGraph(files, previousFiles) {
  const candidatePaths = new Set((files || []).map((file) => normalizeProjectPath(file.path)));
  const validation = runStaticValidation(mergeFiles(previousFiles || [], files || []));
  const blocking = validation.errors.filter((error) => !error.file || candidatePaths.has(error.file));
  if (blocking.length) {
    throw new Error(blocking.map((error) => (error.file ? error.file + ': ' : '') + error.message).join('; '));
  }
}

function validateBatchSmoke(files, previousFiles) {
  const candidatePaths = new Set((files || []).map((file) => normalizeProjectPath(file.path)));
  const smoke = runSmokeRenderTests(mergeFiles(previousFiles || [], files || []));
  const blocking = smoke.errors.filter((error) => !error.file || candidatePaths.has(error.file));
  if (blocking.length) {
    throw new Error(blocking.map((error) => (error.file ? error.file + ': ' : '') + error.message).join('; '));
  }
}

async function commitGeneratedFiles({ project, newFiles, previousFiles, warnings, completedBatches, totalBatches, manifest }) {
  const deterministic = runDeterministicRepairs(previousFiles || [], newFiles || [], manifest);
  let filesToCommit = deterministic.files || [];
  if (deterministic.repairs.length) {
    warnings.push(...deterministic.repairs.map((item) => 'Deterministic repair: ' + item.file + ' - ' + item.action));
  }

  let proposedFiles = repairMissingRelativeImports(upsertGeneratedFiles(project.generatedFiles || [], filesToCommit));
  const finalDeterministic = runDeterministicRepairs([], proposedFiles, manifest);
  if (finalDeterministic.repairs.length) {
    warnings.push(...finalDeterministic.repairs.map((item) => 'Final deterministic repair: ' + item.file + ' - ' + item.action));
    proposedFiles = repairMissingRelativeImports(finalDeterministic.files || proposedFiles);
  }
  const changedPaths = changedPathSet(project.generatedFiles || [], filesToCommit, proposedFiles);
  for (const repair of finalDeterministic.repairs || []) if (repair.file) changedPaths.add(normalizeProjectPath(repair.file));
  const proposedValidation = runStaticValidation(proposedFiles);
  const blockingErrors = proposedValidation.errors.filter((error) => isBlockingValidationError(error, changedPaths));
  if (blockingErrors.length) throw new Error(blockingErrors.map((error) => (error.file ? error.file + ': ' : '') + error.message).join('; '));

  project.generatedFiles = proposedFiles;
  project.dependencyGraph = proposedValidation.graph;
  project.generationWarnings = normalizeGenerationWarnings(warnings);
  project.generationProgress = Math.max(project.generationProgress || 0, Math.round((completedBatches / totalBatches) * 85));
  await project.save();

  return {
    files: proposedFiles,
    changedFiles: proposedFiles.filter((file) => changedPaths.has(normalizeProjectPath(file.path)))
  };
}

function changedPathSet(beforeFiles, newFiles, afterFiles) {
  const beforePaths = new Set((beforeFiles || []).map((file) => normalizeProjectPath(file.path)));
  const changed = new Set((newFiles || []).map((file) => normalizeProjectPath(file.path)));
  for (const file of afterFiles || []) {
    const filePath = normalizeProjectPath(file.path);
    if (!beforePaths.has(filePath)) changed.add(filePath);
  }
  return changed;
}

function isBlockingValidationError(error, changedPaths) {
  if (!error.file) return true;
  let filePath = error.file;
  try { filePath = normalizeProjectPath(error.file); } catch {}
  if (changedPaths.has(filePath)) return true;
  return [...changedPaths].some((changedPath) => String(error.message || '').includes(changedPath));
}

function repairProjectFiles(files, manifest, warnings) {
  let repaired = repairMissingRelativeImports(files || []);
  const deterministic = runDeterministicRepairs([], repaired, manifest);
  if (deterministic.repairs.length) {
    warnings.push(...deterministic.repairs.map((item) => 'Final deterministic repair: ' + item.file + ' - ' + item.action));
  }
  repaired = repairMissingRelativeImports(deterministic.files || repaired);
  return repaired;
}

/**
 * Returns true if smoke test failures are severe enough to block generation output.
 * Critical entry files (App.jsx, main.jsx) failing always blocks.
 * Otherwise allow up to 30% of tested files to have issues before blocking.
 */
function isSmokeTestBlockingFailure(smokeRenderTest) {
  const criticalFiles = new Set(['src/App.jsx', 'src/main.jsx']);
  const errorFiles = new Set(smokeRenderTest.errors.map((e) => e.file).filter(Boolean));
  // Any critical file failing is always a blocker
  for (const criticalFile of criticalFiles) {
    if (errorFiles.has(criticalFile)) return true;
  }
  // If more than 30% of tested files fail, block
  const testedCount = smokeRenderTest.testedFiles?.length || 1;
  const failedCount = errorFiles.size;
  if (failedCount / testedCount > 0.3) return true;
  return false;
}

/**
 * Runs a promise with an absolute timeout. If the promise does not resolve
 * within timeoutMs, rejects with a timeout error.
 */
function withBatchTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Generation batch timed out after ' + Math.round(timeoutMs / 1000) + 's: ' + label));
    }, timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function generationParallelism() {
  const configured = Number(process.env.GENERATION_PARALLELISM || 1);
  if (!Number.isFinite(configured)) return 1;
  return Math.min(6, Math.max(1, Math.floor(configured)));
}

function recordGenerationDiagnostic(project, diagnostic) {
  if (!project) return;
  const entry = {
    ...diagnostic,
    error: diagnostic?.error ? String(diagnostic.error).slice(0, 1000) : undefined,
    timestamp: new Date().toISOString()
  };
  project.generationDiagnostics = [...(project.generationDiagnostics || []), entry].slice(-100);
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeGenerationResult(result) {
  return {
    files: Array.isArray(result?.files) ? result.files : [],
    contracts: Array.isArray(result?.contracts) ? result.contracts : [],
    warnings: normalizeGenerationWarnings(result?.warnings || [])
  };
}

export function selectOwnedBatchFiles(returnedFiles = [], batch = {}) {
  const assigned = new Set((batch.files || []).map(normalizeProjectPath));
  const accepted = new Map();
  const rejectedPaths = [];

  for (const file of Array.isArray(returnedFiles) ? returnedFiles : []) {
    let filePath;
    try {
      filePath = normalizeProjectPath(file?.path);
    } catch {
      rejectedPaths.push(String(file?.path || '<missing path>'));
      continue;
    }
    if (!assigned.has(filePath)) {
      rejectedPaths.push(filePath);
      continue;
    }
    if (accepted.has(filePath)) rejectedPaths.push(filePath + ' (duplicate)');
    accepted.set(filePath, { ...file, path: filePath });
  }

  return { files: Array.from(accepted.values()), rejectedPaths: [...new Set(rejectedPaths)] };
}

function mergeGenerationRepair(candidate, repair, batch) {
  const normalizedRepair = normalizeGenerationResult(repair);
  const map = new Map((candidate.files || []).map((file) => [normalizeProjectPath(file.path), file]));
  const selectedRepair = selectOwnedBatchFiles(normalizedRepair.files, batch);
  for (const file of selectedRepair.files) map.set(file.path, file);
  return {
    files: Array.from(map.values()),
    contracts: [...(candidate.contracts || []), ...(normalizedRepair.contracts || [])],
    warnings: [
      ...(candidate.warnings || []),
      ...(normalizedRepair.warnings || []),
      ...(selectedRepair.rejectedPaths.length ? ['Ignored invalid or unowned repair files: ' + selectedRepair.rejectedPaths.join(', ')] : [])
    ]
  };
}

function buildRepairFallback({ fallback, candidate, batch }) {
  const targetSet = new Set((batch.files || []).map(normalizeProjectPath));
  const map = new Map((candidate.files || []).map((file) => [normalizeProjectPath(file.path), file]));
  for (const file of fallback.files || []) {
    const filePath = normalizeProjectPath(file.path);
    if (targetSet.has(filePath) && !map.has(filePath)) map.set(filePath, file);
  }
  return {
    files: Array.from(map.values()).filter((file) => targetSet.has(normalizeProjectPath(file.path))),
    contracts: fallback.contracts || [],
    warnings: ['Repair fallback supplied missing target files for offline/mock mode.']
  };
}

async function runGenerationBatch({ project, batch, batchIndex, totalBatches, previousFiles, contracts, warnings, manifest, skipSave = false }) {
  if (!skipSave) {
    project.generationStatus = 'generating_batch';
    project.currentBatch = batch.batchNumber;
    project.generationProgress = Math.max(5, Math.round((batchIndex / totalBatches) * 80));
    await project.save();
  }

  const knownPitfalls = await retrieveVerifiedFixes({
    category: batch.phase || 'code_generation',
    technologies: ['React', 'Vite', 'JavaScript'],
    message: [project.expandedSpec?.projectSummary, batch.agentName, batch.phase, batch.files.join(' ')].filter(Boolean).join(' '),
    file: batch.files[0]
  });
  const fallback = mockGenerateBatch({ project, targetFiles: batch.files, batch });
  const generated = await runCodeGenerationGraph({
    specification: project.expandedSpec,
    blueprint: project.blueprint,
    previousFiles,
    targetFiles: batch.files,
    contracts,
    warnings,
    fallback,
    agentName: batch.agentName,
    phase: batch.phase,
    batchNumber: batch.batchNumber,
    dependencyContext: {
      manager: 'Frontend Manager Agent',
      agentName: batch.agentName,
      phase: batch.phase,
      dependsOn: batch.dependsOn || [],
      concurrentGroup: batch.concurrentGroup || null,
      targetFiles: batch.files,
      knownPitfalls: buildKnownPitfallsPrompt(knownPitfalls),
      manifest: manifestForBatch(manifest, batch)
    }
  });

  const returnedFiles = Array.isArray(generated.files) ? generated.files : [];

  // Model output is untrusted. Ignore malformed, duplicate, or out-of-scope paths
  // before path validation so one extra file cannot terminate the whole project.
  const selected = selectOwnedBatchFiles(returnedFiles, batch);
  generated.files = selected.files;
  if (selected.rejectedPaths.length) {
    generated.warnings = [...(generated.warnings || []), 'Ignored invalid or unowned batch files: ' + selected.rejectedPaths.join(', ')];
  }

  // Fill any target files the LLM forgot to return with fallback content
  const generatedPathSet = new Set(generated.files.map((file) => normalizeProjectPath(file.path)));
  const missingTargets = batch.files.map(normalizeProjectPath).filter((filePath) => !generatedPathSet.has(filePath));
  if (missingTargets.length) {
    const fallbackMap = new Map((fallback.files || []).map((file) => [normalizeProjectPath(file.path), file]));
    for (const missingPath of missingTargets) {
      const fallbackFile = fallbackMap.get(missingPath);
      if (fallbackFile) {
        generated.files.push(fallbackFile);
        generated.warnings = [...(generated.warnings || []), 'Batch ' + batch.batchNumber + ': LLM omitted ' + missingPath + ', filled with safe fallback.'];
      }
    }
  }

  assertOwnedBatchFiles(generated.files, batch, manifest);
  return skipSave || batch.concurrentGroup ? { batch, generated } : generated;
}

export function upsertGeneratedFiles(existingFiles, newFiles) {
  const now = new Date();
  const map = new Map();
  for (const file of existingFiles || []) {
    map.set(normalizeProjectPath(file.path), {
      path: normalizeProjectPath(file.path),
      language: file.language,
      content: file.content,
      version: file.version || 1,
      generatedAt: file.generatedAt || now,
      updatedAt: file.updatedAt || now
    });
  }
  for (const file of newFiles || []) {
    const normalizedPath = normalizeProjectPath(file.path);
    const previous = map.get(normalizedPath);
    map.set(normalizedPath, {
      path: normalizedPath,
      language: file.language || languageForPath(normalizedPath),
      content: String(file.content || ''),
      version: previous ? (previous.version || 1) + 1 : 1,
      generatedAt: previous?.generatedAt || now,
      updatedAt: now
    });
  }
  return Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function mockGenerateBatch({ project, targetFiles, batch }) {
  const spec = project.expandedSpec || {};
  const blueprint = project.blueprint || {};
  const files = targetFiles.map((filePath) => ({
    path: filePath,
    language: languageForPath(filePath),
    content: contentForPath(filePath, spec, blueprint)
  }));
  return { files, contracts: batch ? [{ agentName: batch.agentName, phase: batch.phase, files: targetFiles }] : [], warnings: [] };
}

function contentForPath(filePath, spec, blueprint) {
  if (filePath === 'package.json') return packageJson(blueprint);
  if (filePath === 'index.html') return indexHtml(spec);
  if (filePath === 'vite.config.js') return viteConfig();
  if (filePath === 'tailwind.config.js') return tailwindConfig();
  if (filePath === 'postcss.config.js') return postcssConfig();
  if (filePath === 'src/index.css') return indexCss();
  if (filePath === 'src/main.jsx') return mainJsx();
  if (filePath === 'src/App.jsx') return appJsx(spec, blueprint);
  if (filePath === 'src/data/mockData.js') return mockData(spec);
  if (filePath === 'src/components/AppShell.jsx') return appShell();
  if (filePath === 'src/components/DataCard.jsx') return dataCard();
  if (filePath === 'src/app/App.jsx') return "export { default } from '../App.jsx';\n";
  if (filePath.startsWith('src/pages/')) return pageComponent(filePath, spec, blueprint);
  if (filePath.startsWith('src/components/')) return genericComponent(filePath);
  if (filePath.startsWith('src/layouts/')) return genericLayout(filePath);
  if (filePath.startsWith('src/store/')) return storeFile(filePath);
  if (filePath.startsWith('src/utils/')) return genericUtility(filePath);
  if (filePath.startsWith('src/services/')) return genericService(filePath);
  if (filePath.endsWith('.css')) return '/* Generated frontend styles */\n';
  return genericJs(filePath);
}

function packageJson(blueprint = {}) {
  const versions = managedDependencyVersions;
  const dependencies = {};
  for (const entry of blueprint.requiredDependencies || Object.keys(versions)) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (!name) continue;
    dependencies[name] = (typeof entry === 'object' && entry.version) || versions[name] || 'latest';
  }
  for (const [name, version] of Object.entries(versions)) if (['react','react-dom','vite','@vitejs/plugin-react'].includes(name)) dependencies[name] ||= version;
  return JSON.stringify({ scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview --host 0.0.0.0' }, dependencies, devDependencies: {} }, null, 2) + '\n';
}

function indexHtml(spec) {
  return '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>' + escapeHtml(spec.projectName || 'Generated React App') + '</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n';
}

function viteConfig() {
  return "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({\n  plugins: [react()],\n  server: { host: '0.0.0.0' }\n});\n";
}

function tailwindConfig() {
  return "export default {\n  content: ['./index.html', './src/**/*.{js,jsx}'],\n  theme: { extend: {} },\n  plugins: []\n};\n";
}

function postcssConfig() {
  return "export default {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {}\n  }\n};\n";
}

function indexCss() {
  return "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n:root {\n  color: #111827;\n  background: #f8fafc;\n  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;\n}\nbody { margin: 0; min-width: 320px; }\nbutton, input, textarea { font: inherit; }\n:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }\n";
}

function mainJsx() {
  return "import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App.jsx';\nimport './index.css';\n\nReactDOM.createRoot(document.getElementById('root')).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>\n);\n";
}

function appJsx(spec, blueprint) {
  const routeList = routesFromBlueprint(blueprint);
  const planned = new Set((blueprint.fileList || []).map((file) => String(file.path || '')));
  const hasShell = planned.has('src/components/AppShell.jsx');
  const routerMode = blueprint.stackManifest?.router?.mode || 'browser_router';
  const imports = routerMode === 'none' ? [] : ["import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';"];
  if (hasShell) imports.push("import AppShell from './components/AppShell.jsx';");
  const pageImports = routeList.map((route) => "import " + route.component + " from './pages/" + route.component + ".jsx';");
  if (routerMode === 'none') return pageImports.join('\n') + "\n\nexport default function App() {\n  return <" + routeList[0].component + " />;\n}\n";
  const content = "        <Routes>\n" + routeList.map((route) => "          <Route path=\"" + route.path + "\" element={<" + route.component + " />} />").join('\n') + "\n          <Route path=\"*\" element={<div className=\"rounded-lg border border-slate-200 bg-white p-6\"><h2 className=\"text-xl font-semibold\">Page not found</h2><Link className=\"mt-3 inline-block text-blue-600\" to=\"/\">Return home</Link></div>} />\n        </Routes>";
  const body = hasShell ? "      <AppShell projectName=\"" + escapeJsxAttr(spec.projectName || 'Generated App') + "\" summary=\"" + escapeJsxAttr(spec.projectSummary || 'Generated frontend application') + "\" navItems={navItems}>\n" + content + "\n      </AppShell>" : content;
  const nav = hasShell ? "\n\nconst navItems = " + JSON.stringify(routeList.map((route) => ({ label: route.label, path: route.path })), null, 2) + ";" : '';
  return imports.concat(pageImports).join('\n') + nav + "\n\nexport default function App() {\n  return (\n    <BrowserRouter>\n" + body + "\n    </BrowserRouter>\n  );\n}\n";
}

function mockData(spec) {
  const features = Array.isArray(spec.coreFeatures) && spec.coreFeatures.length ? spec.coreFeatures : ['Responsive dashboard', 'Mock data states', 'Accessible controls'];
  return 'export const metrics = ' + JSON.stringify(features.slice(0, 4).map((feature, index) => ({
    label: feature,
    value: String((index + 2) * 12),
    status: index % 2 === 0 ? 'Ready' : 'In progress'
  })), null, 2) + ';\n\nexport const activity = ' + JSON.stringify(features.map((feature, index) => ({
    id: index + 1,
    title: feature,
    description: 'Generated workflow item for ' + feature.toLowerCase(),
    owner: ['Design', 'Product', 'Engineering'][index % 3]
  })), null, 2) + ';\n';
}

function appShell() {
  return "import { Menu, Sparkles } from 'lucide-react';\nimport { Link } from 'react-router-dom';\n\nexport default function AppShell({ projectName, summary, navItems, children }) {\n  return (\n    <div className=\"min-h-screen bg-slate-100 text-slate-950\">\n      <header className=\"border-b border-slate-200 bg-white\">\n        <div className=\"mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4\">\n          <div className=\"flex items-center gap-3\">\n            <div className=\"flex h-10 w-10 items-center justify-center rounded-lg bg-blue-600 text-white\"><Sparkles size={19} /></div>\n            <div>\n              <h1 className=\"text-lg font-semibold\">{projectName}</h1>\n              <p className=\"text-sm text-slate-500\">{summary}</p>\n            </div>\n          </div>\n          <Menu className=\"text-slate-400 md:hidden\" size={22} />\n          <nav className=\"hidden items-center gap-2 md:flex\">\n            {navItems.map((item) => (\n              <Link key={item.path} to={item.path} className=\"rounded-md px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-950\">{item.label}</Link>\n            ))}\n          </nav>\n        </div>\n      </header>\n      <main className=\"mx-auto max-w-6xl px-4 py-6\">{children}</main>\n    </div>\n  );\n}\n";
}

function dataCard() {
  return "export default function DataCard({ label, value, status }) {\n  return (\n    <article className=\"rounded-xl border border-slate-200 bg-white p-5 shadow-sm\">\n      <p className=\"text-sm font-medium text-slate-500\">{label}</p>\n      <div className=\"mt-3 flex items-end justify-between gap-3\">\n        <p className=\"text-3xl font-semibold text-slate-950\">{value}</p>\n        <span className=\"rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700\">{status}</span>\n      </div>\n    </article>\n  );\n}\n";
}

function pageComponent(filePath, spec, blueprint = {}) {
  const name = componentNameFromPath(filePath);
  const pageTitle = name.replace(/Page$/, '').replace(/([A-Z])/g, ' $1').trim() || 'Overview';
  const planned = new Set((blueprint.fileList || []).map((file) => String(file.path || '')));
  if (!planned.has('src/components/DataCard.jsx') || !planned.has('src/data/mockData.js')) {
    return "export default function " + name + "() {\n  return (\n    <main className=\"min-h-screen bg-slate-950 px-6 py-16 text-white\">\n      <div className=\"mx-auto max-w-4xl\">\n        <p className=\"text-sm font-medium text-blue-300\">Generated frontend</p>\n        <h1 className=\"mt-3 text-4xl font-semibold\">" + escapeText(pageTitle) + "</h1>\n        <p className=\"mt-4 max-w-2xl text-slate-300\">" + escapeText(spec.projectSummary || 'A responsive React interface generated from the approved blueprint.') + "</p>\n      </div>\n    </main>\n  );\n}\n";
  }
  return "import DataCard from '../components/DataCard.jsx';\nimport { activity, metrics } from '../data/mockData.js';\n\nexport default function " + name + "() {\n  return (\n    <div className=\"space-y-6\">\n      <section className=\"rounded-2xl bg-slate-950 p-6 text-white\">\n        <p className=\"text-sm font-medium text-blue-200\">Generated frontend</p>\n        <h2 className=\"mt-2 text-3xl font-semibold\">" + escapeText(pageTitle) + "</h2>\n        <p className=\"mt-3 max-w-3xl text-sm leading-6 text-slate-300\">" + escapeText(spec.projectSummary || 'A responsive React interface generated from the approved blueprint.') + "</p>\n      </section>\n      <section className=\"grid gap-4 md:grid-cols-2 lg:grid-cols-4\">\n        {metrics.map((metric) => <DataCard key={metric.label} {...metric} />)}\n      </section>\n      <section className=\"rounded-xl border border-slate-200 bg-white p-5\">\n        <h3 className=\"text-lg font-semibold\">Workflow</h3>\n        <div className=\"mt-4 grid gap-3\">\n          {activity.map((item) => (\n            <article key={item.id} className=\"rounded-lg border border-slate-200 p-4\">\n              <div className=\"flex flex-col justify-between gap-2 sm:flex-row\">\n                <div>\n                  <h4 className=\"font-semibold\">{item.title}</h4>\n                  <p className=\"mt-1 text-sm text-slate-500\">{item.description}</p>\n                </div>\n                <span className=\"text-sm font-medium text-slate-500\">{item.owner}</span>\n              </div>\n            </article>\n          ))}\n        </div>\n      </section>\n    </div>\n  );\n}\n";
}

function genericComponent(filePath) {
  const name = componentNameFromPath(filePath);
  return "export default function " + name + "({ title = 'Generated component', children }) {\n  return (\n    <section className=\"rounded-xl border border-slate-200 bg-white p-4 shadow-sm\">\n      <h3 className=\"text-base font-semibold text-slate-950\">{title}</h3>\n      {children && <div className=\"mt-3 text-sm text-slate-600\">{children}</div>}\n    </section>\n  );\n}\n";
}

function genericLayout(filePath) {
  const name = componentNameFromPath(filePath);
  return "export default function " + name + "({ children }) {\n  return <div className=\"grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]\">{children}</div>;\n}\n";
}

function storeFile(filePath) {
  if (filePath.endsWith('store.js')) return "export const initialAppState = {};\nexport function createAppStore() {\n  let state = initialAppState;\n  const listeners = new Set();\n  return {\n    getState: () => state,\n    dispatch: (action) => { for (const listener of listeners) listener(); return action; },\n    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },\n    replaceReducer: () => {}\n  };\n}\nexport const store = createAppStore();\n";
  return "export const initialState = {};\nexport function reducer(state = initialState) {\n  return state;\n}\n";
}

function genericUtility(filePath) {
  return "export function formatLabel(value) {\n  return String(value || '').replace(/[-_]/g, ' ').replace(/\\b\\w/g, (letter) => letter.toUpperCase());\n}\n";
}

function genericService(filePath) {
  return "export async function loadMockResource(data) {\n  return Promise.resolve(data);\n}\n";
}

function genericJs(filePath) {
  if (filePath.endsWith('.jsx')) return genericComponent(filePath);
  return "export const generatedModule = true;\n";
}

function routesFromBlueprint(blueprint) {
  const sourceRoutes = Array.isArray(blueprint.routes) && blueprint.routes.length ? blueprint.routes : [{ path: '/', component: 'HomePage' }];
  const seen = new Set();
  return sourceRoutes.map((route, index) => {
    const pathValue = route.path || (index === 0 ? '/' : '/page-' + index);
    const component = String(route.component || (index === 0 ? 'HomePage' : 'GeneratedPage' + index)).replace(/[^A-Za-z0-9]/g, '') || 'GeneratedPage';
    const label = component.replace(/Page$/, '').replace(/([A-Z])/g, ' $1').trim() || 'Home';
    const uniquePath = seen.has(pathValue) ? pathValue + '-' + index : pathValue;
    seen.add(uniquePath);
    return { path: uniquePath, component, label };
  });
}

function componentNameFromPath(filePath) {
  const base = filePath.split('/').pop().replace(/\.(jsx|js)$/, '').replace(/[^A-Za-z0-9]/g, '');
  const name = base ? base[0].toUpperCase() + base.slice(1) : 'GeneratedComponent';
  return /^[A-Z]/.test(name) ? name : 'GeneratedComponent';
}

function escapeText(value) {
  return String(value || '').replace(/[<>]/g, '');
}

function escapeHtml(value) {
  return escapeText(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function escapeJsxAttr(value) {
  return escapeText(value).replace(/"/g, '&quot;');
}
