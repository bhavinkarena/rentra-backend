/**
 * Development photo library for the entertainment seed (Unsplash License).
 *   node --import ./loader/register.mjs --env-file=.env src/scripts/upload-entertainment-photos.js <picks.json>
 * Uploads each picked Unsplash photo to Cloudinary under seed/entertainment and writes
 * cloudinary-entertainment-map.json ({ activity: [secure_url…] }) for seed-entertainment-venues.js.
 * Credentials come from .env, never from this file.
 */
import { v2 as cloudinary } from 'cloudinary';
import { readFile, writeFile } from 'node:fs/promises';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const picks = JSON.parse(await readFile(process.argv[2], 'utf8'));
const map = {};
const credits = [];
for (const [activity, photos] of Object.entries(picks)) {
  map[activity] = [];
  for (const [i, photo] of photos.entries()) {
    const publicId = `${activity}_${i + 1}`;
    const source = `https://images.unsplash.com/${photo.id}?auto=format&fit=crop&w=1600&q=80`;
    try {
      const res = await cloudinary.uploader.upload(source, {
        folder: 'seed/entertainment',
        public_id: publicId,
        overwrite: true,
        resource_type: 'image',
      });
      map[activity].push(res.secure_url);
      credits.push(`${activity}/${publicId}  ${photo.page}`);
      console.log(`  ✓ ${publicId}`);
    } catch (error) {
      console.error(`  ✗ ${publicId}: ${error.message}`);
    }
  }
}
await writeFile(
  new URL('./cloudinary-entertainment-map.json', import.meta.url),
  JSON.stringify(map, null, 2),
);
await writeFile(
  new URL('./cloudinary-entertainment-credits.txt', import.meta.url),
  `Entertainment seed photography — Unsplash License\n\n${credits.join('\n')}\n`,
);
console.log('done', Object.values(map).flat().length);
