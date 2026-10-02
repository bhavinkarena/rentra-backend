import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedVenue } from '../helpers/venue-fixture.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';

test(
  'Phase 5: three-court venue submission, review, verification, publication and discovery',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = fixture.url;
      const farm = await seedReviewFixture(sql);
      const venue = await seedVenue(sql, { status: 'draft' });
      const id = venue.venue;
      // Reuse valid location/photo evidence while keeping venue-specific courts, hours and rates.
      await sql`UPDATE rentable v SET location=f.location,exact_address=f.exact_address,
        description=f.description,photos=f.photos,house_rules='{"footwear":"non_marking","cancellationConfirmed":true}'::jsonb
        FROM rentable f WHERE v.id=${id} AND f.id=${farm.listing}`;
      await sql`INSERT INTO amenity_vertical(amenity_id,vertical_code)
        SELECT amenity_id,'entertainment' FROM rentable_amenity WHERE rentable_id=${farm.listing}`;
      await sql`INSERT INTO rentable_amenity(rentable_id,amenity_id)
        SELECT ${id},amenity_id FROM rentable_amenity WHERE rentable_id=${farm.listing}`;
      await sql`INSERT INTO document(owner_type,owner_id,doc_type,storage_key,status)
        VALUES ('rentable',${id},'rent_agreement','fixture/venue-lease','uploaded')`;
      const { submitProperty, decidePropertyReview } = await import('@/services/admin/listings.js');
      const {
        listingInventory,
        scheduleVerification,
        recordVerificationOutcome,
        publishProperty,
        VENUE_CHECKLIST,
        CHECKLIST,
      } = await import('@/services/admin/verification.js');
      const inventory = async () => {
        const [row] = await sql`SELECT * FROM rentable WHERE id=${id}`;
        return listingInventory(sql, id, row);
      };
      assert.equal((await inventory()).bookable, true);
      await sql`UPDATE vertical SET status='hidden' WHERE code='entertainment'`;
      await assert.rejects(submitProperty(sql, { id, clientId: venue.owner }), {
        code: 'VERTICAL_CLOSED',
      });
      await sql`UPDATE vertical SET status='partners' WHERE code='entertainment'`;
      const [removed] =
        await sql`DELETE FROM rentable_rate WHERE rentable_id=${id} AND category_id=(SELECT id FROM category WHERE slug='box-cricket') AND day_kind='weekend' AND start_minute=960 RETURNING *`;
      assert.equal((await inventory()).bookable, false);
      await assert.rejects(
        submitProperty(sql, { id, clientId: venue.owner }),
        (e) => e.statusCode === 422,
      );
      await sql`INSERT INTO rentable_rate ${sql(removed)}`;
      const { submissionId } = await submitProperty(sql, { id, clientId: venue.owner });
      await decidePropertyReview(sql, {
        id,
        adminId: venue.admin,
        input: {
          submissionId,
          outcome: 'approved_for_visit',
          reason: 'Venue content and documents checked.',
        },
      });
      const scheduledAt = `${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}T11:00`;
      const visit = await scheduleVerification(sql, {
        id,
        adminId: venue.admin,
        input: { submissionId, mode: 'video_call', scheduledAt },
      });
      const input = {
        expectedVersion: visit.version,
        outcome: 'passed',
        findings: 'All three courts, safety equipment and evening lighting verified.',
        checklist: CHECKLIST.map(([key]) => key),
      };
      await assert.rejects(
        recordVerificationOutcome(sql, { id, adminId: venue.admin, visitId: visit.visitId, input }),
        (e) => e.statusCode === 422,
      );
      await recordVerificationOutcome(sql, {
        id,
        adminId: venue.admin,
        visitId: visit.visitId,
        input: { ...input, checklist: VENUE_CHECKLIST.map(([key]) => key) },
      });
      const published = await publishProperty(sql, {
        id,
        adminId: venue.admin,
        input: { submissionId },
      });
      assert.equal(published.status, 'live');
      assert.equal(published.inventory.bookable, true);
      await sql`UPDATE vertical SET status='public' WHERE code='entertainment'`;
      const { searchDiscovery, getDiscoveryRegistry } = await import('@/services/db/discovery.js');
      const { parseDiscoveryQuery } = await import('@/services/domain/discovery.js');
      const registry = await getDiscoveryRegistry(sql);
      const result = await searchDiscovery(
        parseDiscoveryQuery({ vertical: 'entertainment' }).filters,
        null,
        sql,
        registry,
      );
      assert.ok(JSON.stringify(result).includes('venue001'));

      // The courts editor learns which courts have upcoming bookings; removing one is refused by name.
      const { insertFixtureOrder } = await import('../helpers/fixture-order.js');
      const [customer] = await sql`INSERT INTO "user"(email,phone,role,account_status,name)
        VALUES ('player@fixture.invalid','9000000333','customer','active','Player') RETURNING id`;
      const orderId = await insertFixtureOrder(sql, { customerId: customer.id, rentableId: id });
      const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
      const start = new Date(`${day}T21:00:00+05:30`).toISOString();
      const end = new Date(`${day}T22:00:00+05:30`).toISOString();
      const [cricket] = await sql`SELECT id FROM category WHERE slug='box-cricket'`;
      const [booked] =
        await sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,local_day,slot,resource_id,guests,state,
          starts_at,ends_at,blocked_start_at,blocked_end_at,hours_known,currency,time_zone,amount_rent_minor,amount_fee_minor,amount_deposit_minor,slot_snapshot)
        VALUES ('TVENUEFLOW00001',${id},${customer.id},${orderId},1,${day},'hourly',${venue.court1},6,'confirmed',
          ${start},${end},${start},${end},true,'INR','Asia/Kolkata',120000,9600,0,
          ${JSON.stringify({ activity: { id: cricket.id, slug: 'box-cricket', name: 'Box cricket' }, startMinute: 1260, durationMinutes: 60 })}::text::jsonb) RETURNING id`;
      await sql`INSERT INTO inventory_reservation(booking_id,rentable_id,resource_id,source,blocked_start_at,blocked_end_at,state)
        VALUES (${booked.id},${id},${venue.court1},'booking',${start},${end},'committed')`;
      const { getListingForEdit } = await import('@/services/db/listing-queries.js');
      const edit = await getListingForEdit(id, venue.owner);
      assert.deepEqual(
        edit.resources.map((r) => [r.name, r.upcomingBookings]),
        [
          ['Court 1', 1],
          ['Court 2', 0],
          ['Pickleball 1', 0],
        ],
      );
      const { saveVenueResources } = await import('@/services/booking/venue.js');
      const keep = edit.resources
        .filter((r) => r.name !== 'Court 1')
        .map(({ id: rid, name, capacity, isIndoor, details, activities, sortOrder, isActive }) => ({
          id: rid,
          name,
          capacity,
          isIndoor,
          details,
          activities,
          sortOrder,
          isActive,
        }));
      await assert.rejects(
        saveVenueResources(sql, venue.owner, {
          rentableId: id,
          expectedVersion: edit.listing.contentVersion,
          resources: keep,
        }),
        (e) => e.code === 'RESOURCE_HAS_BOOKINGS' && e.message.startsWith('Court 1:'),
      );
    } finally {
      delete globalThis.__rentraSql;
      await fixture.drop();
    }
  },
);
