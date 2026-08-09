import { randomUUID } from 'node:crypto';

const baseUrl = process.env.PIPELINE_API_URL || 'http://localhost:4000';
const visitorId = process.env.PIPELINE_VISITOR_ID || randomUUID();
const prompts = [
  'Build a polished task manager with mock tasks, status filters, search, summary cards, and local interactive state. Use a modern responsive UI.',
  'Build an analytics dashboard with mock revenue data, date and team filters, summary cards, a responsive chart, recent activity, and working navigation tabs.',
  'Build a responsive ecommerce storefront with mock products, category filters, search, product detail views, a working cart drawer, and a mock checkout flow.',
  'Build a multi-page CRM admin application with dashboard metrics, customer table filtering, customer details, pipeline stages, activity feed, settings forms, and working responsive navigation.'
];

async function request(path, options = {}, timeoutMs = 15 * 60_000) {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: {
      'x-visitor-id': visitorId,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((payload.error?.message || payload.message || 'Request failed') + ' (' + response.status + ')');
  return payload;
}

async function runProject(prompt, index) {
  const startedAt = Date.now();
  const result = { index: index + 1, prompt, stages: {} };
  try {
    let stageStarted = Date.now();
    const chat = await request('/api/chats', { method: 'POST' });
    result.chatId = chat.chat.chatId;
    result.stages.chatMs = Date.now() - stageStarted;

    stageStarted = Date.now();
    const expanded = await request('/api/projects/expand', {
      method: 'POST',
      body: JSON.stringify({ chatId: result.chatId, prompt })
    });
    result.projectId = expanded.project.projectId;
    result.name = expanded.project.name;
    result.stages.expandMs = Date.now() - stageStarted;
    console.log(JSON.stringify({ event: 'expanded', index: result.index, projectId: result.projectId, name: result.name, durationMs: result.stages.expandMs }));

    stageStarted = Date.now();
    await request('/api/projects/plan', {
      method: 'POST',
      body: JSON.stringify({ projectId: result.projectId })
    });
    result.stages.planMs = Date.now() - stageStarted;

    await request('/api/projects/' + result.projectId + '/approval', {
      method: 'PATCH',
      body: JSON.stringify({ approvalStatus: 'approved' })
    });

    stageStarted = Date.now();
    const generated = await request('/api/projects/' + result.projectId + '/generate', { method: 'POST' });
    result.stages.generateMs = Date.now() - stageStarted;
    result.status = generated.project.generationStatus;
    result.fileCount = generated.project.generatedFiles?.length || 0;
    result.warningCount = generated.project.generationWarnings?.length || 0;
    result.failedBatch = generated.project.failedBatch || null;
    result.error = generated.project.generationError || '';
  } catch (error) {
    result.status = 'request_failed';
    result.error = error.message;
    if (result.projectId) {
      const latest = await request('/api/projects/' + result.projectId).catch(() => null);
      if (latest?.project) {
        result.status = latest.project.generationStatus;
        result.fileCount = latest.project.generatedFiles?.length || 0;
        result.warningCount = latest.project.generationWarnings?.length || 0;
        result.failedBatch = latest.project.failedBatch || null;
        result.error = latest.project.generationError || result.error;
      }
    }
  }
  result.totalMs = Date.now() - startedAt;
  console.log(JSON.stringify({ event: 'completed', ...result }));
  return result;
}

const results = [];
for (let offset = 0; offset < prompts.length; offset += 2) {
  results.push(...await Promise.all(prompts.slice(offset, offset + 2).map((prompt, index) => runProject(prompt, offset + index))));
}
console.log(JSON.stringify({ event: 'matrix_complete', visitorId, results }));
