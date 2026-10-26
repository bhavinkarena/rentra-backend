import 'server-only';
import { randomUUID } from 'node:crypto';
import { v2 as cloudinary } from 'cloudinary';
import { getEnv } from '@/services/schemas/joi/env';

/**
 * Story 1.3 private property videos.
 *
 * The browser uploads straight to Cloudinary with a short-lived signature for
 * one exact public id, as an `authenticated` asset. Nothing the browser says
 * about the file is trusted: `inspect()` asks Cloudinary for the container it
 * detected and the stored size, and the service destroys anything outside
 * VIDEO_LIMITS. Playback goes through the API with a 60-second signed URL.
 */
export const VIDEO_LIMITS = Object.freeze({
  maxBytes: 50 * 1024 * 1024,
  formats: ['mp4', 'mov'],
});

function api() {
  const env = getEnv();
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  return { cloudinary, env };
}

const cloudinaryVideoStore = Object.freeze({
  configured: () => Boolean(getEnv().CLOUDINARY_CLOUD_NAME),
  newKey: (folder) => `${folder}/${randomUUID()}`,
  signUpload(publicId) {
    const { cloudinary: c, env } = api();
    const params = {
      public_id: publicId,
      type: 'authenticated',
      allowed_formats: VIDEO_LIMITS.formats.join(','),
      overwrite: 'false',
      tags: 'property-evidence-video,sensitive',
      timestamp: Math.floor(Date.now() / 1000),
    };
    return {
      url: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/video/upload`,
      fields: {
        ...params,
        api_key: env.CLOUDINARY_API_KEY,
        signature: c.utils.api_sign_request(params, env.CLOUDINARY_API_SECRET),
      },
    };
  },
  async inspect(publicId) {
    try {
      const r = await api().cloudinary.api.resource(publicId, {
        resource_type: 'video',
        type: 'authenticated',
      });
      return { format: r.format, bytes: r.bytes };
    } catch {
      return null;
    }
  },
  async remove(publicId) {
    await api().cloudinary.uploader.destroy(publicId, {
      resource_type: 'video',
      type: 'authenticated',
      invalidate: true,
    });
  },
  async stream(publicId, range) {
    const url = api().cloudinary.url(publicId, {
      resource_type: 'video',
      type: 'authenticated',
      sign_url: true,
      secure: true,
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    const upstream = await fetch(url, { headers: range ? { Range: range } : {} });
    return upstream.ok || upstream.status === 206 ? upstream : null;
  },
});

/** Tests may inject a store under NODE_ENV=test only, like `evidenceStore()`. */
export function videoStore() {
  if (process.env.NODE_ENV === 'test' && globalThis.__rentraVideoStore) {
    return globalThis.__rentraVideoStore;
  }
  return cloudinaryVideoStore;
}

/** Test double: `files` maps a public id to the metadata Cloudinary would report. */
export function memoryVideoStore() {
  const files = new Map(),
    removed = [];
  return {
    files,
    removed,
    configured: () => true,
    newKey: (folder) => `${folder}/${randomUUID()}`,
    signUpload: (publicId) => ({
      url: 'https://upload.test/video',
      fields: { public_id: publicId, signature: 'test' },
    }),
    inspect: async (publicId) => files.get(publicId) ?? null,
    async remove(publicId) {
      files.delete(publicId);
      removed.push(publicId);
    },
    async stream(publicId) {
      return files.has(publicId)
        ? new Response('video-bytes', { headers: { 'content-type': 'video/mp4' } })
        : null;
    },
  };
}
