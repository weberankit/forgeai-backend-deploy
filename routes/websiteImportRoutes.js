import { Router } from 'express';
import {
  captureSelectedWebsitePages,
  discoverWebsitePages,
  streamWebsitePages
} from '../controllers/websiteImportController.js';
import { requireVisitor } from '../middleware/visitor.js';

const router = Router();

router.use(requireVisitor);
router.post('/discover', discoverWebsitePages);
router.post('/discover-stream', streamWebsitePages);
router.post('/capture', captureSelectedWebsitePages);

export default router;
