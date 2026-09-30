import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { insertFixtureOrder } from '../helpers/fixture-order.js';
import { searchDiscovery } from '../../src/services/db/discovery.js';
import { parseDiscoveryQuery } from '../../src/services/domain/discovery.js';
import { addLocalDays, propertyToday } from '../../src/services/domain/booking-dates.js';

const violates = (promise, constraint) =>
  assert.rejects(
    promise,
    (error) => error.constraint_name === constraint || error.message.includes(constraint),
  );

test(
  'schema consolidation invariants (migrations 0041-0051) and date search',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      const f = await seedReviewFixture(sql);
      const [customer] =
        await sql`INSERT INTO "user"(phone,role,account_status) VALUES ('9000000055','customer','active') RETURNING id`;

      // Role-checked FKs: a client can never own an order, a customer never a listing.
      await violates(
        insertFixtureOrder(sql, { customerId: f.owner, rentableId: f.listing }),
        'booking_order_customer_role_fk',
      );
      await violates(
        sql`UPDATE rentable SET client_id=${customer.id} WHERE id=${f.listing}`,
        'rentable_client_role_fk',
      );
      // Role-specific columns stay on their role.
      await violates(
        sql`UPDATE "user" SET kyc_status='verified' WHERE id=${customer.id}`,
        'user_client_fields_chk',
      );

      // Every visit belongs to an order; who cancelled is a known kind.
      const order = await insertFixtureOrder(sql, {
        customerId: customer.id,
        rentableId: f.listing,
      });
      const visit = (position, patch = {}) =>
        sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,local_day,slot,state,currency,time_zone,
            amount_rent_minor,amount_fee_minor,amount_deposit_minor,cancelled_by_kind)
          VALUES (${`SI-${position}`},${f.listing},${customer.id},${patch.order === undefined ? order : patch.order},${position},
            current_date + ${position}::int,'day',${patch.kind ? 'cancelled' : 'confirmed'},'INR','Asia/Kolkata',100000,8000,0,${patch.kind ?? null}) RETURNING id`;
      await assert.rejects(visit(1, { order: null }), /null value in column "order_id"/);
      await violates(visit(2, { kind: 'robot' }), 'booking_cancelled_by_kind_chk');
      await visit(3, { kind: 'admin' });

      // Documents: one live file per slot; a superseded version may coexist.
      const doc = (status) =>
        sql`INSERT INTO document(owner_type,owner_id,doc_type,storage_key,status)
          VALUES ('rentable',${f.listing},'sale_deed',${`fixture/${status}`},${status})`;
      await doc('superseded');
      await doc('uploaded');
      await violates(doc('accepted'), 'document_live_slot_idx');
      await violates(
        sql`INSERT INTO document(owner_type,owner_id,doc_type,storage_key) VALUES ('rentable',${customer.id},'noc','fixture/orphan')`,
        'document_rentable_fk',
      );

      // Customer sessions live in auth_session and are revoked when the account is blocked.
      const [session] =
        await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${customer.id},now()+interval '1 day') RETURNING id`;
      await sql`UPDATE "user" SET account_status='blocked' WHERE id=${customer.id}`;
      const [revoked] = await sql`SELECT revoked_at FROM auth_session WHERE id=${session.id}`;
      assert.ok(revoked.revoked_at, 'blocking a customer revokes their session');

      // Date search: the SQL prefilter keeps only listings with every requested date open.
      const today = propertyToday();
      const open = addLocalDays(today, 5);
      await sql`UPDATE rentable SET status='live', booking_config=${JSON.stringify({
        inventoryReady: true,
        timeZone: 'Asia/Kolkata',
        leadTimeMinutes: 0,
        bookingHorizonDays: 90,
        slots: {
          day: {
            enabled: true,
            startTime: '09:00',
            endTime: '18:00',
            endDayOffset: 0,
            bufferBeforeMinutes: 0,
            bufferAfterMinutes: 0,
            capacity: 12,
            includedGuests: 12,
            extraGuestChargeMinor: 0,
          },
          night: { enabled: false },
          full_day: { enabled: false },
        },
      })}::text::jsonb WHERE id=${f.listing}`;
      await sql`INSERT INTO availability(rentable_id,day,slot,units_available) VALUES (${f.listing},${open},'day',1)`;
      const search = async (dates) =>
        (
          await searchDiscovery(
            parseDiscoveryQuery({ slot: 'day', guests: '2', dates }, today).filters,
            null,
            sql,
          )
        ).total;
      assert.equal(await search(open), 1, 'an open date finds the listing');
      assert.equal(
        await search(addLocalDays(today, 6)),
        0,
        'a date never opened is filtered before quoting',
      );
    } finally {
      await fixture.drop();
    }
  },
);
