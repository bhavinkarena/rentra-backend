import 'server-only';
import { randomUUID } from 'node:crypto';
import { CustomerAccountError, lockCustomerAccount } from '../auth/customer-access.js';
import { detectMime, uploadProfilePhoto, destroyProfilePhoto } from '../uploads/cloudinary.js';
import { publicPhotoUrl } from '../domain/listing-content.js';

export const PROFILE_PHOTO_MAX_BYTES = 2 * 1024 * 1024;
export function profilePhotoUrl(key, env = process.env) {
  return key ? publicPhotoUrl({ key }, { cloudName: env.CLOUDINARY_CLOUD_NAME }) : null;
}
export function validateProfilePhoto(buffer) {
  if (!buffer?.length || buffer.length > PROFILE_PHOTO_MAX_BYTES) {
    throw new CustomerAccountError('Choose a photo smaller than 2 MB.');
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(detectMime(buffer))) {
    throw new CustomerAccountError('Choose a JPG, PNG or WebP photo.');
  }
}

export async function saveProfilePhoto(database, session, { buffer, remove = false, expectedVersion }, env = process.env, storage = { upload: uploadProfilePhoto, destroy: destroyProfilePhoto }) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new CustomerAccountError('Reload your profile and try again.');
  if (!remove) validateProfilePhoto(buffer);
  let uploaded, previous;
  try {
    // Verify ownership before uploading, then recheck and lock before committing.
    await database.begin(tx => lockCustomerAccount(tx, session, env));
    if (!remove) uploaded = await storage.upload({ buffer, publicId: randomUUID() });
    await database.begin(async tx => {
      const user = await lockCustomerAccount(tx, session, env);
      const [profile] = await tx`SELECT photo_public_id,version FROM customer_profile WHERE user_id=${user.id} FOR UPDATE`;
      if (!profile) throw new CustomerAccountError('Save your name before adding a profile photo.');
      if (profile.version !== expectedVersion) throw new CustomerAccountError('Your profile changed in another tab. Reload before saving.');
      previous = profile.photo_public_id;
      await tx`UPDATE customer_profile SET photo_public_id=${uploaded?.publicId ?? null},version=version+1,updated_at=now() WHERE user_id=${user.id}`;
    });
  } catch (error) {
    if (uploaded) await storage.destroy(uploaded.publicId).catch(() => {});
    throw error;
  }
  if (previous) await storage.destroy(previous).catch(() => {});
  return { photoUrl: profilePhotoUrl(uploaded?.publicId, env), version: expectedVersion + 1 };
}
