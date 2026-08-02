import { randomUUID } from 'crypto';
import { Chat } from '../models/Chat.js';
import { Project } from '../models/Project.js';
import { httpError } from '../utils/httpError.js';
import { describeImage } from '../services/ai/imageDescriptionService.js';
import { expandSpecification, planFrontendProject } from '../services/ai/aiClient.js';
import { generateProjectFiles, getGenerationPlan, upsertGeneratedFiles } from '../services/generation/codeGenerationService.js';
import { validateGeneratedFiles } from '../services/generation/generatedFileValidation.js';
import { languageForPath, normalizeProjectPath } from '../services/generation/pathSafety.js';
import { runQualityReview } from '../services/review/reviewAgent.js';
import { assertRepairableProject, runFixLoop } from '../services/review/fixAgent.js';
import { runStaticValidation } from '../services/review/staticValidation.js';
import { applyNaturalLanguageEdit } from '../services/edit/editAgent.js';
import { routeChatIntent } from '../services/edit/intentRouter.js';
import { restoreLatestSnapshot } from '../services/review/versioningService.js';
import { explainProjectQuestion } from '../services/explain/explainAgent.js';
import { startDeployment, getDeployment } from '../services/deploy/deploymentService.js';
import { retrieveVerifiedFixes } from '../services/memory/verifiedFixMemory.js';
import { getWebsiteCapture } from '../services/website/websiteCaptureStore.js';
import { getRequestLlmQualityMode, setRequestLlmQualityMode } from '../context/requestLlmContext.js';
import { normalizeLlmQualityMode } from '../config/llmQualityMode.js';
import {
  buildExpansionWebsiteContext,
  buildGeneratorWebsiteReference
} from '../services/website/websiteCaptureService.js';
import { withProjectCallLog } from '../services/observability/centralCallLogger.js';

function serializeProject(project) {
  return project.toObject({ versionKey: false });
}

async function findVisitorChat(chatId, visitorId) {
  const chat = await Chat.findOne({ chatId, visitorId });
  if (!chat) throw httpError(404, 'Chat not found.');
  return chat;
}

function activeQualityMode(fallback = 'standard') {
  return normalizeLlmQualityMode(getRequestLlmQualityMode(), fallback);
}

function syncProjectQualityMode(project) {
  const qualityMode = activeQualityMode(project.qualityMode || 'standard');
  setRequestLlmQualityMode(qualityMode);
  project.qualityMode = qualityMode;
  return qualityMode;
}

async function findVisitorProject(projectId, visitorId) {
  const project = await Project.findOne({ projectId, visitorId });
  if (!project) throw httpError(404, 'Project not found.');
  syncProjectQualityMode(project);
  return project;
}

function writeSse(res, event, data) {
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify(data) + '\n\n');
}

function startSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
}

function websiteCaptureForRequest(req, prompt) {
  const captureId = String(req.body?.websiteCaptureId || '').trim();
  if (!captureId) return { websiteContext: null, websiteReference: null };
  const capture = getWebsiteCapture(captureId, req.visitorId);
  return {
    websiteContext: buildExpansionWebsiteContext(capture, prompt),
    websiteReference: buildGeneratorWebsiteReference(capture, prompt)
  };
}

