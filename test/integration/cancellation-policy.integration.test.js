import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { seedHotel } from '../helpers/hotel-fixture.js';
import { addLocalDays, propertyToday } from '../../src/services/domain/booking-dates.js';
import { hotelRefund } from '../../src/services/domain/hotel.js';
import { CANCELLATION_PRESETS } from '../../src/services/domain/cancellation-policy.js';

const H = 3_600_000;
const windows = (rows, atOrAfterCheckInPct = 0, earlyDeparture = { offered: false, pct: 0 }) => ({
  version: 1,
  windows: rows.map(([hoursBefore, pct]) => ({ hoursBefore, pct })),
  atOrAfterCheckInPct,
  earlyDeparture,
});

test(
  'Story 2.6 cancellation policy: owner windows, preview/version guards, hotel default and plan overrides',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      Object.assign(process.env, { DATABASE_URL: fixture.url, NODE_ENV: 'test' });
      globalThis.__rentraSql = sql;
      const { changePropertyPolicy } = await import('@/services/booking/property-policy.js');
      const { saveHotelRates, hotelForEdit } = await import('@/services/booking/hotel-setup.js');
      const { quoteHotelStay } = await import('@/services/booking/hotel-stays.js');

      // Farmhouse: the owner saves custom windows through the existing preview + version contract.
      const f = await seedReviewFixture(sql);
      const policy = windows(
        [
          [96, 100],
          [24, 60],
          [0, 20],
        ],
        0,
        { offered: true, pct: 0 },
      );
      const version = async () =>
        (await sql`SELECT content_version FROM rentable WHERE id=${f.listing}`)[0].content_version;
      const terms = {
        depositAmount: 0,
        cancellationTier: 'moderate',
        cancellationPolicy: JSON.stringify(policy),
      };
      await assert.rejects(
        changePropertyPolicy(sql, f.other, f.listing, 'terms', {
          values: terms,
          expectedVersion: await version(),
          preview: true,
        }),
        { statusCode: 404 },
      );
      await assert.rejects(
        changePropertyPolicy(sql, f.owner, f.listing, 'terms', {
          values: { ...terms, cancellationPolicy: JSON.stringify(windows([[24, 100]])) },
          expectedVersion: await version(),
          preview: true,
        }),
        { statusCode: 422 },
        'a gap before check-in is refused',
      );
      await assert.rejects(
        changePropertyPolicy(sql, f.owner, f.listing, 'terms', {
          values: terms,
          expectedVersion: (await version()) - 1,
          preview: true,
        }),
        { code: 'LISTING_CHANGED' },
      );
      const preview = await changePropertyPolicy(sql, f.owner, f.listing, 'terms', {
        values: terms,
        expectedVersion: await version(),
        preview: true,
      });
      assert.deepEqual(preview.preview.after.cancellationPolicy, policy);
      await assert.rejects(
        changePropertyPolicy(sql, f.owner, f.listing, 'terms', {
          values: terms,
          expectedVersion: await version(),
          previewToken: 'x',
        }),
        { code: 'PREVIEW_REQUIRED' },
      );
      await changePropertyPolicy(sql, f.owner, f.listing, 'terms', {
        values: terms,
        expectedVersion: await version(),
        previewToken: preview.preview.token,
      });
      const [stored] =
        await sql`SELECT cancellation_policy, jsonb_typeof(cancellation_policy) AS kind FROM rentable WHERE id=${f.listing}`;
      assert.equal(stored.kind, 'object');
      assert.deepEqual(stored.cancellation_policy.windows, policy.windows);
      const [audited] =
        await sql`SELECT after FROM audit_log WHERE action='property_terms_changed' AND entity_id=${f.listing}`;
      assert.deepEqual(audited.after.values.cancellationPolicy, policy);

      // Hotel: a default for every rate; one rate keeps its own (non-refundable); a breakfast rate needs no copy.
      const h = await seedHotel(sql);
      const edit = (await hotelForEdit(sql, h.hotel)).hotel;
      const hotelDefault = windows([
        [48, 100],
        [0, 30],
      ]);
      const plans = edit.ratePlans.map((p, i) => ({
        id: p.id,
        roomTypeId: p.roomTypeId,
        name: p.name,
        mealPlan: p.mealPlan,
        derivedFrom: p.derivedFrom,
        weekday: p.weekday,
        weekend: p.weekend,
        adjustPct: p.adjustPct,
        perGuest: p.perGuest,
        cancellation: i === 0 ? 'default' : 'non_refundable',
        minNights: p.minNights,
        sortOrder: p.sortOrder,
        isActive: p.isActive,
      }));
      const hotelVersion = async () =>
        (await sql`SELECT content_version FROM rentable WHERE id=${h.hotel}`)[0].content_version;
      await saveHotelRates(sql, h.owner, {
        rentableId: h.hotel,
        expectedVersion: await hotelVersion(),
        plans,
        defaultPolicy: hotelDefault,
      });
      const after = (await hotelForEdit(sql, h.hotel)).hotel;
      assert.deepEqual(after.cancellationPolicy.windows, hotelDefault.windows);
      assert.equal(after.ratePlans[0].cancellation, 'default');
      assert.equal(after.ratePlans[0].cancellationPolicy, null);
      if (after.ratePlans[1]) assert.equal(after.ratePlans[1].cancellation, 'non_refundable');
      await assert.rejects(
        saveHotelRates(sql, h.owner, {
          rentableId: h.hotel,
          expectedVersion: (await hotelVersion()) - 1,
          plans,
        }),
      );

      // A quote snapshots each room's effective policy: the default rate inherits the hotel default.
      const checkIn = addLocalDays(propertyToday(), 10);
      const quote = await quoteHotelStay(sql, {
        rentableId: h.hotel,
        checkIn,
        checkOut: addLocalDays(checkIn, 2),
        rooms: [
          { roomTypeId: plans[0].roomTypeId, ratePlanId: plans[0].id, adults: 2, childAges: [] },
        ],
      });
      assert.deepEqual(quote.lines[0].plan.cancellationPolicy.windows, hotelDefault.windows);

      // Mixed rooms keep their own booked policy; an exact cutoff takes the later window.
      const checkInAt = new Date(Date.UTC(2030, 0, 10, 8, 30));
      const roomA = {
        totalMinor: 10_000,
        nights: [{ rateMinor: 5_000, taxMinor: 0 }],
        plan: { cancellationPolicy: hotelDefault },
      };
      const roomB = {
        totalMinor: 10_000,
        nights: [{ rateMinor: 5_000, taxMinor: 0 }],
        plan: { cancellationPolicy: CANCELLATION_PRESETS.night.non_refundable },
      };
      const at = (hours) => new Date(+checkInAt - hours * H);
      assert.equal(hotelRefund(roomA, checkInAt, at(49)).refundMinor, 10_000);
      assert.equal(
        hotelRefund(roomA, checkInAt, at(48)).refundMinor,
        3_000,
        'exact cutoff → at/after window',
      );
      assert.equal(hotelRefund(roomB, checkInAt, at(49)).refundMinor, 0);
      assert.throws(
        () => hotelRefund(roomA, checkInAt, at(0)),
        { code: 'STAY_STARTED' },
        'at check-in the at/after 0% applies',
      );
      const lateRoom = { ...roomA, plan: { cancellationPolicy: windows([[0, 0]], 40) } };
      assert.equal(
        hotelRefund(lateRoom, checkInAt, at(-2)).refundMinor,
        4_000,
        'owner at/after-check-in %',
      );
      assert.throws(
        () => hotelRefund(roomB, checkInAt, at(-1)),
        { code: 'STAY_STARTED' },
        'no-show alone refunds nothing',
      );
    } finally {
      await fixture.drop();
    }
  },
);
