import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { seedVenue } from '../helpers/venue-fixture.js';
import { readGuide, saveGuide, setupGuide } from '../../src/services/auth/owner-guide.js';
import { changePropertyPolicy } from '../../src/services/booking/property-policy.js';
import {
  saveBookingConfiguration,
  openBookingDates,
} from '../../src/services/booking/owner-settings.js';
import { propertyToday, addLocalDays } from '../../src/services/domain/booking-dates.js';

test(
  'owner onboarding persists across sessions, advances to review, and drafts never bypass approval',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const sql = fixture.sql;
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = fixture.url;
      Object.assign(process.env, {
        NODE_ENV: 'test',
        DEV_OTP_BYPASS: 'true',
        CLOUDINARY_CLOUD_NAME: 'fixture',
        CLOUDINARY_API_KEY: 'fixture',
        CLOUDINARY_API_SECRET: 'fixture',
      });
      const f = await seedReviewFixture(sql);
      const venue = await seedVenue(sql);
      const { runWithContext } = await import('../../src/runtime/context.js');
      const auth = await import('../../src/services/auth/actions.js');
      const application = await import('../../src/services/auth/application.js');
      const { uploadKycDocuments } = await import('../../src/services/auth/documents.js');
      const listings = await import('../../src/services/auth/listings.js');
      const send = (action, values, token = '') => {
        const form = new FormData();
        for (const [key, value] of Object.entries(values)) form.set(key, String(value));
        return runWithContext(
          {
            req: { cookies: { rentra_session: token } },
            res: {
              cookie(_name, value) {
                send.token = value;
              },
              clearCookie() {},
            },
          },
          () => action(null, form),
        );
      };
      const first = await send(auth.verifyClientOtp, {
        email: 'new-owner@fixture.invalid',
        code: '123456',
      });
      assert.deepEqual(first, { ok: true, isNew: true, next: '/partner/welcome' });
      const token = send.token;
      assert.equal(
        (await send(auth.verifyClientOtp, { email: 'new-owner@fixture.invalid', code: '123456' }))
          .isNew,
        false,
      );
      const mobile = await send(auth.verifyClientOtp, {
        channel: 'sms',
        phone: '9876543210',
        code: '123456',
      });
      assert.equal(mobile.isNew, true);
      assert.equal(
        (await send(auth.verifyClientOtp, { channel: 'sms', phone: '9876543210', code: '123456' }))
          .isNew,
        false,
      );
      const [owner] =
        await sql`SELECT id FROM "user" WHERE email='new-owner@fixture.invalid' AND role='client'`;
      assert.deepEqual(await readGuide(sql, owner.id), {});
      await saveGuide(sql, owner.id, {
        welcomeSeenAt: true,
        intendedVertical: 'entertainment',
        tourStartedAt: true,
      });
      await saveGuide(sql, owner.id, { tourSkippedAt: true });
      const guide = await readGuide(sql, owner.id);
      assert.ok(guide.welcomeSeenAt && guide.tourSkippedAt);
      assert.equal(guide.intendedVertical, 'entertainment');
      assert.deepEqual(await readGuide(sql, f.other), {});
      await assert.rejects(saveGuide(sql, owner.id, { checklistDismissedAt: true }), {
        code: 'SETUP_INCOMPLETE',
      });
      let result = await send(
        application.saveDetails,
        {
          legalName: 'Test Owner',
          residentialAddress: '123 Main Street, Surat',
          pincode: '395007',
          preferredLocale: 'en',
          clientType: 'owner',
        },
        token,
      );
      assert.equal(result.next, '/partner/onboarding/details?mobile=1');
      result = await send(
        auth.confirmPhoneVerification,
        { phone: '9876543211', code: '123456' },
        token,
      );
      assert.equal(result.next, '/partner/onboarding/kyc');
      const app = await application.getOrCreateApplication(owner.id);
      await sql`UPDATE client_application SET kyc_doc_type='pan_card', kyc_name_on_doc='Test Owner' WHERE id=${app.id}`;
      await sql`INSERT INTO document(owner_type,owner_id,doc_type,side,storage_key,status) VALUES ('client_application',${app.id},'pan_card','front','fixture/private-pan','uploaded')`;
      result = await send(
        uploadKycDocuments,
        { docType: 'pan_card', kycNameOnDoc: 'Test Owner' },
        token,
      );
      assert.equal(
        result.next,
        '/partner/onboarding/payout',
        'existing valid images survive an edit without another upload',
      );
      result = await send(
        application.savePayout,
        { method: 'upi', upiId: 'owner@bank', holderName: 'Test Owner' },
        token,
      );
      assert.equal(result.next, '/partner/onboarding/consent');
      result = await send(
        application.saveConsent,
        { acceptTerms: 'on', declareEntitled: 'on' },
        token,
      );
      assert.equal(result.next, '/partner/onboarding/review');
      await assert.rejects(
        send(application.submitApplication, {}, token),
        (error) => error.location === '/partner?submitted=1',
      );
      await assert.rejects(
        send(application.saveDetails, {}, token),
        (error) => error.location === '/partner?locked=in_review',
      );
      const [place] =
        await sql`SELECT category_id,city_id,area_id FROM rentable WHERE id=${f.listing}`;
      await assert.rejects(
        send(
          listings.createListingFromBasics,
          {
            categoryId: place.category_id,
            cityId: place.city_id,
            areaId: place.area_id,
            title: 'Draft for pending owner',
            description:
              'A quiet farmhouse with enough information for a guest to understand the property.',
          },
          token,
        ),
        (error) => error.location?.includes('/setup/location'),
      );
      const [draft] = await sql`SELECT * FROM rentable WHERE client_id=${owner.id}`;
      result = await send(
        listings.saveBasics,
        {
          id: draft.id,
          categoryId: draft.category_id,
          title: draft.title,
          description: draft.description,
          highlight: '',
        },
        token,
      );
      assert.equal(result.ok, true);
      await assert.rejects(
        send(listings.submitListing, { id: draft.id }, token),
        (error) => error.location === '/partner',
      );
      await assert.rejects(
        openBookingDates(sql, owner.id, {
          rentableId: draft.id,
          from: propertyToday(),
          to: propertyToday(),
        }),
        { code: 'FORBIDDEN' },
      );
      const values = {
        day_weekday: 1000,
        day_weekend: 1200,
        night_weekday: 0,
        night_weekend: 0,
        full_day_weekday: 0,
        full_day_weekend: 0,
        extraGuestCharge: 0,
        extraHourCharge: 0,
      };
      const input = { values, expectedVersion: draft.content_version, preview: true };
      const preview = await changePropertyPolicy(sql, owner.id, draft.id, 'pricing', input);
      await changePropertyPolicy(sql, owner.id, draft.id, 'pricing', {
        ...input,
        preview: false,
        previewToken: preview.preview.token,
      });
      await assert.rejects(changePropertyPolicy(sql, f.other, draft.id, 'pricing', input), {
        code: 'NOT_FOUND',
      });
      await sql`UPDATE "user" SET account_status='active' WHERE id=${owner.id}`;
      const before = await setupGuide(sql, owner.id);
      assert.equal(before.steps.find((s) => s.id === 'property').done, true);
      assert.equal(before.steps.find((s) => s.id === 'calendar').done, false);
      await sql`UPDATE rentable SET status='live' WHERE id=${draft.id}`;
      const [current] = await sql`SELECT booking_config_version FROM rentable WHERE id=${draft.id}`;
      await saveBookingConfiguration(sql, owner.id, {
        rentableId: draft.id,
        expectedVersion: current.booking_config_version,
        configuration: {
          timeZone: 'Asia/Kolkata',
          leadTimeMinutes: 0,
          bookingHorizonDays: 30,
          slots: {
            day: {
              enabled: true,
              startTime: '09:00',
              endTime: '18:00',
              endDayOffset: 0,
              bufferBeforeMinutes: 0,
              bufferAfterMinutes: 0,
              capacity: 1,
              includedGuests: 1,
              extraGuestChargeMinor: 0,
            },
            night: { enabled: false },
            full_day: { enabled: false },
          },
        },
      });
      const day = addLocalDays(propertyToday(), 2);
      await openBookingDates(sql, owner.id, { rentableId: draft.id, from: day, to: day });
      const ready = await setupGuide(sql, owner.id);
      assert.equal(
        ready.steps.find((s) => s.id === 'calendar').done,
        true,
        'uses real guest availability',
      );
      assert.equal(ready.canDismiss, true, 'caretaker is optional');
      await saveGuide(sql, owner.id, { checklistDismissedAt: true });
      assert.equal((await setupGuide(sql, owner.id)).dismissed, true);
      await saveGuide(sql, owner.id, { checklistDismissedAt: false });
      assert.equal((await setupGuide(sql, owner.id)).dismissed, false);
      assert.equal(
        (await setupGuide(sql, venue.owner)).steps.find((s) => s.id === 'calendar').done,
        true,
        'hourly guest availability counts',
      );
      await sql`DELETE FROM rentable_rate WHERE rentable_id=${venue.venue}`;
      assert.equal(
        (await setupGuide(sql, venue.owner)).steps.find((s) => s.id === 'calendar').done,
        false,
        'open hours without prices are not bookable',
      );
      await sql`UPDATE "user" SET account_status='blocked' WHERE id=${owner.id}`;
      await assert.rejects(saveGuide(sql, owner.id, { tourCompletedAt: true }), {
        code: 'ACCOUNT_RESTRICTED',
      });
    } finally {
      await fixture.drop();
    }
  },
);