export async function expandProjectStream(req, res, next) {
  startSse(res);
  try {
    const chatId = String(req.body.chatId || '').trim();
    const prompt = String(req.body.prompt || '').trim();
    if (!chatId) throw httpError(400, 'chatId is required.');
    if (prompt.length < 8) throw httpError(400, 'Prompt must be at least 8 characters.');

    const chat = await findVisitorChat(chatId, req.visitorId);
    const projectId = randomUUID();
    const qualityMode = activeQualityMode();
    const imageDescription = await describeImage(req.file);
    const { websiteContext, websiteReference } = websiteCaptureForRequest(req, prompt);
    const expandedSpec = await withProjectCallLog({
      projectId,
      operation: 'project_expansion',
      qualityMode
    }, () => expandSpecification({ prompt, imageDescription, websiteContext, onToken: (token) => writeSse(res, 'token', { token }) }));
    if (websiteReference) expandedSpec.websiteReference = websiteReference;

    const project = await Project.create({
      projectId,
      chatId,
      visitorId: req.visitorId,
      name: expandedSpec.projectName,
      originalPrompt: prompt,
      qualityMode,
      imageMetadata: imageDescription?.metadata || null,
      websiteReference,
      expandedSpec,
      approvalStatus: 'draft',
      status: 'spec_ready'
    });

    chat.title = expandedSpec.projectName || chat.title;
    chat.messages.push({
      messageId: randomUUID(),
      role: 'assistant',
      type: 'specification',
      content: 'Expanded specification ready for ' + expandedSpec.projectName + '.',
      metadata: { projectId: project.projectId }
    });
    await chat.save();
    writeSse(res, 'final', { project: serializeProject(project), imageDescription });
    res.end();
  } catch (error) {
    writeSse(res, 'error', { message: error.message, code: error.code });
    res.end();
  }
}

export async function expandProject(req, res, next) {
  try {
    const chatId = String(req.body.chatId || '').trim();
    const prompt = String(req.body.prompt || '').trim();
    if (!chatId) throw httpError(400, 'chatId is required.');
    if (prompt.length < 8) throw httpError(400, 'Prompt must be at least 8 characters.');

    const chat = await findVisitorChat(chatId, req.visitorId);
    const projectId = randomUUID();
    const qualityMode = activeQualityMode();
    const imageDescription = await describeImage(req.file);
    const { websiteContext, websiteReference } = websiteCaptureForRequest(req, prompt);
    const expandedSpec = await withProjectCallLog({
      projectId,
      operation: 'project_expansion',
      qualityMode
    }, () => expandSpecification({ prompt, imageDescription, websiteContext }));
    if (websiteReference) expandedSpec.websiteReference = websiteReference;

    const project = await Project.create({
      projectId,
      chatId,
      visitorId: req.visitorId,
      name: expandedSpec.projectName,
      originalPrompt: prompt,
      qualityMode,
      imageMetadata: imageDescription?.metadata || null,
      websiteReference,
      expandedSpec,
      approvalStatus: 'draft',
      status: 'spec_ready'
    });

    chat.title = expandedSpec.projectName || chat.title;
    chat.messages.push({
      messageId: randomUUID(),
      role: 'assistant',
      type: 'specification',
      content: 'Expanded specification ready for ' + expandedSpec.projectName + '.',
      metadata: { projectId: project.projectId }
    });
    await chat.save();

    res.status(201).json({ project: serializeProject(project), imageDescription });
  } catch (error) {
    next(error);
  }
}

export async function planProjectStream(req, res, next) {
  startSse(res);
  try {
    const projectId = String(req.body.projectId || '').trim();
    if (!projectId) throw httpError(400, 'projectId is required.');

    const project = await findVisitorProject(projectId, req.visitorId);
    const specification = req.body.specification || project.expandedSpec;
    if (!specification) throw httpError(400, 'Specification is required.');

    const blueprint = await withProjectCallLog({
      projectId: project.projectId,
      operation: 'project_planning',
      qualityMode: project.qualityMode
    }, () => planFrontendProject({
      specification,
      clarification: req.body.clarification,
      onToken: (token) => writeSse(res, 'token', { token })
    }));

    project.expandedSpec = specification;
    project.blueprint = blueprint;
    project.approvalStatus = 'draft';
    project.clarification = String(req.body.clarification || '');
    project.status = 'planned';
    await project.save();

    const chat = await findVisitorChat(project.chatId, req.visitorId);
    chat.messages.push({
      messageId: randomUUID(),
      role: 'assistant',
      type: 'blueprint',
      content: 'Blueprint generated for ' + project.name + '.',
      metadata: { projectId: project.projectId }
    });
    await chat.save();
    writeSse(res, 'final', { project: serializeProject(project) });
    res.end();
  } catch (error) {
    writeSse(res, 'error', { message: error.message, code: error.code });
    res.end();
  }
}

