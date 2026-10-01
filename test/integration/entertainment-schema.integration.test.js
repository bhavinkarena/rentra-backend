import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase, migrateWithDrizzle } from '../helpers/disposable-db.js';
import { insertFixtureOrder } from '../helpers/fixture-order.js';
import { readIncident } from '../../src/services/operations/incidents.js';

/**
 * Entertainment plan, Phase 3. Builds the schema as it is in production today
 * (through 0051), adds farmhouse data, then applies 0052+ with the real
 * drizzle migrator in ONE transaction, as `npm run db:migrate` does. Enum
 * values used in the same transaction that added them fail with 55P04, and the
 * per-file helper alone would hide that.
 */
const HEAD = '0051_worker_performance';
const journal = JSON.parse(
  await readFile(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
);
const headWhen = journal.entries.find((e) => e.tag === HEAD).when;

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    return true;
  });
}

async function seedFarmhouse(sql) {
  const [owner] = await sql`INSERT INTO "user"(email,role,account_status,name)
    VALUES (${`owner-${randomUUID()}@fixture.invalid`},'client','active','Owner') RETURNING id`;
  const [city] =
    await sql`INSERT INTO city(slug,name,state) VALUES ('surat','Surat','Gujarat') RETURNING id`;
  const [area] =
    await sql`INSERT INTO area(city_id,slug,name) VALUES (${city.id},'vesu','Vesu') RETURNING id`;
  const [category] =
    await sql`INSERT INTO category(slug,name) VALUES ('farmhouse','Farmhouse') RETURNING id`;
  const [amenity] =
    await sql`INSERT INTO amenity(slug,group_slug,label_en) VALUES ('parking','practical','Parking') RETURNING id`;
  const [farm] =
    await sql`INSERT INTO rentable(client_id,slug,title,category_id,city_id,area_id,public_code)
    VALUES (${owner.id},'river-farm','River Farm',${category.id},${city.id},${area.id},'farm0001') RETURNING id`;
  await sql`INSERT INTO rentable_amenity(rentable_id,amenity_id) VALUES (${farm.id},${amenity.id})`;
  await sql`INSERT INTO inventory_reservation(rentable_id,source,blocked_start_at,blocked_end_at,state,created_by,reason)
    VALUES (${farm.id},'owner_block','2030-01-01T04:00Z','2030-01-01T10:00Z','committed',${owner.id},'Family visit')`;
  return {
    owner: owner.id,
    city: city.id,
    area: area.id,
    category: category.id,
    amenity: amenity.id,
    farm: farm.id,
  };
}

function block(sql, { rentableId, resourceId = null, from, to, owner }) {
  return sql`INSERT INTO inventory_reservation(rentable_id,resource_id,source,blocked_start_at,blocked_end_at,state,created_by,reason)
    VALUES (${rentableId},${resourceId},'owner_block',${from},${to},'committed',${owner},'Maintenance') RETURNING id`;
}

