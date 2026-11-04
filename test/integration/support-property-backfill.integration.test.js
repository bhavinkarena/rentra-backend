import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase, migrateWithDrizzle } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';

// 0099 through the real migrator: existing customer cases gain their booking's property.
test(
  '0099 backfills customer support cases with their booking property',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL, {
      through: '0098_review_report_evidence',
    });
    const { sql } = db;
    try {
      const f = await seedReviewFixture(sql),
        booking = await seedConfirmedBooking(sql, f.listing);
      const id = randomUUID();
      await sql`INSERT INTO support_request(id,reference,customer_id,order_id,category,subject,context,policy_version,request_key,request_hash)
        VALUES(${id},'SUP-QA0099BACKFILL',${booking.customer},${booking.order},'booking','Fixture case','{}','fixture',${randomUUID()},${'a'.repeat(64)})`;
      const journal = (await import('../../drizzle/meta/_journal.json', { with: { type: 'json' } }))
        .default;
      const when = journal.entries.find((e) => e.tag === '0098_review_report_evidence').when;
      await migrateWithDrizzle(db.url, when);
      const [row] = await sql`SELECT property_id FROM support_request WHERE id=${id}`;
      assert.equal(row.property_id, f.listing);
    } finally {
      await db.drop();
    }
  },
);
