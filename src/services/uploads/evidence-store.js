import 'server-only';
import { isCloudinaryConfigured, signedUrl, uploadPrivateEvidence } from './cloudinary.js';

/**
 * Private storage for CP13 visit evidence photos.
 *
 * Keys are content-addressed (`<folder>/<sha256>`) and stay inside the API:
 * browsers only ever reach bytes through the authorized, audited proxy.
 */
const cloudinaryStore = Object.freeze({
  configured: () => isCloudinaryConfigured(),
  async put({ folder, name, buffer }) {
    return { key: (await uploadPrivateEvidence({ buffer, folder, publicId: name })).publicId };
  },
  async get(key) {
    const upstream = await fetch(signedUrl(key, { expiresInSeconds: 60 }));
    return upstream.ok && upstream.body ? { body: upstream.body } : null;
  },
});

/**
 * The disposable test harness may inject a store, and only under NODE_ENV=test,
 * the same way it injects `globalThis.__rentraSql`. There is no environment
 * switch that could point a deployed server at anything but private storage.
 */
export function evidenceStore() {
  if (process.env.NODE_ENV === 'test' && globalThis.__rentraEvidenceStore) {
    return globalThis.__rentraEvidenceStore;
  }
  return cloudinaryStore;
}

/** Test double: keeps the first bytes stored under a key, like `overwrite: false`. */
export function memoryEvidenceStore() {
  const files = new Map();
  return {
    files,
    configured: () => true,
    async put({ folder, name, buffer }) {
      const key = `${folder}/${name}`;
      if (!files.has(key)) files.set(key, Buffer.from(buffer));
      return { key };
    },
    async get(key) {
      const body = files.get(key);
      return body ? { body: new Blob([body]).stream() } : null;
    },
  };
}
