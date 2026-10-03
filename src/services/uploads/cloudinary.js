import 'server-only';

import { v2 as cloudinary } from 'cloudinary';
import { getEnv } from '@/services/schemas/joi/env';

/**
 * Cloudinary, for KYC and ownership documents ONLY.
 *
 * The single most important line in this file is `type: 'authenticated'`.
 *
 * Cloudinary's default (`type: 'upload'`) makes every file publicly readable
 * by anyone who has or guesses the URL, forever, with no auth. Uploading
 * somebody's ID that way and storing the URL in a database column is a breach
 * waiting for the first person to run a SELECT. Authenticated assets cannot be
 * fetched without a signed, expiring URL — which is what `signedUrl()` mints,
 * per request, per admin, and which we audit each time.
 *
 * Listing photography does NOT belong here: it is public by design and goes
 * through next/image from a normal public bucket.
 */

let configured = false;

function client() {
  const env = getEnv();

  if (!env.CLOUDINARY_CLOUD_NAME) {
    throw new Error(
      'Cloudinary is not configured — set CLOUDINARY_CLOUD_NAME, '
      + 'CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.',
    );
  }

  if (!configured) {
    cloudinary.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    configured = true;
  }

  return cloudinary;
}

export function isCloudinaryConfigured() {
  try {
    return Boolean(getEnv().CLOUDINARY_CLOUD_NAME);
  } catch {
    return false;
  }
}

export const UPLOAD_LIMITS = {
  maxBytes: 2 * 1024 * 1024, // 2MB per side — a phone photo of an ID, compressed
  mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
};

/**
 * Upload a document to authenticated (private) storage.
 *
 * @param {object} input
 * @param {Buffer} input.buffer
 * @param {string} input.folder    e.g. `kyc/<userId>`
 * @param {string} input.publicId  stable slot id, so re-upload overwrites
 * @returns {Promise<{publicId:string, bytes:number, width:number|null,
 *                    height:number|null, format:string|null}>}
 */
export async function uploadPrivateDocument({ buffer, folder, publicId }) {
  const api = client();

  return new Promise((resolve, reject) => {
    const stream = api.uploader.upload_stream(
      {
        folder,
        public_id: publicId,
        // ---- the access controls ----
        type: 'authenticated',   // no public URL exists for this asset
        access_mode: 'authenticated',
        overwrite: true,         // re-uploading a side replaces it
        invalidate: true,
        resource_type: 'image',
        // Never let Cloudinary guess: an ID document is not a transformation
        // target and must not be eagerly derived into public variants.
        eager: [],
        // Strip camera metadata — an ID photo carries GPS and device details
        // that we have no reason to keep.
        image_metadata: false,
      transformation: [{flags:'strip_profile'}],
        tags: ['kyc', 'sensitive'],
      },
      (error, result) => {
        if (error) return reject(new Error(error.message ?? 'Cloudinary upload failed'));
        return resolve({
          publicId: result.public_id,
          bytes: result.bytes,
          width: result.width ?? null,
          height: result.height ?? null,
          format: result.format ?? null,
        });
      },
    );

    stream.end(buffer);
  });
}

/**
 * CP13 visit evidence photo, private like KYC. The public id is the content
 * hash and `overwrite` is off, so a retry can never replace committed evidence.
 */
export async function uploadPrivateEvidence({ buffer, folder, publicId }) {
  const api = client();
  return new Promise((resolve, reject) => {
    const stream = api.uploader.upload_stream({
      folder,
      public_id: publicId,
      type: 'authenticated',
      access_mode: 'authenticated',
      overwrite: false,
      resource_type: 'image',
      eager: [],
      image_metadata: false,
      transformation: [{flags:'strip_profile'}],
      tags: ['visit-evidence', 'sensitive'],
    }, (error, result) => {
      if (error) return reject(new Error(error.message ?? 'Cloudinary upload failed'));
      return resolve({ publicId: result.public_id, bytes: result.bytes });
    });
    stream.end(buffer);
  });
}