async function insertVisit(
  sql,
  {
    orderId,
    customerId,
    rentableId,
    slot,
    resourceId = null,
    startsAt,
    minutes = 60,
    position = 1,
  },
) {
  const start = new Date(startsAt);
  const end = new Date(start.getTime() + minutes * 60000);
  const [row] =
    await sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,local_day,slot,
      resource_id,guests,state,starts_at,ends_at,blocked_start_at,blocked_end_at,hours_known,currency,time_zone,
      amount_rent_minor,amount_fee_minor,amount_deposit_minor)
    VALUES (${'T' + randomUUID().replaceAll('-', '').slice(0, 15)},${rentableId},${customerId},${orderId},${position},
      ${start.toISOString().slice(0, 10)},${slot},${resourceId},4,'confirmed',${start.toISOString()},${end.toISOString()},
      ${start.toISOString()},${end.toISOString()},true,'INR','Asia/Kolkata',100000,8000,0) RETURNING id`;
  return row.id;
}

test(
  'Phase 3: 0052-0054 apply in one drizzle transaction and enforce verticals, courts and per-court double booking',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL, {
      through: HEAD,
    });
    const { sql } = fixture;
    try {
      const f = await seedFarmhouse(sql);
      await migrateWithDrizzle(fixture.url, headWhen);

      // Backfill: everything that existed is farmhouse, nothing public changed.
      assert.deepEqual(
        (await sql`SELECT code,status FROM vertical ORDER BY sort_order`).map((r) => [
          r.code,
          r.status,
        ]),
        [
          ['farmhouse', 'public'],
          ['entertainment', 'hidden'],
        ],
      );
      const [cat] = await sql`SELECT vertical_code,icon_key FROM category WHERE id=${f.category}`;
      assert.deepEqual({ ...cat }, { vertical_code: 'farmhouse', icon_key: 'farmhouse' });
      const [{ count: mapped }] =
        await sql`SELECT count(*)::int FROM amenity_vertical WHERE vertical_code='farmhouse'`;
      assert.equal(mapped, 1);
      const enums =
        await sql`SELECT t.typname, e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
        WHERE (t.typname,e.enumlabel) IN (('rental_unit','hour'),('booking_slot','hourly'),('document_type','rent_agreement'))`;
      assert.equal(enums.length, 3);

      // Farmhouse double booking is still refused exactly as before (NULL resource = whole listing).
      await rejects(
        block(sql, {
          rentableId: f.farm,
          from: '2030-01-01T09:00Z',
          to: '2030-01-01T12:00Z',
          owner: f.owner,
        }),
        '23P01',
      );

      // An entertainment venue with two courts.
      const [cricket] =
        await sql`INSERT INTO category(slug,name,vertical_code,default_rental_unit,icon_key)
        VALUES ('box-cricket','Box cricket','entertainment','hour','cricket') RETURNING id`;
      await rejects(
        sql`INSERT INTO rentable(client_id,slug,title,category_id,city_id,area_id,public_code)
          VALUES (${f.owner},'wrong-model','Wrong model',${cricket.id},${f.city},${f.area},'wrong001')`,
        '23514',
      );
      const [venue] =
        await sql`INSERT INTO rentable(client_id,slug,title,category_id,city_id,area_id,public_code,rental_unit)
        VALUES (${f.owner},'smash-arena','Smash Arena',${cricket.id},${f.city},${f.area},'venue001','hour') RETURNING id,content_version`;
      const [court1] =
        await sql`INSERT INTO rentable_resource(rentable_id,name,capacity) VALUES (${venue.id},'Court 1',12) RETURNING id`;
      const [court2] =
        await sql`INSERT INTO rentable_resource(rentable_id,name,capacity) VALUES (${venue.id},'Court 2',12) RETURNING id`;
      await rejects(
        sql`INSERT INTO rentable_resource(rentable_id,name,capacity) VALUES (${venue.id},'court 1',8)`,
        '23505',
      );
      await sql`INSERT INTO rentable_resource_activity(resource_id,rentable_id,category_id) VALUES (${court1.id},${venue.id},${cricket.id})`;
      await rejects(
        sql`INSERT INTO rentable_resource_activity(resource_id,rentable_id,category_id) VALUES (${court2.id},${venue.id},${f.category})`,
        '23514',
      );
      const [{ content_version: bumped }] =
        await sql`SELECT content_version FROM rentable WHERE id=${venue.id}`;
      assert.ok(bumped > venue.content_version, 'resource changes version the listing');

      // A farmhouse cannot have courts, and a court cannot belong to another listing.
      const [farmCourt] =
        await sql`INSERT INTO rentable_resource(rentable_id,name,capacity) VALUES (${f.farm},'Lawn',10) RETURNING id`;
      await rejects(
        sql`INSERT INTO rentable_resource_activity(resource_id,rentable_id,category_id) VALUES (${farmCourt.id},${f.farm},${cricket.id})`,
        '23514',
      );
      await rejects(
        block(sql, {
          rentableId: f.farm,
          resourceId: court1.id,
          from: '2030-02-01T10:00Z',
          to: '2030-02-01T11:00Z',
          owner: f.owner,
        }),
        '23503',
      );

      // Per-court lock: same court overlapping is refused, the other court is free.
      await block(sql, {
        rentableId: venue.id,
        resourceId: court1.id,
        from: '2030-02-01T10:00Z',
        to: '2030-02-01T11:00Z',
        owner: f.owner,
      });
      await rejects(
        block(sql, {
          rentableId: venue.id,
          resourceId: court1.id,
          from: '2030-02-01T10:30Z',
          to: '2030-02-01T11:30Z',
          owner: f.owner,
        }),
        '23P01',
      );
      await block(sql, {
        rentableId: venue.id,
        resourceId: court2.id,
        from: '2030-02-01T10:00Z',
        to: '2030-02-01T11:00Z',
        owner: f.owner,
      });
      await block(sql, {
        rentableId: venue.id,
        resourceId: court1.id,
        from: '2030-02-01T11:00Z',
        to: '2030-02-01T12:00Z',
        owner: f.owner,
      });
      // Operations monitor: two courts busy at the same time is not a double booking.
      const admin = randomUUID();
      await sql`INSERT INTO admin_user(id,email,password_hash,name) VALUES (${admin},'ops@fixture.invalid','fixture','Ops')`;
      assert.equal((await readIncident(sql, admin, 'overlapping_inventory')).count, 0);
      // Venue-wide closures vs courts are the application's job under the listing mutex (documented in the plan)...
      await block(sql, {
        rentableId: venue.id,
        from: '2030-02-01T10:00Z',
        to: '2030-02-01T11:00Z',
        owner: f.owner,
      });
      // ...so the monitor must report one if it ever slips through.
      assert.ok((await readIncident(sql, admin, 'overlapping_inventory')).count >= 1);

      // Listings never change vertical or booking model behind their category's back.
      await rejects(
        sql`UPDATE rentable SET category_id=${cricket.id}, rental_unit='hour' WHERE id=${f.farm}`,
        '23514',
      );
      await rejects(sql`UPDATE rentable SET rental_unit='hour' WHERE id=${f.farm}`, '23514');

      // Amenities are scoped by vertical.
      await rejects(
        sql`INSERT INTO rentable_amenity(rentable_id,amenity_id) VALUES (${venue.id},${f.amenity})`,
        '23514',
      );
      await sql`INSERT INTO amenity_vertical(amenity_id,vertical_code) VALUES (${f.amenity},'entertainment')`;
      await sql`INSERT INTO rentable_amenity(rentable_id,amenity_id) VALUES (${venue.id},${f.amenity})`;

      // Rate bands per activity and day kind cannot overlap; venues may price past midnight.
      await sql`INSERT INTO rentable_rate(rentable_id,category_id,day_kind,start_minute,end_minute,hourly_rate_minor)
        VALUES (${venue.id},${cricket.id},'weekday',360,1080,80000),(${venue.id},${cricket.id},'weekday',1080,1500,120000)`;
      await rejects(
        sql`INSERT INTO rentable_rate(rentable_id,category_id,day_kind,start_minute,end_minute,hourly_rate_minor)
          VALUES (${venue.id},${cricket.id},'weekday',1000,1100,90000)`,
        '23P01',
      );
      await rejects(
        sql`INSERT INTO rentable_rate(rentable_id,category_id,day_kind,start_minute,end_minute,hourly_rate_minor)
          VALUES (${venue.id},${cricket.id},'weekend',0,1801,90000)`,
        '23514',
      );

      // Hourly visits must name their court; slot visits must not.
      const [customer] = await sql`INSERT INTO "user"(email,phone,role,account_status,name)
        VALUES ('player@fixture.invalid','9000000088','customer','active','Player') RETURNING id`;
      const venueOrder = await insertFixtureOrder(sql, {
        customerId: customer.id,
        rentableId: venue.id,
      });
      const visit = { orderId: venueOrder, customerId: customer.id, rentableId: venue.id };
      await rejects(
        insertVisit(sql, { ...visit, slot: 'hourly', startsAt: '2030-03-01T12:30Z' }),
        '23514',
      );
      await insertVisit(sql, {
        ...visit,
        slot: 'hourly',
        resourceId: court1.id,
        startsAt: '2030-03-01T12:30Z',
      });
      const farmOrder = await insertFixtureOrder(sql, {
        customerId: customer.id,
        rentableId: f.farm,
      });
      await rejects(
        insertVisit(sql, {
          orderId: farmOrder,
          customerId: customer.id,
          rentableId: f.farm,
          slot: 'day',
          resourceId: farmCourt.id,
          startsAt: '2030-03-01T03:30Z',
        }),
        '23514',
      );

      // Reminders: hourly 2 hours ahead, none right after a same-day confirmation; farmhouse unchanged at 24 hours.
      const soon = new Date(Date.now() + 60 * 60000).toISOString();
      const later = new Date(Date.now() + 3 * 86400000).toISOString();
      const sameDayOrder = await insertFixtureOrder(sql, {
        customerId: customer.id,
        rentableId: venue.id,
      });
      await insertVisit(sql, {
        orderId: sameDayOrder,
        customerId: customer.id,
        rentableId: venue.id,
        slot: 'hourly',
        resourceId: court2.id,
        startsAt: soon,
      });
      const aheadOrder = await insertFixtureOrder(sql, {
        customerId: customer.id,
        rentableId: venue.id,
      });
      const ahead = await insertVisit(sql, {
        orderId: aheadOrder,
        customerId: customer.id,
        rentableId: venue.id,
        slot: 'hourly',
        resourceId: court2.id,
        startsAt: later,
      });
      const stayOrder = await insertFixtureOrder(sql, {
        customerId: customer.id,
        rentableId: f.farm,
      });
      const stay = await insertVisit(sql, {
        orderId: stayOrder,
        customerId: customer.id,
        rentableId: f.farm,
        slot: 'day',
        startsAt: later,
        minutes: 600,
      });
      for (const orderId of [sameDayOrder, aheadOrder, stayOrder])
        await sql`INSERT INTO booking_lifecycle_event(order_id,kind) VALUES (${orderId},'confirmed')`;
      const reminders =
        await sql`SELECT order_id,booking_id,scheduled_at FROM notification_outbox WHERE template='reminder'`;
      assert.equal(
        reminders.filter((r) => r.order_id === sameDayOrder).length,
        0,
        'no reminder right after a same-day confirmation',
      );
      const lead = (bookingId) => {
        const row = reminders.find((r) => r.booking_id === bookingId);
        return (new Date(later) - new Date(row.scheduled_at)) / 3600000;
      };
      assert.equal(lead(ahead), 2);
      assert.equal(lead(stay), 24);
    } finally {
      await fixture.drop();
    }
  },
);

test(
  'Phase 3: 0052 refuses to tag verticals when non-slot listings already exist',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL, {
      through: HEAD,
    });
    try {
      const f = await seedFarmhouse(fixture.sql);
      await fixture.sql`ALTER TABLE rentable DISABLE TRIGGER catalogue_rentable_reference_guard`;
      await fixture.sql`UPDATE rentable SET rental_unit='day' WHERE id=${f.farm}`;
      await assert.rejects(
        migrateWithDrizzle(fixture.url, headWhen),
        /0052: a rentable is not slot-booked/,
      );
      const [{ exists }] = await fixture.sql`SELECT to_regclass('vertical') IS NOT NULL AS exists`;
      assert.equal(exists, false, 'the whole release rolled back');
    } finally {
      await fixture.drop();
    }
  },
);
