import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { unavailable } from '@/utils/apiError.js';
function key(env, purpose) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16)
    throw unavailable('EXPORT_KEY_UNAVAILABLE');
  return createHash('sha256')
    .update(`rentra:${purpose}-export:` + env.SESSION_SECRET)
    .digest();
}
export function encryptArtifact(bytes, id, env, purpose = 'admin') {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(env, purpose), iv);
  cipher.setAAD(Buffer.from(id));
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((v) => v.toString('base64')).join('.');
}
export function decryptArtifact(value, id, env, purpose = 'admin') {
  const [iv, tag, bytes] = value.split('.').map((v) => Buffer.from(v, 'base64'));
  const cipher = createDecipheriv('aes-256-gcm', key(env, purpose), iv);
  cipher.setAAD(Buffer.from(id));
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}
