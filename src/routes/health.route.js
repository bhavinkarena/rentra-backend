import { Router } from 'express';
import * as health from '@/controllers/health.controller.js';

const router = Router();

router.get('/live', health.live);
router.get('/ready', health.ready);

export default router;
