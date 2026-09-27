import { readFile, writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { seedReviewModeration } from './review-moderation-fixture.js';
const path = process.env.CP06_GATE_FIXTURE,
  f = JSON.parse(await readFile(path, 'utf8')),
  url = new URL(f.databaseUrl);
if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/rentra_test_'))
  throw new Error('Disposable fixture required');
const sql = postgres(f.databaseUrl);
try {
  const review = await seedReviewModeration(sql, f.ids, f.booking);
  const [property] = await sql`SELECT public_code,slug FROM rentable WHERE id=${f.ids.listing}`;
  await writeFile(
    path,
    JSON.stringify({
      ...f,
      reviewId: review.reviewId,
      reviewVisitId: review.visitId,
      publicCode: property.public_code,
      slug: property.slug,
    }),
  );
  console.log('CP18 review fixture ready');
} finally {
  await sql.end();
}
