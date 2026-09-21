import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents } from '../db/schema/index.js';
import { signedUrl } from '../uploads/cloudinary.js';
import { audit } from '../audit.js';

/**
 * Fetch one KYC document's bytes for an admin reviewer.
 *
 * WHY PROXY INSTEAD OF HANDING OVER A CLOUDINARY URL:
 * Cloudinary's time-limited tokens (`__cld_token__`) are a paid add-on.
 * Without them `expires_at` yields a signature but no expiry, so a URL handed
 * to a browser works forever for anyone who gets hold of it — verified: an
 * "expired" signed URL still returned HTTP 200.
 *
 * Proxying is better than expiry anyway. Access is re-checked against the live
 * admin session on every request, so revoking an admin revokes their access to
 * every document immediately rather than after some window. And no Cloudinary
 * URL ever reaches the browser, its history, or a referrer header.
 *
 * Returns a descriptor, never a `Response` — the controller writes the bytes.
 */
export async function readDocumentFile(adminId, documentId, { ip = null } = {}) {
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);

  /** 404, not 403 — do not confirm that a document id exists to a stranger. */
  if (!doc || doc.deletedAt) return { status: 404 };

  const upstream = await fetch(signedUrl(doc.storageKey, { expiresInSeconds: 60 }));
  if (!upstream.ok || !upstream.body) return { status: 502 };

  await audit({
    actorType: 'admin',
    actorId: adminId,
    entity: 'document',
    entityId: doc.id,
    action: 'document_viewed',
    after: { docType: doc.docType, side: doc.side },
    ip,
  });

  return {
    status: 200,
    body: upstream.body,
    contentType:
      doc.mimeType ?? upstream.headers.get('content-type') ?? 'application/octet-stream',
    filename: `${doc.docType}_${doc.side}`,
  };
}
