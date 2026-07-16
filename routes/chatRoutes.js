import { Router } from 'express';
import { addMessage, createChat, getChat, listChats } from '../controllers/chatController.js';
import { requireVisitor } from '../middleware/visitor.js';

const router = Router();

router.use(requireVisitor);
router.post('/', createChat);
router.get('/', listChats);
router.get('/:chatId', getChat);
router.post('/:chatId/messages', addMessage);

export default router;
