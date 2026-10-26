import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedHotel } from '../helpers/hotel-fixture.js';
import { addLocalDays, propertyToday } from '../../src/services/domain/booking-dates.js';

/** Hotel plan, Phase 4: review with hotel corrections, hotel checklist, publication, commission rules and tax slabs. */
test(
  'Phase 4: hotel review, verification, publication, commission and tax administration',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async (t) => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    t.after(() => fixture.drop());
    const { sql } = fixture;
    globalThis.__rentraSql = sql;
    process.env.DATABASE_URL = fixture.url;
    const { submitProperty, decidePropertyReview } = await import('@/services/admin/listings.js');
    const {
      scheduleVerification,
      recordVerificationOutcome,
      publishProperty,
      publicationState,
      CHECKLIST,
      HOTEL_CHECKLIST,
      checklistFor,
    } = await import('@/services/admin/verification.js');
    const { commissionCommand, listCommissionRules, replaceTaxSlabs, listTaxSlabs } =
      await import('@/services/admin/hotel-finance.js');
    const { resolveCommission, getHotelAvailability } =
      await import('@/services/booking/hotel-stays.js');
    const rejects = (promise, code) =>
      assert.rejects(promise, (error) => {
        assert.equal(error.code, code, `${error.code}: ${error.message}`);
        return true;
      });

    const h = await seedHotel(sql, { status: 'draft' });
    const admin = { kind: 'admin', id: h.admin };
    const point = Buffer.alloc(25);
    point.writeUInt8(1, 0);
    point.writeUInt32LE(0x20000001, 1);
    point.writeUInt32LE(4326, 5);
    point.writeDoubleLE(72.8, 9);
    point.writeDoubleLE(21.2, 17);
    const [{ udt_name: geometry }] =
      await sql`SELECT udt_name FROM information_schema.columns WHERE table_name='rentable' AND column_name='location'`;
    if (geometry === 'geometry')
      await sql`UPDATE rentable SET location=ST_SetSRID(ST_MakePoint(72.8,21.2),4326) WHERE id=${h.hotel}`;
    else await sql`UPDATE rentable SET location=${point.toString('hex')} WHERE id=${h.hotel}`;
    const photos = Array.from({ length: 8 }, (_, i) => ({
      url: `/seed/hotel-${i}.jpg`,
      alt: `Photo ${i + 1}`,
    }));
    await sql`UPDATE rentable SET exact_address='12 Riverfront Road', description='A riverside hotel with enough words for a description.',
    title='Riverside Residency Adajan', photos=${JSON.stringify(photos)}::text::jsonb WHERE id=${h.hotel}`;
    await sql`UPDATE hotel_profile SET policies='{"stayAnswered":true,"couples":true,"localId":true,"idTypes":["aadhaar"],"gstAnswered":true}' WHERE rentable_id=${h.hotel}`;
    for (const slug of ['wifi', 'parking', 'lift']) {
      const [a] =
        await sql`INSERT INTO amenity(slug,group_slug,label_en) VALUES (${slug},'practical',${slug}) RETURNING id`;
      await sql`INSERT INTO amenity_vertical(amenity_id,vertical_code) VALUES (${a.id},'hotel')`;
      await sql`INSERT INTO rentable_amenity(rentable_id,amenity_id) VALUES (${h.hotel},${a.id})`;
    }
    await sql`INSERT INTO document(owner_type,owner_id,doc_type,storage_key,status) VALUES ('rentable',${h.hotel},'rent_agreement','fixture/lease','uploaded')`;
    await sql`UPDATE vertical SET status='partners' WHERE code='hotel'`;
    let submissionId;

    await t.test(
      'review: hotel sections can be flagged; resubmission; approval for a visit',
      async () => {
        const first = await submitProperty(sql, { id: h.hotel, clientId: h.owner });
        await decidePropertyReview(sql, {
          id: h.hotel,
          adminId: h.admin,
          input: {
            submissionId: first.submissionId,
            outcome: 'changes_requested',
            reason: 'Room photos do not show the family room.',
            flagged: ['rooms', 'rates', 'gst'],
          },
        });
        const [review] =
          await sql`SELECT flagged_fields FROM listing_review WHERE submission_id=${first.submissionId}`;
        assert.deepEqual(review.flagged_fields, ['rooms', 'rates', 'gst']);
        const { legacyStep } = await import('@/services/domain/listing-steps.js');
        assert.deepEqual(review.flagged_fields.map(legacyStep), ['space', 'pricing', 'ownership']);
        await sql`UPDATE room_type SET name='Deluxe King' WHERE id=${h.deluxe}`;
        const second = await submitProperty(sql, { id: h.hotel, clientId: h.owner });
        await decidePropertyReview(sql, {
          id: h.hotel,
          adminId: h.admin,
          input: {
            submissionId: second.submissionId,
            outcome: 'approved_for_visit',
            reason: 'Rooms, rates and documents checked.',
          },
        });
        assert.equal(
          (await sql`SELECT status FROM rentable WHERE id=${h.hotel}`)[0].status,
          'pending_verification',
        );
        submissionId = second.submissionId;
      },
    );

    await t.test(
      'verification uses the hotel checklist; publication needs bookable rooms',
      async () => {
        assert.deepEqual(checklistFor('night'), HOTEL_CHECKLIST);
        assert.ok(
          HOTEL_CHECKLIST.some(([key]) => key === 'roomsMatch') &&
            !HOTEL_CHECKLIST.some(([key]) => key === 'safeForGuests'),
        );
        const scheduledAt = `${addLocalDays(propertyToday(), 1)}T11:00`;
        const visit = await scheduleVerification(sql, {
          id: h.hotel,
          adminId: h.admin,
          input: { submissionId, mode: 'video_call', scheduledAt },
        });
        const input = {
          expectedVersion: visit.version,
          outcome: 'passed',
          findings: 'Walked every room type, fire exits and the guest register.',
          checklist: CHECKLIST.map(([key]) => key),
        };
        await assert.rejects(
          recordVerificationOutcome(sql, {
            id: h.hotel,
            adminId: h.admin,
            visitId: visit.visitId,
            input,
          }),
          (e) => e.statusCode === 422,
        );
        await recordVerificationOutcome(sql, {
          id: h.hotel,
          adminId: h.admin,
          visitId: visit.visitId,
          input: { ...input, checklist: HOTEL_CHECKLIST.map(([key]) => key) },
        });
        // An unpriced room type blocks publication with a hotel reason.
        // (Inside a rolled-back transaction: any rate change also makes the reviewed revision stale.)
        const ROLLBACK = new Error('rollback');
        await sql
          .begin(async (tx) => {
            await tx`UPDATE rate_plan SET is_active=false WHERE id=${h.standardBase}`;
            const blocked = await publicationState(tx, h.hotel);
            assert.ok(
              blocked.blockers.includes(
                'Not bookable yet: every room type needs a weekday and weekend price.',
              ),
              blocked.blockers.join(' | '),
            );
            throw ROLLBACK;
          })
          .catch((error) => {
            if (error !== ROLLBACK) throw error;
          });
        // Story 2.1: publication also needs an approved owner identity.
        await sql`INSERT INTO client_application(user_id,status) SELECT client_id,'approved' FROM rentable WHERE id=${h.hotel}
          ON CONFLICT (user_id) DO UPDATE SET status='approved'`;
        const published = await publishProperty(sql, {
          id: h.hotel,
          adminId: h.admin,
          input: { submissionId },
        });
        assert.equal(published.status, 'live');
        assert.equal(published.inventory.bookable, true);
        assert.equal(published.inventory.rooms, 5);
        const actions = (
          await sql`SELECT action FROM audit_log WHERE entity_id=${h.hotel} AND actor_type='admin' ORDER BY at`
        ).map((r) => r.action);
        assert.ok(actions.length >= 4, actions.join(','));
      },
    );

    await t.test(
      'commission rules are retired history: no new rule, existing rules can end (Story 2.2)',
      async () => {
        const tomorrow = addLocalDays(propertyToday(), 1);
        const base = {
          action: 'create',
          scope: 'vertical',
          ratePercent: '13',
          tier: 'standard',
          validFrom: tomorrow,
          reason: 'Standard hotel commission',
        };
        await rejects(
          commissionCommand(sql, admin, { ...base, preview: 'true' }),
          'COMMISSION_RETIRED',
        );
        await rejects(
          commissionCommand(sql, admin, {
            ...base,
            scope: 'city',
            cityId: h.city,
            preview: 'true',
          }),
          'COMMISSION_RETIRED',
        );
        // A rule from before the service fee stays visible and can still be ended.
        await sql`INSERT INTO commission_rule(vertical_code, city_id, rate_bps, tier, valid_from, reason, created_by)
        VALUES ('hotel', ${h.city}, 1000, 'founding', ${tomorrow}, 'Founding partners in Surat', ${h.admin})`;
        const list = await listCommissionRules(sql, admin);
        const cityRule = list.items.find((r) => r.scope === 'city');
        assert.equal(cityRule.rateBps, 1000);
        const end = {
          action: 'end',
          id: cityRule.id,
          validTo: addLocalDays(tomorrow, 30),
          reason: 'Founding period shortened',
        };
        const endPreview = await commissionCommand(sql, admin, { ...end, preview: 'true' });
        await commissionCommand(sql, admin, { ...end, previewHash: endPreview.previewHash });
        assert.equal(
          (await resolveCommission(sql, { rentableId: h.hotel, date: addLocalDays(tomorrow, 10) }))
            .rateBps,
          1000,
        );
        const [readOnly] =
          await sql`INSERT INTO admin_user(email,password_hash,name,permissions) VALUES ('ro@fixture.invalid','x','RO','["admin.payments.read"]'::jsonb) RETURNING id`;
        await rejects(
          commissionCommand(sql, { kind: 'admin', id: readOnly.id }, { ...end, preview: 'true' }),
          'FORBIDDEN',
        );
      },
    );

    await t.test(
      'tax slabs: replace from a future date; quotes after it use the new bands',
      async () => {
        const from = addLocalDays(propertyToday(), 20);
        const input = {
          effectiveFrom: from,
          bands: JSON.stringify([
            { upTo: 7500, taxPercent: 5 },
            { upTo: '', taxPercent: 12 },
          ]),
          reason: 'Test notification 99/2026',
        };
        await rejects(
          replaceTaxSlabs(sql, admin, {
            ...input,
            effectiveFrom: propertyToday(),
            preview: 'true',
          }),
          'VALIDATION_FAILED',
        );
        const preview = await replaceTaxSlabs(sql, admin, { ...input, preview: 'true' });
        assert.match(preview.effect, /₹7,501: 12%/);
        await replaceTaxSlabs(sql, admin, { ...input, previewHash: preview.previewHash });
        await rejects(
          replaceTaxSlabs(sql, admin, { ...input, previewHash: preview.previewHash }),
          'SLABS_SCHEDULED',
        );
        const slabs = await listTaxSlabs(sql, admin);
        assert.deepEqual(
          slabs.items.map((s) => [s.taxBps, s.state]),
          [
            [500, 'scheduled'],
            [1200, 'scheduled'],
            [500, 'active'],
            [1800, 'active'],
          ],
        );
        await sql`UPDATE rate_plan SET weekday_minor=800000, weekend_minor=800000 WHERE id=${h.deluxeBase}`;
        const before = await getHotelAvailability(sql, {
          rentableId: h.hotel,
          checkIn: addLocalDays(from, -1),
          checkOut: from,
        });
        const after = await getHotelAvailability(sql, {
          rentableId: h.hotel,
          checkIn: from,
          checkOut: addLocalDays(from, 1),
        });
        assert.equal(before.roomTypes[0].plans[0].taxMinor, 144000, '18% the night before');
        assert.equal(after.roomTypes[0].plans[0].taxMinor, 96000, '12% from the new date');
      },
    );
  },
);
