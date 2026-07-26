import express from 'express';
import cors from 'cors';
import chatRoutes from './routes/chatRoutes.js';
import projectRoutes from './routes/projectRoutes.js';
import llmRoutes from './routes/llmRoutes.js';
import websiteImportRoutes from './routes/websiteImportRoutes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { activityRequestLogger, ingestBrowserActivity } from './middleware/activityLogging.js';
import { withRequestOpenAiCredentials } from './middleware/openAiCredentials.js';

const app = express();

app.use(cors({
  origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  allowedHeaders: ['Content-Type', 'x-visitor-id', 'x-request-id', 'x-openai-api-key'],
  exposedHeaders: ['x-request-id']
}));
app.use(express.json({ limit: '1mb' }));
app.use(withRequestOpenAiCredentials);
app.use(activityRequestLogger);

app.post('/api/activity', ingestBrowserActivity);

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.use('/api/chats', chatRoutes);
app.use('/api/llm', llmRoutes);
app.use('/api/website-import', websiteImportRoutes);
app.use('/api/projects', projectRoutes);
app.use(errorHandler);

export default app;
