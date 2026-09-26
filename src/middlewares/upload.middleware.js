import multer from 'multer';
import { APP } from '@/config/appConfig.js';

/**
 * Multipart handling for KYC documents, listing photos and ownership proof.
 *
 * Memory storage, not disk: every upload is immediately streamed to Cloudinary
 * and never needs a path. Writing it to /tmp first would leave identity
 * documents sitting on the filesystem of whatever box happened to serve the
 * request — a copy nobody is tracking and nobody deletes.
 *
 * The 2MB ceiling matches MAX_DOC_BYTES in the shared constants, and the
 * actions check `file.size` again themselves so the limit holds for the cron
 * and script entry points too.
 */
const storage = multer.memoryStorage();

/**
 * MIME type is client-supplied and trivially spoofed, so this filter is a
 * convenience that gives a clean error for the honest mistake — the real check
 * is the magic-byte sniff in the upload service.
 */
function fileFilter(_req, file, cb) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];
  cb(null, allowed.includes(file.mimetype));
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: APP.uploadFileBytes, files: APP.uploadMaxFiles },
});

/** One file under a known field name, e.g. ownership proof. */
export const singleFile = (field) => upload.single(field);

/** Several files under one field name, e.g. listing photos. */
export const manyFiles = (field, max = APP.uploadMaxFiles) => upload.array(field, max);

/** Distinct field names, e.g. an ID document's front and back. */
export const fileFields = (fields) => upload.fields(fields);

/**
 * CP13 visit evidence photos. No MIME filter here: a filtered file would be
 * dropped silently and the evidence saved without the photo the operator
 * attached. Every file reaches the service, which sniffs magic bytes and
 * rejects the whole submission with a field error instead.
 */
const evidenceUpload = multer({ storage, limits: { fileSize: APP.uploadFileBytes, files: 3 } });
export const evidencePhotos = () => evidenceUpload.array('photos', 3);

/** A multipart body that carries no files — parses the text fields only. */
export const formFields = () => upload.none();
