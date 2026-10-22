/**
 * Demo photos for every property and hotel room type that has none (dev data).
 *
 *   npm run seed:photos
 *
 * Uses the Cloudinary seed pool (cloudinary-seed-map.json). Only empty
 * galleries are filled, so real uploads are never touched and reruns are no-ops.
 */
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { seedDatabaseUrl } from './seed-guard.js';

const POOL = JSON.parse(await readFile(new URL('./cloudinary-seed-map.json', import.meta.url), 'utf-8'));
const take = (arr, n, off) => Array.from({ length: n }, (_, i) => arr[(off + i) % arr.length]);
const label = (url) => (url.includes('/room-') ? 'Room' : url.includes('/pool-') ? 'Swimming pool' : 'Lawn and grounds');

const sql = postgres(seedDatabaseUrl('seed-photos'), { max: 1, onnotice: () => {} });
try {
  const properties = await sql`SELECT id, title FROM rentable WHERE photos = '[]'::jsonb ORDER BY created_at`;
  for (const [i, p] of properties.entries()) {
    const urls = [...take(POOL.pool, 3, i), ...take(POOL.room, 3, i * 2), ...take(POOL.lawn, 2, i + 1)];
    const photos = urls.map((url) => ({ url, alt: `${label(url)} at ${p.title}` }));
    await sql`UPDATE rentable SET photos = ${sql.json(photos)} WHERE id = ${p.id}`;
  }
  const rooms = await sql`SELECT id, name FROM room_type WHERE photos = '[]'::jsonb ORDER BY id`;
  for (const [i, r] of rooms.entries()) {
    const photos = take(POOL.room, 3, i).map((url) => ({ url, alt: `${r.name} room` }));
    await sql`UPDATE room_type SET photos = ${sql.json(photos)} WHERE id = ${r.id}`;
  }
  console.log(`[seed-photos] ${properties.length} properties and ${rooms.length} room types given demo photos.`);
} finally {
  await sql.end();
}
