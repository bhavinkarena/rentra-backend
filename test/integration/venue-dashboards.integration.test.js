import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedVenue } from '../helpers/venue-fixture.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { insertFixtureOrder } from '../helpers/fixture-order.js';
import { propertyToday, addLocalDays } from '../../src/services/domain/booking-dates.js';

/**
 * Entertainment plan, Phase 11: one owner with a farmhouse and a venue sees both
 * in every list, can tell from the list when a court booking starts and which
 * court it uses, and can filter by kind of place or court. The drizzle pool
 * reads DATABASE_URL at import, so it is pointed at this file's database first.
 */
let fixture, sql, v, farm, customer, venueOrder, farmOrder;
const skip = !process.env.PORTAL_TEST_DATABASE_URL;

async function visit(orderId, rentableId, { slot, resourceId = null, startsAt, snapshot = null }) {
  const start = new Date(startsAt);
  const end = new Date(start.getTime() + 3600000);
  await sql.begin(async (tx) => {
    // Fixture-only: write the accepted snapshot a hold would have written.
    await tx`SET LOCAL session_replication_role=replica`;
    await tx`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,local_day,slot,
      resource_id,guests,state,starts_at,ends_at,blocked_start_at,blocked_end_at,hours_known,currency,time_zone,
      amount_rent_minor,amount_fee_minor,amount_deposit_minor,slot_snapshot)
      VALUES (${'T' + randomUUID().replaceAll('-', '').slice(0, 15)},${rentableId},${customer},${orderId},1,
        ${addLocalDays(propertyToday(start), 0)},${slot},${resourceId},4,'confirmed',${start.toISOString()},${end.toISOString()},
        ${start.toISOString()},${end.toISOString()},true,'INR','Asia/Kolkata',100000,8000,0,${sql.json(snapshot ?? {})})`;
  });
}

before(async () => {
  if (skip) return;
  fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
  sql = fixture.sql;
  process.env.DATABASE_URL = fixture.url;
  v = await seedVenue(sql);
  const f = await seedReviewFixture(sql);
  farm = f.listing;
  // One owner with both kinds of place.
  await sql`UPDATE rentable SET client_id=${v.owner}, status='live' WHERE id=${farm}`;
  const [c] =
    await sql`INSERT INTO "user"(email,phone,role,account_status,name) VALUES ('dash@fixture.invalid','9000005511','customer','active','Dash') RETURNING id`;
  customer = c.id;
  const at = new Date(`${addLocalDays(propertyToday(), 5)}T19:00:00+05:30`);
  venueOrder = await insertFixtureOrder(sql, {
    customerId: customer,
    rentableId: v.venue,
    title: 'Smash Arena',
  });
  await visit(venueOrder, v.venue, {
    slot: 'hourly',
    resourceId: v.court2,
    startsAt: at,
    snapshot: {
      resourceName: 'Court 2',
      activity: { slug: 'box-cricket', name: 'Box cricket' },
      durationMinutes: 60,
    },
  });
  farmOrder = await insertFixtureOrder(sql, {
    customerId: customer,
    rentableId: farm,
    title: 'Review River Farm',
  });
  await visit(farmOrder, farm, { slot: 'day', startsAt: new Date(at.getTime() + 86400000) });
});

after(async () => {
  if (skip) return;
  const { sql: pool } = await import('@/config/database.js');
  await pool.end({ timeout: 5 }).catch(() => {});
  await fixture.drop();
});

