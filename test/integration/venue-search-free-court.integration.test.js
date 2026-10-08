import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedVenue } from '../helpers/venue-fixture.js';
import { createBookingQuote } from '../../src/services/booking/quotes.js';
import { createCheckoutHold } from '../../src/services/booking/checkout.js';
import { setPaymentGatewayConfiguration } from '../../src/services/payments/gateway-settings.js';
import { getDiscoveryRegistry, searchDiscovery } from '../../src/services/db/discovery.js';
import { parseDiscoveryQuery } from '../../src/services/domain/discovery.js';
import {
  addLocalDays,
  isWeekendLocalDate,
  propertyToday,
} from '../../src/services/domain/booking-dates.js';

const env = {
  ...process.env,
  NODE_ENV: 'test',
  RAZORPAY_KEY_ID: 'rzp_test_SEARCH1234',
  RAZORPAY_KEY_SECRET: 'search-disposable-key-secret',
  RAZORPAY_WEBHOOK_SECRET: 'search-disposable-webhook-secret',
};

/**
 * Entertainment plan, Phase 7 acceptance: a dated venue search shows a venue
 * only while a court is truly free. Two guests take both box-cricket courts for
 * the last two hours; the late search drops the venue, an earlier one keeps it.
 */
test(
  'Phase 7: a dated venue search drops the venue once its last free court is held',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      const v = await seedVenue(sql);
      await setPaymentGatewayConfiguration(
        sql,
        {
          actorId: v.admin,
          expectedVersion: 0,
          provider: 'razorpay',
          environment: 'test',
          enabled: true,
          collectionPurpose: 'full',
        },
        env,
      );
      let date = addLocalDays(propertyToday(), 10);
      while (isWeekendLocalDate(date)) date = addLocalDays(date, 1);
      const registry = await getDiscoveryRegistry(sql);
      const search = async (start) =>
        searchDiscovery(
          parseDiscoveryQuery({
            vertical: 'entertainment',
            category: 'box-cricket',
            date,
            start,
            duration: '60',
            players: '6',
          }).filters,
          null,
          sql,
          registry,
        );
      const late = await search('22:00');
      assert.deepEqual(
        late.items[0].times.map((t) => t.start),
        ['22:00', '23:00'],
      );

      // Two guests in two tabs: one court each, 22:00–24:00.
      for (const n of [1, 2]) {
        const [user] = await sql`INSERT INTO "user"(email,phone,role,account_status,name)
          VALUES (${`late${n}@fixture.invalid`},${`900000020${n}`},'customer','active',${`Late ${n}`}) RETURNING id`;
        const [session] =
          await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${user.id},now()+interval '1 day') RETURNING id`;
        const quote = await createBookingQuote(
          sql,
          {
            kind: 'hourly',
            rentableId: v.venue,
            activity: 'box-cricket',
            date,
            start: '22:00',
            durationMinutes: 120,
            guests: 6,
          },
          { customerId: user.id, variables: env },
        );
        await createCheckoutHold(
          sql,
          { role: 'customer', userId: user.id, sessionId: session.id },
          {
            rentableId: v.venue,
            quoteId: quote.id,
            hash: quote.hash,
            version: quote.version,
            idempotencyKey: randomUUID(),
            accepted: true,
          },
          env,
        );
      }

      assert.equal((await search('22:00')).total, 0, 'no court is free from 22:00');
      const earlier = await search('20:00');
      assert.deepEqual(
        earlier.items[0].times.map((t) => t.start),
        ['20:00', '21:00'],
        'earlier times are still offered, and nothing that overlaps the holds',
      );
    } finally {
      await fixture.drop();
    }
  },
);
