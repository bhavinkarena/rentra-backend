import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import {
  listContent,
  readContent,
  publicContent,
  contentCommand,
} from '../../src/services/content/service.js';
import { createBookingQuote, revalidateHeldQuoteTerms } from '../../src/services/booking/quotes.js';
import { createCheckoutHold } from '../../src/services/booking/checkout.js';
import { openBookingDates } from '../../src/services/booking/owner-settings.js';
import { setPaymentGatewayConfiguration } from '../../src/services/payments/gateway-settings.js';
import { propertyToday, addLocalDays } from '../../src/services/domain/booking-dates.js';

test(
  'CP25 publication, immutable history, rollback and checkout acceptance',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = db.sql;
    const secret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'cp25-disposable-signing-secret';
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      RAZORPAY_TEST_KEY_ID: 'rzp_test_CP25',
      RAZORPAY_TEST_KEY_SECRET: 'fixture-secret',
      RAZORPAY_TEST_WEBHOOK_SECRET: 'fixture-webhook',
    };
    try {
      const f = await seedReviewFixture(sql),
        booked = await seedConfirmedBooking(sql, f.listing);
      const admin = { kind: 'admin', id: f.admin },
        second = { kind: 'admin', id: f.second };
      const legacy = await publicContent(sql, 'terms', '2026-09-20'),
        original = await publicContent(sql, 'terms');
      assert.equal((await listContent(sql, admin)).items.length, 5);
      for (const actor of [
        { kind: 'owner', id: f.owner },
        { kind: 'admin', id: f.limited },
      ])
        await assert.rejects(listContent(sql, actor), { statusCode: 403 });
      await sql`UPDATE admin_user SET permissions='["admin.content.read"]'::jsonb WHERE id=${f.limited}`;
      assert.equal(
        (await readContent(sql, { kind: 'admin', id: f.limited }, 'terms')).canWrite,
        false,
      );
      const reason = 'Review the policy explanation',
        body = { ...original.body, title: 'CP25 reviewed terms' };
      const command = (kind, cmd, version, extra = {}, actor = admin) =>
        contentCommand(sql, actor, kind, { command: cmd, version, reason, ...extra });
      await assert.rejects(
        command('terms', 'save', 0, { body }, { kind: 'admin', id: f.limited }),
        { statusCode: 403 },
      );
      await assert.rejects(
        command('terms', 'save', 0, { body: { ...body, title: '<script>alert(1)</script>' } }),
        { code: 'INVALID_CONTENT' },
      );
      const help = (await publicContent(sql, 'help')).body;
      await assert.rejects(
        command('help', 'save', 0, {
          body: {
            ...help,
            faqs: [
              {
                question: 'Unsafe?',
                answer: 'Unsafe link',
                href: 'javascript:alert(1)',
                link: 'Click',
              },
            ],
          },
        }),
        { code: 'INVALID_CONTENT' },
      );
      await command('terms', 'save', 0, { body });
      assert.equal((await publicContent(sql, 'terms')).version, original.version);
      await assert.rejects(command('terms', 'save', 0, { body }), { code: 'STALE_CONTENT' });
      await assert.rejects(command('terms', 'preview', 1), { code: 'REVIEW_REQUIRED' });
      await assert.rejects(command('terms', 'review', 1), { code: 'REVIEW_REQUIRED' });
      await command('terms', 'review', 1, { confirmed: true }, second);
      const p = await command('terms', 'preview', 2),
        p2 = await command('terms', 'preview', 2, {}, second);
      await assert.rejects(command('terms', 'publish', 2, { confirmed: true }), {
        code: 'STALE_PREVIEW',
      });
      await assert.rejects(
        command('terms', 'publish', 2, { confirmed: true, previewHash: p.previewHash }, second),
        { code: 'STALE_PREVIEW' },
      );

      const slot = {
        enabled: true,
        startTime: '09:00',
        endTime: '18:00',
        endDayOffset: 0,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        capacity: 12,
        includedGuests: 12,
        extraGuestChargeMinor: 0,
      };
      await sql`UPDATE rentable SET status='live',booking_config=${sql.json({ inventoryReady: true, timeZone: 'Asia/Kolkata', leadTimeMinutes: 60, bookingHorizonDays: 90, slots: { day: slot, night: { enabled: false }, full_day: { enabled: false } } })} WHERE id=${f.listing}`;
      const day = addLocalDays(propertyToday(), 12);
      await openBookingDates(sql, f.owner, { rentableId: f.listing, from: day, to: day });
      await setPaymentGatewayConfiguration(
        sql,
        {
          actorId: f.admin,
          expectedVersion: 0,
          provider: 'razorpay',
          environment: 'test',
          enabled: true,
          collectionPurpose: 'full',
        },
        env,
      );
      const [sessionRow] =
        await sql`INSERT INTO customer_session(user_id,expires_at) VALUES (${booked.customer},now()+interval '1 day') RETURNING id`;
      const session = { role: 'customer', userId: booked.customer, sessionId: sessionRow.id };
      const selection = { rentableId: f.listing, dates: [day], slot: 'day', guests: 2 };
      const quote = () =>
        createBookingQuote(sql, selection, { customerId: booked.customer, variables: env });
      const oldQuote = await quote();
      const results = await Promise.allSettled(
        [
          [admin, p],
          [second, p2],
        ].map(([a, preview]) =>
          command('terms', 'publish', 2, { confirmed: true, previewHash: preview.previewHash }, a),
        ),
      );
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'STALE_CONTENT');
      const published = await publicContent(sql, 'terms');
      assert.equal(published.body.title, body.title);
      assert.deepEqual((await publicContent(sql, 'terms', '2026-09-20')).body, legacy.body);
      const hold = (q) =>
        createCheckoutHold(
          sql,
          session,
          {
            rentableId: f.listing,
            quoteId: q.id,
            hash: q.hash,
            version: q.version,
            idempotencyKey: randomUUID(),
            accepted: true,
          },
          env,
        );
      await assert.rejects(hold(oldQuote), { code: 'QUOTE_CHANGED' });
      const held = await hold(await quote());
      const [order] = await sql`SELECT * FROM booking_order WHERE id=${held.orderId}`;
      assert.equal(order.policy_snapshot.publications.terms.version, published.version);
      const [event] =
        await sql`SELECT payload FROM booking_lifecycle_event WHERE order_id=${held.orderId} AND kind='held'`;
      assert.equal(event.payload.acceptedPublicPolicies.terms.version, published.version);
      await assert.rejects(sql`UPDATE content_publication SET body='{}' WHERE kind='terms'`, {
        code: '23514',
      });
      await assert.rejects(sql`DELETE FROM content_publication WHERE kind='terms'`, {
        code: '23514',
      });
      await command('terms', 'restore', 3, { sourceVersion: '2026-09-20' });
      assert.equal((await publicContent(sql, 'terms')).version, published.version);
      await command('terms', 'review', 4, { confirmed: true });
      const rp = await command('terms', 'preview', 5);
      const restored = await command('terms', 'publish', 5, {
        confirmed: true,
        previewHash: rp.previewHash,
      });
      assert.notEqual(restored.version, '2026-09-20');
      assert.deepEqual((await publicContent(sql, 'terms')).body, legacy.body);
      assert.equal((await publicContent(sql, 'terms', published.version)).body.title, body.title);
      assert.deepEqual(
        (await sql`SELECT policy_snapshot FROM booking_order WHERE id=${held.orderId}`)[0]
          .policy_snapshot,
        order.policy_snapshot,
      );
      await sql.begin(async (tx) => {
        const [listing] = await tx`SELECT * FROM rentable WHERE id=${f.listing}`;
        assert.equal(
          (await revalidateHeldQuoteTerms(tx, listing, order, env)).policy.publications.terms
            .version,
          published.version,
        );
      });
      await command('help', 'save', 0, { body: help });
      await command('help', 'review', 1, { confirmed: true });
      await command('help', 'save', 2, { body: { ...help, intro: 'Updated practical answers' } });
      await assert.rejects(command('help', 'preview', 3), { code: 'REVIEW_REQUIRED' });
      assert.equal((await readContent(sql, admin, 'terms')).history.length, 4);
      const contact = (await publicContent(sql, 'contact')).body;
      await command('contact', 'save', 0, { body: contact });
      assert.deepEqual(
        (
          await publicContent(sql, 'contact', '2026-09-21', {
            RENTRA_SUPPORT_EMAIL: 'changed@example.com',
          })
        ).body,
        contact,
      );
      assert.equal((await readContent(sql, admin, 'contact')).history.length, 1);
      await sql`UPDATE admin_user SET is_active=false WHERE id=${f.admin}`;
      await assert.rejects(readContent(sql, admin, 'terms'), { statusCode: 403 });
    } finally {
      if (secret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = secret;
      await db.drop();
    }
  },
);
