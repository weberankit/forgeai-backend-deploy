import { Router } from 'express';
import {
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

const router = Router();
router.use(requireVisitor);
router.get('/memory/verified-fixes', getVerifiedFixSuggestions);
router.get('/deployments/:deploymentId/status', getDeploymentStatus);
router.post('/expand/stream', uploadImage.single('image'), expandProjectStream);
router.post('/expand', uploadImage.single('image'), expandProject);
router.post('/plan/stream', planProjectStream);
router.post('/plan', planProject);
router.get('/:projectId', getProject);
router.get('/:projectId/files', getProjectFiles);
router.patch('/:projectId/files', updateProjectFiles);
router.post('/:projectId/generate', generateProject);
router.post('/:projectId/generate/stream', generateProjectStream);
router.post('/:projectId/regenerate', regenerateProject);
router.post('/:projectId/review', reviewProject);
router.post('/:projectId/fix', fixProject);
router.post('/:projectId/edit', editProject);
router.post('/:projectId/explain', explainProject);
router.post('/:projectId/deploy', deployProject);
router.get('/:projectId/deployments', getProjectDeployments);
router.get('/:projectId/reviews', getProjectReviews);
router.get('/:projectId/dependency-graph', getDependencyGraph);
router.post('/:projectId/restore', restoreProject);
router.patch('/:projectId/approval', updateApproval);
export default router;
