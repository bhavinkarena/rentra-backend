import { Readable } from 'node:stream';
import { sql } from '@/config/database.js';
import {
  acceptJoin,
  completeLogin,
  endStaffSession,
  getCurrentStaff,
  sendJoinCode,
  sendLoginCode,
} from '@/services/auth/staff-session.js';
import { inspectInvite } from '@/services/auth/staff-team.js';
import { listStaffVisits, readStaffVisitRecord } from '@/services/booking/staff-visits.js';
import { recordStaffVisit } from '@/services/booking/lifecycle-actions.js';
import { visitAttachmentFile } from '@/services/booking/evidence-actions.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { runAction } from '@/utils/runAction.js';
import { ok } from '@/utils/respond.js';
import { forbidden, notFound, unauthorized } from '@/utils/apiError.js';

/* Joining and signing in: public, rate-limited at the route. */
export const invite = asyncHandler(async (req, res) =>
  ok(res, await inspectInvite(sql, req.body?.token)),
);
export const joinCode = asyncHandler(async (req, res) =>
  ok(res, await sendJoinCode(req.body?.token, req.ip ?? null)),
);
export const join = asyncHandler(async (req, res) =>
  ok(res, await acceptJoin(req.body?.token, req.body?.code)),
);
export const loginCode = asyncHandler(async (req, res) =>
  ok(res, await sendLoginCode(req.body?.phone, req.ip ?? null)),
);
export const login = asyncHandler(async (req, res) =>
  ok(res, await completeLogin(req.body?.phone, req.body?.code)),
);
export const logout = asyncHandler(async (_req, res) => {
  await endStaffSession();
  return ok(res, { ok: true });
});

/** The live caretaker, re-read per request: revocation and reassignment apply at once. */
export const requireStaff = (capability = 'staff.assigned-visits.read') =>
  asyncHandler(async (req, _res, next) => {
    const staff = await getCurrentStaff();
    if (!staff)
      throw unauthorized('STAFF_REQUIRED', 'Your caretaker session has ended. Sign in again.');
    if (!staff.capabilities.includes(capability))
      throw forbidden('CAPABILITY_REQUIRED', 'The owner has not allowed this for your account.');
    req.staff = staff;
    next();
  });

export const me = asyncHandler(async (req, res) => ok(res, req.staff));
export const visits = asyncHandler(async (req, res) =>
  ok(res, await listStaffVisits(sql, req.staff, req.query)),
);
export const visit = asyncHandler(async (req, res) => {
  const record = await readStaffVisitRecord(sql, req.staff, req.params.id);
  if (!record) throw notFound('VISIT_NOT_FOUND', 'This booking is not assigned to you.');
  return ok(res, record);
});
export const transition = runAction(recordStaffVisit);
export const attachment = asyncHandler(async (req, res) => {
  const file = await visitAttachmentFile(
    'staff',
    req.params.id,
    req.params.attachmentId,
    req.ip ?? null,
  );
  if (file.status === 404) throw notFound('ATTACHMENT_NOT_FOUND', 'Not found.');
  if (file.status === 502)
    return res.error(502, 'Photo unavailable.', { code: 'ATTACHMENT_UNAVAILABLE' });
  res.set('Content-Type', file.contentType);
  res.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  res.set('Content-Disposition', `inline; filename="${file.filename}"`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
  res.set('X-Robots-Tag', 'noindex, nofollow');
  return Readable.fromWeb(file.body).pipe(res);
});
