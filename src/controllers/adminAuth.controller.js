import { adminLogin, adminLogout } from '@/services/auth/admin-actions.js';
import { runAction } from '@/utils/runAction.js';
import { ok } from '@/utils/respond.js';

export const login = runAction(adminLogin);
export const logout = runAction(adminLogout, { style: 'none' });

/** The admin actor, already resolved and verified by requireAdmin. */
export const me = (req, res) => ok(res, { admin: req.admin });
