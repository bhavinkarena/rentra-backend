import { listDocuments, uploadKycDocuments, deleteKycDocument } from '@/services/auth/documents.js';
import { runAction } from '@/utils/runAction.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

/**
 * KYC documents.
 *
 * Uploads arrive as multipart and are streamed straight to Cloudinary as
 * `authenticated` assets — nothing is written to disk here, and the response
 * never carries a public URL. See the upload middleware for why.
 */
export const list = asyncHandler(async (req, res) =>
  ok(res, await listDocuments({ ownerType: 'user', ownerId: req.user.id })),
);

export const upload = runAction(uploadKycDocuments);
export const remove = runAction(deleteKycDocument);
