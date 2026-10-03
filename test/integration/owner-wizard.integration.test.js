import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { propertyToday, addLocalDays } from '../../src/services/domain/booking-dates.js';
test(
  'Phase 5 drafts: type reuse, autosave conflicts, upload ownership, availability and preview isolation',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = fixture.sql;
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = fixture.url;
      process.env.NODE_ENV = 'test';
      process.env.DEV_OTP_BYPASS = 'true';
      process.env.CLOUDINARY_CLOUD_NAME = 'owner-fixture';
      process.env.CLOUDINARY_API_KEY = 'fixture';
      process.env.CLOUDINARY_API_SECRET = 'fixture';
      const f = await seedReviewFixture(sql);
      const { runWithContext } = await import('../../src/runtime/context.js');
      const { issuePortalSession } = await import('../../src/services/auth/portal-sessions.js');
      const { encryptSession } = await import('../../src/services/auth/session-crypto.js');
      const token = await encryptSession({
        role: 'client',
        userId: f.owner,
        sessionId: await issuePortalSession(sql, 'client', f.owner, 3600),
      });
      const actions = await import('../../src/services/auth/listings.js'),
        { getListingForEdit } = await import('../../src/services/db/listing-queries.js');
      const send = (action, values) => {
        const form = new FormData();
        for (const [key, value] of Object.entries(values)) form.set(key, String(value));
        return runWithContext({ req: { cookies: { rentra_session: token } }, res: {} }, () =>
          action(null, form),
        );
      };
      const [category] = await sql`SELECT category_id FROM rentable WHERE id=${f.listing}`;
      let id;
      await assert.rejects(
        send(actions.createListingFromBasics, {
          vertical: 'farmhouse',
          categoryId: category.category_id,
        }),
        (error) => {
          id = error.location?.match(/listings\/([^/]+)/)?.[1];
          return Boolean(id);
        },
      );
      await assert.rejects(
        send(actions.createListingFromBasics, {
          vertical: 'farmhouse',
          categoryId: category.category_id,
        }),
        (error) => error.location?.includes(id),
      );
      let data = await getListingForEdit(id, f.owner);
      assert.equal(data.listing.title, '');
      assert.equal(data.listing.cityId, null);
      assert.equal(data.listing.completion.canSubmit, false);
      const version = data.listing.contentVersion;
      let result = await send(actions.saveBasics, {
        id,
        categoryId: category.category_id,
        title: 'River',
        description: 'Typing',
        contentVersion: version,
        autosave: '1',
      });
      assert.equal(result.ok, true);
      data = await getListingForEdit(id, f.owner);
      assert.equal(data.listing.title, 'River');
      assert.equal(data.listing.completion.sections.find((s) => s.id === 'story').done, false);
      await assert.rejects(
        send(actions.saveBasics, {
          id,
          categoryId: category.category_id,
          title: 'Another title',
          description: 'Still typing',
          contentVersion: version,
          autosave: '1',
        }),
        (error) => error.code === 'LISTING_CHANGED',
      );
      const [place] = await sql`SELECT city_id,area_id FROM rentable WHERE id=${f.listing}`;
      const [otherCity] =
        await sql`INSERT INTO city(slug,name,state) VALUES('another','Another','Gujarat') RETURNING id`;
      result = await send(actions.saveLocation, {
        id,
        cityId: otherCity.id,
        areaId: place.area_id,
        lat: 21.1,
        lng: 72.8,
        exactAddress: 'An exact private address',
        contentVersion: data.listing.contentVersion,
      });
      assert.ok(result.errors.areaId);
      result = await send(actions.saveCapacity, {
        id,
        capacity: 12,
        bedrooms: 0,
        farmSize: '',
        farmSizeUnit: 'acre',
        contentVersion: data.listing.contentVersion,
      });
      assert.equal(result.ok, true);
      const { changePropertyPolicy } =
        await import('../../src/services/booking/property-policy.js');
      const [before] = await sql`SELECT content_version FROM rentable WHERE id=${id}`;
      const values = {
        day_weekday: '₹1,500',
        day_weekend: '1,500',
        night_weekday: 0,
        night_weekend: 0,
        full_day_weekday: 0,
        full_day_weekend: 0,
        extraGuestCharge: 200,
        includedGuests: 10,
      };
      result = await changePropertyPolicy(sql, f.owner, id, 'pricing', {
        values,
        expectedVersion: before.content_version,
        direct: true,
      });
      assert.equal(result.ok, true);
      const { saveBookingConfiguration, autoOpenDates } =
        await import('../../src/services/booking/owner-settings.js');
      const [cfg] = await sql`SELECT booking_config_version FROM rentable WHERE id=${id}`;
      const config = {
        timeZone: 'Asia/Kolkata',
        autoOpen: true,
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
      };
      await saveBookingConfiguration(sql, f.owner, {
        rentableId: id,
        expectedVersion: cfg.booking_config_version,
        configuration: config,
      });
      const day = addLocalDays(propertyToday(), 60);
      const [opened] =
        await sql`SELECT units_available FROM availability WHERE rentable_id=${id} AND day=${day} AND slot='day'`;
      assert.equal(opened.units_available, 1);
      await sql`UPDATE availability SET units_available=0 WHERE rentable_id=${id} AND day=${day}`;
      await autoOpenDates(sql);
      await autoOpenDates(sql);
      const [closed] =
        await sql`SELECT units_available FROM availability WHERE rentable_id=${id} AND day=${day} AND slot='day'`;
      assert.equal(closed.units_available, 0);
      const { v2: cloudinary } = await import('cloudinary');
      cloudinary.api.resource = async (key) => ({
        public_id: key,
        format: 'jpg',
        bytes: 1000,
        width: 2000,
        height: 1200,
        type: 'upload',
      });
      cloudinary.uploader.destroy = async () => ({ result: 'ok' });
      const signed = await send(actions.signPhoto, { id });
      assert.ok(signed.signature);
      assert.equal(signed.api_key, 'fixture');
      assert.ok(signed.public_id.startsWith(`rentra/listings/${id}/`));
      data = await getListingForEdit(id, f.owner);
      result = await send(actions.attachPhoto, {
        id,
        publicId: signed.public_id,
        hash: 'abc',
        tag: 'Lawn',
        contentVersion: data.listing.contentVersion,
      });
      assert.equal(result.ok, true);
      await assert.rejects(
        send(actions.attachPhoto, {
          id,
          publicId: `rentra/listings/${f.listing}/foreign`,
          contentVersion: result.contentVersion,
        }),
        (error) => error.code === 'NOT_FOUND',
      );
      const data2 = await getListingForEdit(id, f.owner);
      assert.equal(data2.photos[0].tag, 'Lawn');
      const { getListingByCode } = await import('../../src/services/db/queries.js');
      assert.equal(await getListingByCode(data2.listing.publicCode), null);
      assert.equal(await getListingByCode(data2.listing.publicCode, f.other), null);
      await assert.rejects(
        send(actions.deleteDraft, { id }),
        (error) => error.location === '/partner/listings',
      );
      assert.equal(await getListingForEdit(id, f.owner), null);
    } finally {
      await fixture.drop();
    }
  },
);