/** Public listing photography. This must never be used for identity or ownership documents. */
export async function uploadPublicListingPhoto({ buffer, folder, publicId }) {
  const api = client();
  return new Promise((resolve, reject) => {
    const stream = api.uploader.upload_stream({
      folder,
      public_id: publicId,
      type: 'upload',
      access_mode: 'public',
      overwrite: false,
      resource_type: 'image',
      image_metadata: false,
      transformation: [{flags:'strip_profile'}],
      tags: ['listing-photo', 'public'],
    }, (error, result) => {
      if (error) return reject(new Error(error.message ?? 'Cloudinary upload failed'));
      return resolve({
        publicId: result.public_id,
        bytes: result.bytes,
        width: result.width ?? null,
        height: result.height ?? null,
        format: result.format ?? null,
      });
    });
    stream.end(buffer);
  });
}

/**
 * A short-lived signed URL. Default 5 minutes: long enough to render in an
 * admin's browser, short enough that a copied link is useless by the time it
 * reaches anywhere else.
 */
export function signedUrl(publicId, { expiresInSeconds = 300 } = {}) {
  const api = client();

  return api.url(publicId, {
    type: 'authenticated',
    resource_type: 'image',
    sign_url: true,
    secure: true,
    expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
  });
}

/** Retention / right-to-erasure. Destroys the bytes, not just the row. */
export async function destroyDocument(publicId) {
  const api = client();
  const result = await api.uploader.destroy(publicId, {
    type: 'authenticated',
    resource_type: 'image',
    invalidate: true,
  });
  return result?.result === 'ok' || result?.result === 'not found';
}

/** Sniff the real type from magic bytes — never trust the client's MIME. */
export function detectMime(buffer) {
  if (buffer.length < 12) return null;
  const b = buffer;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.subarray(0, 4).toString('ascii') === 'RIFF'
    && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (b.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return null;
}

/** Public avatar: decode and re-encode to a small square, stripping original metadata. */
export async function uploadProfilePhoto({ buffer, publicId }) {
  const api = client();
  return new Promise((resolve, reject) => {
    const stream = api.uploader.upload_stream({
      folder: 'profile-photos', public_id: publicId, type: 'upload',
      resource_type: 'image', overwrite: false, format: 'webp',
      transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'auto', quality: 85 }],
      image_metadata: false,
      tags: ['profile-photo'],
    }, (error, result) => {
      if (error) return reject(new Error('Profile photo upload failed.'));
      resolve({ publicId: result.public_id });
    });
    stream.end(buffer);
  });
}
export async function destroyProfilePhoto(publicId) {
  if (!publicId?.startsWith('profile-photos/')) return false;
  const result = await client().uploader.destroy(publicId, { type: 'upload', resource_type: 'image', invalidate: true });
  return result?.result === 'ok' || result?.result === 'not found';
}

export function signListingPhoto(listingId, nonce) {
 const api=client(),env=getEnv(),timestamp=Math.floor(Date.now()/1000);
 const params={timestamp,public_id:`rentra/listings/${listingId}/${nonce}`,overwrite:false,transformation:'fl_strip_profile',image_metadata:false};
 return {...params,signature:api.utils.api_sign_request(params,env.CLOUDINARY_API_SECRET),api_key:env.CLOUDINARY_API_KEY,cloudName:env.CLOUDINARY_CLOUD_NAME};
}
export async function listingPhotoAsset(key){return client().api.resource(key,{resource_type:'image',type:'upload',image_metadata:false});}
export async function destroyListingPhoto(key){if(key?.startsWith('rentra/listings/'))return client().uploader.destroy(key,{resource_type:'image',type:'upload',invalidate:true});}
export async function cleanListingPhotoOrphans(database) {
 if(!isCloudinaryConfigured())return {removed:0};
 let cursor,removed=0;
 do {
  const page=await client().api.resources({type:'upload',resource_type:'image',prefix:'rentra/listings/',max_results:100,next_cursor:cursor});
  for(const asset of page.resources) {
   if(Date.now()-new Date(asset.created_at).getTime()<86400000)continue;
   const [used]=await database`SELECT 1 FROM rentable WHERE photos @> ${JSON.stringify([{key:asset.public_id}])}::text::jsonb LIMIT 1`;
   if(!used){await destroyListingPhoto(asset.public_id);removed++;}
  }
  cursor=page.next_cursor;
 }while(cursor);
 return {removed};
}
