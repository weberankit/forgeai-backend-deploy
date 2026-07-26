import { Router } from 'express';
import { validateOpenAiKey } from '../controllers/llmController.js';
import { requireOpenAiApiKey } from '../middleware/openAiCredentials.js';

const router = Router();

router.post('/validate-key', requireOpenAiApiKey, validateOpenAiKey);

export default router;
