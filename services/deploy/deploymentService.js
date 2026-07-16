import { randomUUID } from 'crypto';
import { validateGeneratedFiles } from '../generation/generatedFileValidation.js';

export async function startDeployment(project) {
  validateGeneratedFiles(project.generatedFiles || []);
  const deploymentId = randomUUID();
  const provider = process.env.DEPLOY_PROVIDER || 'mock';
  const deployment = {
    deploymentId,
    provider,
    status: 'validating',
    url: '',
    error: '',
    createdAt: new Date(),
    updatedAt: new Date(),
    demoMode: provider !== 'vercel'
  };
  project.deployments = project.deployments || [];
  project.deployments.push(deployment);
  await project.save();
  if (provider === 'vercel' && process.env.VERCEL_TOKEN) {
    return markFailed(project, deploymentId, 'Real Vercel deployment is not enabled in this hackathon build. Configure provider adapter before production use.');
  }
  return mockDeploy(project, deploymentId);
}

export function getDeployment(project, deploymentId) {
  return (project.deployments || []).find((deployment) => deployment.deploymentId === deploymentId) || null;
}

async function mockDeploy(project, deploymentId) {
  const deployment = getDeployment(project, deploymentId);
  deployment.status = 'ready';
  deployment.updatedAt = new Date();
  deployment.url = 'demo://deployment/' + project.projectId + '/' + deploymentId;
  deployment.demoMode = true;
  await project.save();
  return deployment;
}

async function markFailed(project, deploymentId, message) {
  const deployment = getDeployment(project, deploymentId);
  deployment.status = 'failed';
  deployment.error = message;
  deployment.updatedAt = new Date();
  await project.save();
  return deployment;
}
