import { Router } from 'express';
import { getLlmConfig, validateOpenAiKey } from '../controllers/llmController.js';
import { requireOpenAiApiKey } from '../middleware/openAiCredentials.js';

const router = Router();

router.get('/config', getLlmConfig);
router.post('/validate-key', requireOpenAiApiKey, validateOpenAiKey);

export default router;