export async function planProject(req, res, next) {
  try {
    const projectId = String(req.body.projectId || '').trim();
    if (!projectId) throw httpError(400, 'projectId is required.');

    const project = await findVisitorProject(projectId, req.visitorId);
    const specification = req.body.specification || project.expandedSpec;
    if (!specification) throw httpError(400, 'Specification is required.');

    const blueprint = await withProjectCallLog({
      projectId: project.projectId,
      operation: 'project_planning',
      qualityMode: project.qualityMode
    }, () => planFrontendProject({
      specification,
      clarification: req.body.clarification
    }));

    project.expandedSpec = specification;
    project.blueprint = blueprint;
    project.approvalStatus = 'draft';
    project.clarification = String(req.body.clarification || '');
    project.status = 'planned';
    await project.save();

    const chat = await findVisitorChat(project.chatId, req.visitorId);
    chat.messages.push({
      messageId: randomUUID(),
      role: 'assistant',
      type: 'blueprint',
      content: 'Blueprint generated for ' + project.name + '.',
      metadata: { projectId: project.projectId }
    });
    await chat.save();

    res.json({ project: serializeProject(project) });
  } catch (error) {
    next(error);
  }
}

export async function updateApproval(req, res, next) {
  try {
    const approvalStatus = String(req.body.approvalStatus || '');
    if (!['approved', 'changes_requested'].includes(approvalStatus)) {
      throw httpError(400, 'approvalStatus must be approved or changes_requested.');
    }

    const project = await findVisitorProject(req.params.projectId, req.visitorId);
    project.approvalStatus = approvalStatus;
    project.status = approvalStatus;
    project.clarification = String(req.body.clarification || project.clarification || '');
    await project.save();

    const chat = await findVisitorChat(project.chatId, req.visitorId);
    chat.messages.push({
      messageId: randomUUID(),
      role: 'assistant',
      type: approvalStatus === 'approved' ? 'status' : 'clarification',
      content: approvalStatus === 'approved' ? 'Blueprint approved.' : 'Changes requested for the blueprint.',
      metadata: { projectId: project.projectId, clarification: project.clarification }
    });
    await chat.save();

    res.json({ project: serializeProject(project) });
  } catch (error) {
    next(error);
  }
}

export async function getProject(req, res, next) {
  try {
    const project = await findVisitorProject(req.params.projectId, req.visitorId);
    res.json({ project: serializeProject(project), generationPlan: getGenerationPlan(project.blueprint || {}) });
  } catch (error) {
    next(error);
  }
}

export async function getProjectFiles(req, res, next) {
  try {
    const project = await findVisitorProject(req.params.projectId, req.visitorId);
    res.json({ files: project.generatedFiles || [], generationStatus: project.generationStatus, generationWarnings: project.generationWarnings });
  } catch (error) {
    next(error);
  }
}

export async function generateProject(req, res, next) {
  try {
    const project = await findVisitorProject(req.params.projectId, req.visitorId);
    if (project.approvalStatus !== 'approved') throw httpError(409, 'Blueprint must be approved before generation.');
    if (['preparing', 'generating_batch', 'validating', 'storing'].includes(project.generationStatus)) {
      throw httpError(409, 'Generation is already in progress.');
    }

    const generated = await generateProjectFiles(project);
    const chat = await findVisitorChat(generated.chatId, req.visitorId);
    chat.messages.push({
      messageId: randomUUID(),
      role: 'assistant',
      type: 'status',
      content: 'Generated project files are ready for live preview.',
      metadata: { projectId: generated.projectId, fileCount: generated.generatedFiles.length }
    });
    await chat.save();

    res.status(201).json({ project: serializeProject(generated), files: generated.generatedFiles, generationPlan: getGenerationPlan(generated.blueprint || {}) });
  } catch (error) {
    next(error);
  }
}

