import { Router } from 'express';
import * as saved from '@/controllers/saved.controller.js';

/**
 * Saved places are public on purpose: a guest can save before they sign in,
 * and the list follows them into the account afterwards. The service resolves
 * the actor itself and decides whether it is looking at a guest list or a
 * customer's own.
 */
const router = Router();

router.get('/', saved.mine);
router.post('/guest', saved.guest);
router.post('/update', saved.update);
/** Called once after login, to fold a guest list into the account's. */
router.post('/merge', saved.merge);

export default router;
