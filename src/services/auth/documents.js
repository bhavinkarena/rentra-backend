'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/services/db';
import { documents, users, clientApplication } from '@/services/db/schema/index.js';
import { audit } from '@/services/audit';
import {
  uploadPrivateDocument, destroyDocument, detectMime, UPLOAD_LIMITS,
  isCloudinaryConfigured,
} from '@/services/uploads/cloudinary';
import { getCurrentUser } from './dal';
import { getOrCreateApplication } from './application';
import { ID_DOCUMENT_BY_ID } from '@/services/constants';

/**
 * KYC document upload — front and back of one ID.
 *
 * Files pass THROUGH the server rather than going browser-to-Cloudinary
 * directly. Slower, but it means the MIME type is sniffed from magic bytes and
 * the size is enforced before anything touches storage. For ID documents that
 * trade is worth making; for listing photography it would not be.
 */


async function clientIp() {
  const h = await headers();
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
}

/** Live (non-superseded, non-deleted) documents for an owner. */
export async function listDocuments({ ownerType, ownerId }) {
  return db
    .select({
      id: documents.id,
      docType: documents.docType,
      side: documents.side,
      storageKey: documents.storageKey,
      mimeType: documents.mimeType,
      bytes: documents.bytes,
      status: documents.status,
      uploadedAt: documents.uploadedAt,
      reviewNote: documents.reviewNote,
    })
    .from(documents)
    .where(and(
      eq(documents.ownerType, ownerType),
      eq(documents.ownerId, ownerId),
      isNull(documents.deletedAt),
    ));
}

function validateFile(file, side) {
  if (!file || typeof file.arrayBuffer !== 'function' || file.size === 0) {
    return `Choose a ${side} image`;
  }
  if (file.size > UPLOAD_LIMITS.maxBytes) {
    return `The ${side} image is ${(file.size / 1024 / 1024).toFixed(1)}MB — keep it under 2MB`;
  }
  return null;
}

/**
 * Upload both sides of an identity document.
 *
 * Aadhaar: only the MASKED download UIDAI provides is accepted. Storing a full
 * Aadhaar copy is restricted for non-authorised entities, and there is no
 * upside — PAN proves identity for our purposes just as well.
 */
export async function uploadKycDocuments(_prev, formData) {
  const user = await getCurrentUser();
  if (!user || user.role !== 'client') redirect('/partner/login');

  if (!isCloudinaryConfigured()) {
    return { errors: { _: 'Document upload is not configured on this server yet.' } };
  }

  const app = await getOrCreateApplication(user.id);
  if (app.status === 'submitted') redirect('/partner?locked=in_review');

  const docType = String(formData.get('docType') ?? '');
  const spec = ID_DOCUMENT_BY_ID[docType];
  if (!spec) return { errors: { docType: 'Choose which document you are uploading' } };

  const nameOnDoc = String(formData.get('kycNameOnDoc') ?? '').trim();
  if (nameOnDoc.length < 3) {
    return { errors: { kycNameOnDoc: 'Enter the name exactly as printed on the document' } };
  }

  if (docType === 'aadhaar_masked' && formData.get('maskedConfirmed') !== 'on') {
    return {
      errors: {
        maskedConfirmed: 'Please confirm this is the masked Aadhaar from the UIDAI site. '
          + 'We cannot accept a full Aadhaar copy.',
      },
    };
  }

  // Collect and validate every required side BEFORE uploading any of them, so
  // a bad back image cannot leave a stray front image in storage.
  const staged = [];
  const errors = {};

  for (const side of spec.sides) {
    const file = formData.get(side);
    const problem = validateFile(file, side);
    if (problem) {
      errors[side] = problem;
      continue;
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const sniffed = detectMime(buffer);

    // Never trust file.type — it is client-supplied and trivially spoofed.
    if (!sniffed || !UPLOAD_LIMITS.mimeTypes.includes(sniffed)) {
      errors[side] = 'That file is not a JPG, PNG, WEBP or PDF';
      continue;
    }

    staged.push({ side, buffer, mime: sniffed });
  }

  if (Object.keys(errors).length) return { errors };

  const ip = await clientIp();
  const uploaded = [];

  try {
    for (const item of staged) {
      const result = await uploadPrivateDocument({
        buffer: item.buffer,
        folder: `rentra/kyc/${user.id}`,
        // Stable slot id, so re-uploading a side replaces rather than piles up.
        publicId: `${docType}_${item.side}`,
      });

      await db
        .insert(documents)
        .values({
          ownerType: 'client_application',
          ownerId: app.id,
          docType,
          side: item.side,
          storageKey: result.publicId,
          mimeType: item.mime,
          bytes: result.bytes,
          width: result.width,
          height: result.height,
          status: 'uploaded',
          uploadedBy: user.id,
          uploadedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [documents.ownerType, documents.ownerId, documents.docType, documents.side],
          set: {
            storageKey: result.publicId,
            mimeType: item.mime,
            bytes: result.bytes,
            width: result.width,
            height: result.height,
            // A replaced document goes back to unreviewed, and any previous
            // rejection note is cleared — otherwise the reviewer sees a stale
            // complaint against a file that no longer exists.
            status: 'uploaded',
            reviewNote: null,
            reviewedBy: null,
            deletedAt: null,
            uploadedAt: new Date(),
          },
        });

      uploaded.push(`${docType}/${item.side}`);
    }
  } catch (err) {
    return {
      errors: { _: `Upload failed: ${err.message}. Nothing was saved — please try again.` },
    };
  }

  // Record the document TYPE and the name printed on it — but never a URL,
  // never a document number, and never the bytes.
  await db.update(clientApplication).set({
    kycDocType: docType,
    kycNameOnDoc: nameOnDoc,
    updatedAt: new Date(),
  }).where(eq(clientApplication.id, app.id));

  await db.update(users).set({
    kycStatus: 'pending', updatedAt: new Date(),
  }).where(eq(users.id, user.id));

  await audit({
    actorType: 'client', actorId: user.id, entity: 'client_application',
    entityId: app.id, action: 'kyc_documents_uploaded',
    after: { docType, sides: uploaded },
    ip,
  });

  redirect('/partner');
}

/** Remove a document the Client uploaded — bytes destroyed, not just hidden. */
export async function deleteKycDocument(_prev, formData) {
  const user = await getCurrentUser();
  if (!user || user.role !== 'client') redirect('/partner/login');

  const app = await getOrCreateApplication(user.id);
  if (app.status === 'submitted') redirect('/partner?locked=in_review');

  const id = String(formData.get('documentId') ?? '');

  const [doc] = await db
    .select()
    .from(documents)
    .where(and(
      eq(documents.id, id),
      eq(documents.ownerType, 'client_application'),
      eq(documents.ownerId, app.id),
    ))
    .limit(1);

  if (!doc) return { errors: { _: 'That document is no longer there.' } };

  await destroyDocument(doc.storageKey);
  await db.delete(documents).where(eq(documents.id, doc.id));

  await audit({
    actorType: 'client', actorId: user.id, entity: 'document',
    entityId: doc.id, action: 'kyc_document_deleted',
    before: { docType: doc.docType, side: doc.side }, ip: await clientIp(),
  });

  redirect('/partner/onboarding/kyc');
}
