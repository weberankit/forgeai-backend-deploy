import { Router } from 'express';
import {
  captureSelectedWebsitePages,
  discoverWebsitePages
} from '../controllers/websiteImportController.js';
import { requireVisitor } from '../middleware/visitor.js';

const router = Router();

router.use(requireVisitor);
router.post('/discover', discoverWebsitePages);
router.post('/capture', captureSelectedWebsitePages);

export default router;