test(
  'Phase 11: owner and customer booking lists show court time, kinds and court filters',
  { skip },
  async () => {
    const { listBookingRecords } = await import('../../src/services/booking/records.js');
    const owner = { kind: 'owner', id: v.owner };
    const all = await listBookingRecords(sql, owner, {});
    assert.deepEqual(all.verticals, ['entertainment', 'farmhouse']);
    const court = all.items.find((i) => i.id === venueOrder);
    assert.equal(court.firstVisitSlot, 'hourly');
    assert.match(court.firstVisitLabel, /· 7:00 pm – 8:00 pm · Court 2 · Box cricket$/);
    assert.equal(court.resourceName, 'Court 2');
    assert.equal(court.vertical, 'entertainment');
    assert.equal(all.items.find((i) => i.id === farmOrder).firstVisitSlot, 'day');

    const venues = await listBookingRecords(sql, owner, { vertical: 'entertainment' });
    assert.deepEqual(
      venues.items.map((i) => i.id),
      [venueOrder],
    );
    const farms = await listBookingRecords(sql, owner, { vertical: 'farmhouse' });
    assert.deepEqual(
      farms.items.map((i) => i.id),
      [farmOrder],
    );

    const byCourt = (resource) => listBookingRecords(sql, owner, { property: v.venue, resource });
    const courtTwo = await byCourt(v.court2);
    assert.deepEqual(
      courtTwo.items.map((i) => i.id),
      [venueOrder],
    );
    assert.deepEqual(
      courtTwo.resources.map((r) => r.name),
      ['Court 1', 'Court 2', 'Pickleball 1'],
    );
    assert.equal((await byCourt(v.court1)).items.length, 0);
    // A court filter without a property is ignored rather than leaking across listings.
    assert.equal((await listBookingRecords(sql, owner, { resource: v.court1 })).items.length, 2);

    // Another owner cannot list this venue's courts.
    const [other] =
      await sql`INSERT INTO "user"(email,role,account_status,name) VALUES ('other-dash@fixture.invalid','client','active','Other') RETURNING id`;
    const foreign = await listBookingRecords(
      sql,
      { kind: 'owner', id: other.id },
      { property: v.venue },
    );
    assert.deepEqual([foreign.items.length, foreign.resources.length], [0, 0]);
  },
);

test(
  'Phase 11: owner listings show courts and players, filter by kind, and venues open by weekly hours',
  { skip },
  async () => {
    const { getClientListingsPage, getClientListingSummary } =
      await import('../../src/services/db/listing-queries.js');
    const venues = await getClientListingsPage(v.owner, { vertical: 'entertainment' });
    assert.equal(venues.total, 1);
    assert.deepEqual(
      [
        venues.items[0].rentalUnit,
        venues.items[0].resourceCount,
        venues.items[0].maxPlayers,
        venues.items[0].vertical,
      ],
      ['hour', 3, 12, 'entertainment'],
    );
    assert.equal((await getClientListingsPage(v.owner, {})).total, 2);
    assert.deepEqual((await getClientListingSummary(v.owner)).verticals, [
      'entertainment',
      'farmhouse',
    ]);

    const { ownerPropertyOverview } = await import('../../src/services/auth/property-overview.js');
    const overview = await ownerPropertyOverview(sql, v.owner, v.venue);
    // The fixture venue opens every day, so the next open day is today.
    assert.equal(overview.inventory.nextOpenDate, propertyToday());
  },
);

test(
  'Phase 11: a caretaker pages the Today list by day and venue visits carry the court label',
  { skip },
  async () => {
    const { listStaffVisits } = await import('../../src/services/booking/staff-visits.js');
    const [staff] =
      await sql`INSERT INTO client_staff(client_id,phone,name) VALUES (${v.owner},'9000005599','Caretaker') RETURNING id`;
    await sql`INSERT INTO staff_property(staff_id,rentable_id) VALUES (${staff.id},${v.venue})`;
    const actor = { id: staff.id, ownerId: v.owner };
    const day = addLocalDays(propertyToday(), 5);
    const today = await listStaffVisits(sql, actor, {});
    assert.deepEqual([today.date, today.items.length], [propertyToday(), 0]);
    const thatDay = await listStaffVisits(sql, actor, { date: day });
    assert.equal(thatDay.date, day);
    assert.equal(thatDay.items.length, 1);
    assert.match(thatDay.items[0].label, /7:00 pm – 8:00 pm · Court 2 · Box cricket$/);
    // A malformed date falls back to today rather than failing.
    assert.equal((await listStaffVisits(sql, actor, { date: '2026-13-99' })).date, propertyToday());
  },
);