export async function generateProjectStream(req, res) {
  startSse(res);
  try {
    const project = await findVisitorProject(req.params.projectId, req.visitorId);
    if (project.approvalStatus !== 'approved') throw httpError(409, 'Blueprint must be approved before generation.');
    const generated = await generateProjectFiles(project, {
      onFiles: async (files, current) => writeSse(res, 'files', {
        files,
        generationStatus: current.generationStatus,
        generationProgress: current.generationProgress,
        currentBatch: current.currentBatch
      })
    });
    const chat = await findVisitorChat(generated.chatId, req.visitorId);
    chat.messages.push({ messageId: randomUUID(), role: 'assistant', type: 'status', content: 'Generated project files are ready for live preview.', metadata: { projectId: generated.projectId, fileCount: generated.generatedFiles.length } });
    await chat.save();
    writeSse(res, 'final', { project: serializeProject(generated), files: generated.generatedFiles, generationPlan: getGenerationPlan(generated.blueprint || {}) });
    res.end();
  } catch (error) {
    writeSse(res, 'error', { message: error.message, code: error.code });
    res.end();
  }
}

export async function updateProjectFiles(req, res, next) {
  try {
    const project = await findVisitorProject(req.params.projectId, req.visitorId);
    const files = Array.isArray(req.body.files) ? req.body.files : [];
    if (!files.length) throw httpError(400, 'files array is required.');
    const normalizedFiles = files.map((file) => ({
      path: normalizeProjectPath(file.path),
      language: file.language || languageForPath(file.path),
      content: String(file.content || '')
    }));
    validateGeneratedFiles(upsertGeneratedFiles(project.generatedFiles || [], normalizedFiles));
    project.generatedFiles = upsertGeneratedFiles(project.generatedFiles || [], normalizedFiles);
    project.generationStatus = 'ready_for_preview';
    project.generationProgress = 100;
    await project.save();
    res.json({ project: serializeProject(project), files: project.generatedFiles });
  } catch (error) {
    next(error);
  }
}

export async function regenerateProject(req, res, next) {
  try {
    const project = await findVisitorProject(req.params.projectId, req.visitorId);
    if (project.approvalStatus !== 'approved') throw httpError(409, 'Blueprint must be approved before regeneration.');
    const selectedFiles = Array.isArray(req.body.files) ? req.body.files : [];
    if (!selectedFiles.length && !project.failedBatch) throw httpError(400, 'Provide selected files or retry a failed generation.');
    const generated = await generateProjectFiles(project, { selectedFiles });
    res.json({ project: serializeProject(generated), files: generated.generatedFiles, generationPlan: getGenerationPlan(generated.blueprint || {}) });
  } catch (error) {
    next(error);
  }
}


export async function reviewProject(req, res, next) {
  try {
    const project = await findVisitorProject(req.params.projectId, req.visitorId);
    project.operationStatus = 'reviewing';
    const review = await runQualityReview({ project, runtimeOutput: String(req.body.runtimeOutput || ''), attempt: (project.reviewHistory?.length || 0) + 1, changedFiles: req.body.changedFiles || null });
    project.reviewHistory.push(review);
    project.dependencyGraph = review.staticValidation.graph;
    project.operationStatus = review.status === 'passed' ? 'review_passed' : 'review_failed';
    await project.save();
    res.json({ project: serializeProject(project), review });
  } catch (error) { next(error); }
}

export async function fixProject(req, res, next) {
  try {
    const project = await findVisitorProject(req.params.projectId, req.visitorId);
    assertRepairableProject(project);
    project.operationStatus = 'fixing';
    await project.save();
    const result = await runFixLoop(project, {
      runtimeOutput: String(req.body.runtimeOutput || ''),
      runtimeEvidence: req.body.runtimeEvidence && typeof req.body.runtimeEvidence === 'object' ? req.body.runtimeEvidence : {},
      maxAttempts: 2
    });
    res.json({ project: serializeProject(project), result });
  } catch (error) { next(error); }
}

export async function classifyProjectMessage(req, res, next) {
  try {
    await findVisitorProject(req.params.projectId, req.visitorId);
    const message = String(req.body.message || '').trim();
    if (!message) throw httpError(400, 'message is required.');
    const intent = await routeChatIntent(message);
    res.json({ intent });
  } catch (error) { next(error); }
}

