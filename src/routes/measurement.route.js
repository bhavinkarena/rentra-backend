import { Router } from 'express';
import * as measurement from '@/controllers/measurement.controller.js';
import { rawBody } from '@/middlewares/rawBody.middleware.js';

/**
 * Browser beacon. Takes the raw body because the ingest service enforces its
 * own 512-byte ceiling before parsing — the point being that a body large
 * enough to carry an identifier is rejected rather than read.
 */
const router = Router();

router.post('/', rawBody, measurement.ingest);

export default router;
