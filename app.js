import express from 'express';
import cors from 'cors';
import chatRoutes from './routes/chatRoutes.js';
import projectRoutes from './routes/projectRoutes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { activityRequestLogger, ingestBrowserActivity } from './middleware/activityLogging.js';

const app = express();

app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '1mb' }));
app.use(activityRequestLogger);

app.post('/api/activity', ingestBrowserActivity);

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.use('/api/chats', chatRoutes);
app.use('/api/projects', projectRoutes);
app.use(errorHandler);

export default app;
