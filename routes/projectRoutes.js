import { Router } from 'express';
import {
  classifyProjectMessage,
  deployProject,
  editProject,
  expandProject,
  expandProjectStream,
  explainProject,
  fixProject,
  generateProject,
  generateProjectStream,
  getDependencyGraph,
  getDeploymentStatus,
  getProject,
  getProjectDeployments,
  getProjectFiles,
  getProjectReviews,
  getVerifiedFixSuggestions,
  planProject,
  planProjectStream,
  regenerateProject,
  restoreProject,
  reviewProject,
  updateApproval,
  updateProjectFiles
} from '../controllers/projectController.js';
import { requireVisitor } from '../middleware/visitor.js';
import { uploadImage } from '../middleware/upload.js';
import { requireOpenAiApiKey, withRequestOpenAiCredentials } from '../middleware/openAiCredentials.js';

const router = Router();
router.use(requireVisitor);
router.get('/memory/verified-fixes', getVerifiedFixSuggestions);
router.get('/deployments/:deploymentId/status', getDeploymentStatus);
router.post('/expand/stream', requireOpenAiApiKey, uploadImage.single('image'), withRequestOpenAiCredentials, expandProjectStream);
router.post('/expand', requireOpenAiApiKey, uploadImage.single('image'), withRequestOpenAiCredentials, expandProject);
router.post('/plan/stream', requireOpenAiApiKey, planProjectStream);
router.post('/plan', requireOpenAiApiKey, planProject);
router.get('/:projectId', getProject);
router.get('/:projectId/files', getProjectFiles);
router.patch('/:projectId/files', updateProjectFiles);
router.post('/:projectId/generate', requireOpenAiApiKey, generateProject);
router.post('/:projectId/generate/stream', requireOpenAiApiKey, generateProjectStream);
router.post('/:projectId/regenerate', requireOpenAiApiKey, regenerateProject);
router.post('/:projectId/review', reviewProject);
router.post('/:projectId/fix', requireOpenAiApiKey, fixProject);
router.post('/:projectId/intent', requireOpenAiApiKey, classifyProjectMessage);
router.post('/:projectId/edit', requireOpenAiApiKey, editProject);
router.post('/:projectId/explain', requireOpenAiApiKey, explainProject);
router.post('/:projectId/deploy', deployProject);
router.get('/:projectId/deployments', getProjectDeployments);
router.get('/:projectId/reviews', getProjectReviews);
router.get('/:projectId/dependency-graph', getDependencyGraph);
router.post('/:projectId/restore', restoreProject);
router.patch('/:projectId/approval', updateApproval);
export default router;