export async function editProject(req, res, next) {
  try {
    const project = await findVisitorProject(req.params.projectId, req.visitorId);
    const message = String(req.body.message || '').trim();
    if (!message) throw httpError(400, 'message is required.');
    if (!project.generatedFiles?.length) throw httpError(409, 'Generate project files before editing.');
    project.operationStatus = 'interpreting';
    await project.save();
    const result = await applyNaturalLanguageEdit(project, message);
    const chatId = String(req.body.chatId || project.chatId || '');
    if (chatId) {
      const chat = await findVisitorChat(chatId, req.visitorId);
      chat.messages.push({ messageId: randomUUID(), role: 'user', type: 'clarification', content: message, metadata: { projectId: project.projectId, intent: 'edit' } });
      chat.messages.push({ messageId: randomUUID(), role: 'assistant', type: 'status', content: result.status === 'needs_clarification' ? result.clarification : 'Applied edit to generated files.', metadata: { projectId: project.projectId, changedFiles: result.changes?.map((change) => change.path) || [] } });
      await chat.save();
    }
    res.json({ project: serializeProject(project), result });
  } catch (error) { next(error); }
}

export async function getProjectReviews(req, res, next) {
  try {
    const project = await findVisitorProject(req.params.projectId, req.visitorId);
    res.json({ reviews: project.reviewHistory || [] });
  } catch (error) { next(error); }
}

export async function getDependencyGraph(req, res, next) {
  try {
    const project = await findVisitorProject(req.params.projectId, req.visitorId);
    if (!project.dependencyGraph || Object.keys(project.dependencyGraph).length === 0) {
      const validation = runStaticValidation(project.generatedFiles || []);
      project.dependencyGraph = validation.graph;
      await project.save();
    }
    res.json({ dependencyGraph: project.dependencyGraph });
  } catch (error) { next(error); }
}

export async function restoreProject(req, res, next) {
  try {
    const project = await findVisitorProject(req.params.projectId, req.visitorId);
    const snapshot = restoreLatestSnapshot(project);
    if (!snapshot) throw httpError(404, 'No restorable project snapshot found.');
    const validation = runStaticValidation(project.generatedFiles || []);
    project.dependencyGraph = validation.graph;
    await project.save();
    res.json({ project: serializeProject(project), snapshot });
  } catch (error) { next(error); }
}


export async function explainProject(req, res, next) {
  try {
    const project = await findVisitorProject(req.params.projectId, req.visitorId);
    const question = String(req.body.question || req.body.message || '').trim();
    if (!question) throw httpError(400, 'question is required.');
    const explanation = await explainProjectQuestion(project, question);
    project.lastExplanation = explanation;
    project.operationStatus = 'explained';
    await project.save();
    res.json({ project: serializeProject(project), explanation });
  } catch (error) { next(error); }
}

export async function deployProject(req, res, next) {
  try {
    const project = await findVisitorProject(req.params.projectId, req.visitorId);
    if (!project.generatedFiles?.length) throw httpError(409, 'Generate project files before deployment.');
    project.operationStatus = 'deploying';
    const deployment = await startDeployment(project);
    res.status(202).json({ project: serializeProject(project), deployment });
  } catch (error) { next(error); }
}

export async function getProjectDeployments(req, res, next) {
  try {
    const project = await findVisitorProject(req.params.projectId, req.visitorId);
    res.json({ deployments: project.deployments || [] });
  } catch (error) { next(error); }
}

export async function getDeploymentStatus(req, res, next) {
  try {
    const project = await Project.findOne({ visitorId: req.visitorId, 'deployments.deploymentId': req.params.deploymentId });
    if (!project) throw httpError(404, 'Deployment not found.');
    const deployment = getDeployment(project, req.params.deploymentId);
    res.json({ deployment });
  } catch (error) { next(error); }
}

export async function getVerifiedFixSuggestions(req, res, next) {
  try {
    const fixes = await retrieveVerifiedFixes({ category: req.query.category, message: req.query.message, file: req.query.file, technologies: ['React', 'Vite', 'JavaScript'] });
    res.json({ fixes });
  } catch (error) { next(error); }
}
