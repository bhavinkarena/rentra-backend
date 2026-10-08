import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedVenue, venueConfig } from '../helpers/venue-fixture.js';
import { createBookingQuote } from '../../src/services/booking/quotes.js';
import { createCheckoutHold } from '../../src/services/booking/checkout.js';
import { createOwnerBlock } from '../../src/services/booking/inventory.js';
import { getTimeSlots } from '../../src/services/booking/time-slots.js';
import { setPaymentGatewayConfiguration } from '../../src/services/payments/gateway-settings.js';
import { getDiscoveryRegistry, searchDiscovery } from '../../src/services/db/discovery.js';
import { parseDiscoveryQuery } from '../../src/services/domain/discovery.js';
import { minuteToHhmm } from '../../src/services/domain/hourly.js';
import {
  addLocalDays,
  isWeekendLocalDate,
  propertyToday,
} from '../../src/services/domain/booking-dates.js';

/**
 * Entertainment plan, Phase 9: the guest time grid, the search card and the hold
 * agree. Every start the grid shows can be held, once per free court, and the
 * grid drops it the moment the last court goes.
 */
const env = {
  ...process.env,
  NODE_ENV: 'test',
  RAZORPAY_KEY_ID: 'rzp_test_GRID1234',
  RAZORPAY_KEY_SECRET: 'grid-disposable-key-secret',
  RAZORPAY_WEBHOOK_SECRET: 'grid-disposable-webhook-secret',
};
const skip = !process.env.PORTAL_TEST_DATABASE_URL;

async function setup() {
  const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
  const v = await seedVenue(fixture.sql);
  await setPaymentGatewayConfiguration(
    fixture.sql,
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
  let date = addLocalDays(propertyToday(), 9);
  while (isWeekendLocalDate(date)) date = addLocalDays(date, 1);
  return { fixture, sql: fixture.sql, v, date };
}

let players = 0;
async function newCustomer(sql) {
  players += 1;
  const [user] = await sql`INSERT INTO "user"(email,phone,role,account_status,name)
    VALUES (${`grid${players}@fixture.invalid`},${`91${String(players).padStart(8, '0')}`},'customer','active',${`Grid ${players}`}) RETURNING id`;
  const [session] =
    await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${user.id},now()+interval '1 day') RETURNING id`;
  return { id: user.id, session: { role: 'customer', userId: user.id, sessionId: session.id } };
}

test(
  'Phase 9: every displayed start can be held once per free court, and the search card agrees',
  { skip },
  async () => {
    const { fixture, sql, v, date } = await setup();
    try {
      const args = {
        rentableId: v.venue,
        date,
        activity: 'box-cricket',
        durationMinutes: 60,
        guests: 6,
      };
      const registry = await getDiscoveryRegistry(sql);
      const card = async () =>
        (
          await searchDiscovery(
            parseDiscoveryQuery({
              vertical: 'entertainment',
              category: 'box-cricket',
              date,
              duration: '60',
              players: '6',
            }).filters,
            null,
            sql,
            registry,
          )
        ).items[0];

      const grid = await getTimeSlots(sql, args);
      // 06:00–01:00 (next day), 1 hr: starts 06:00…23:00, two box-cricket courts each.
      assert.equal(grid.times.length, 18);
      assert.ok(grid.times.every((t) => t.freeResourceIds.length === 2));
      assert.deepEqual(
        (await card()).times.map((t) => t.start),
        grid.times.slice(0, 3).map((t) => t.start),
      );

      for (const time of grid.times) {
        for (let court = 0; court < time.freeResourceIds.length; court += 1) {
          const who = await newCustomer(sql);
          const quote = await createBookingQuote(
            sql,
            { kind: 'hourly', ...args, start: time.start },
            { customerId: who.id, variables: env },
          );
          assert.equal(quote.totals.rentMinor, time.rentMinor, `${time.start} price`);
          await createCheckoutHold(
            sql,
            who.session,
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
        const after = await getTimeSlots(sql, args);
        assert.ok(!after.times.some((t) => t.start === time.start), `${time.start} still shown`);
        // One more guest for a start the grid no longer shows is refused.
        const late = await newCustomer(sql);
        await assert.rejects(
          createBookingQuote(
            sql,
            { kind: 'hourly', ...args, start: time.start },
            { customerId: late.id, variables: env },
          ),
          (error) => error.code === 'AVAILABILITY_CONFLICT',
        );
      }
      assert.equal((await getTimeSlots(sql, args)).times.length, 0);
      assert.equal(await card(), undefined);
    } finally {
      await fixture.drop();
    }
  },
);

/** Small deterministic PRNG so a failing config can be reproduced from its seed. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const pick = (random, list) => list[Math.floor(random() * list.length)];

test(
  'Phase 9: over random configs, the grid emits exactly the starts a quote accepts',
  { skip },
  async () => {
    const { fixture, sql, v, date } = await setup();
    try {
      const [{ id: cricket }] = await sql`SELECT id FROM category WHERE slug='box-cricket'`;
      const owner = v.owner;
      let offered = 0;
      for (let seed = 1; seed <= 10; seed += 1) {
        const random = rng(seed);
        const step = pick(random, [30, 60]);
        const open = pick(random, [6, 8, 10]) * 60;
        // One shift, or a split shift with a gap; sometimes past midnight.
        const close = pick(random, [20 * 60, 23 * 60, 25 * 60]);
        const split = random() < 0.4;
        const windows = split
          ? [
              { open: minuteToHhmm(open), close: '13:00', closesNextDay: false },
              {
                open: '16:00',
                close: minuteToHhmm(close),
                closesNextDay: close > 1440,
              },
            ]
          : [{ open: minuteToHhmm(open), close: minuteToHhmm(close), closesNextDay: close > 1440 }];
        const config = {
          ...venueConfig,
          stepMinutes: step,
          minDurationMinutes: step === 30 ? 30 : 60,
          maxDurationMinutes: 180,
          bufferAfterMinutes: pick(random, [0, 0, 15, 30]),
          weeklyHours: Object.fromEntries(
            Object.keys(venueConfig.weeklyHours).map((d) => [d, windows]),
          ),
        };
        await sql`UPDATE rentable SET booking_config=${sql.json(config)} WHERE id=${v.venue}`;
        // Prices with a hole now and then: unpriced starts must not be offered.
        await sql`DELETE FROM rentable_rate WHERE rentable_id=${v.venue} AND category_id=${cricket}`;
        const gap = random() < 0.3;
        await sql`INSERT INTO rentable_rate(rentable_id,category_id,day_kind,start_minute,end_minute,hourly_rate_minor) VALUES
          (${v.venue},${cricket},'weekday',0,${gap ? 900 : 1080},80000),
          (${v.venue},${cricket},'weekday',${gap ? 960 : 1080},1800,120000)`;
        // Some existing use: a court block and maybe a venue-wide block.
        await sql`DELETE FROM inventory_reservation WHERE rentable_id=${v.venue}`;
        const blockAt = (h, m) => new Date(`${date}T${minuteToHhmm(h * 60 + m)}:00+05:30`);
        await createOwnerBlock(sql, owner, {
          rentableId: v.venue,
          resourceId: v.court1,
          blockedStartAt: blockAt(pick(random, [11, 18]), 0),
          blockedEndAt: blockAt(pick(random, [19, 20]), 30),
          reason: 'Fixture block',
        });
        if (random() < 0.5)
          await createOwnerBlock(sql, owner, {
            rentableId: v.venue,
            blockedStartAt: blockAt(8, 0),
            blockedEndAt: blockAt(9, 0),
            reason: 'Fixture venue block',
          });

        const duration = pick(random, step === 30 ? [30, 60, 90] : [60, 120]);
        const args = {
          rentableId: v.venue,
          date,
          activity: 'box-cricket',
          durationMinutes: duration,
          guests: 4,
        };
        const shown = new Map(
          (await getTimeSlots(sql, args)).times.map((t) => [t.start, t.rentMinor]),
        );
        const who = await newCustomer(sql);
        for (let minute = 0; minute < 1440; minute += 30) {
          const start = minuteToHhmm(minute);
          const quoted = await createBookingQuote(
            sql,
            { kind: 'hourly', ...args, start },
            { customerId: who.id, variables: env },
          ).catch((error) => error);
          const accepted = !(quoted instanceof Error);
          assert.equal(
            shown.has(start),
            accepted,
            `seed ${seed}: ${start} for ${duration} min shown=${shown.has(start)} quote=${accepted ? 'ok' : quoted.code}`,
          );
          if (accepted) assert.equal(quoted.totals.rentMinor, shown.get(start));
        }
        offered += shown.size;
      }
      assert.ok(offered > 50, `only ${offered} starts offered across all configs`);
    } finally {
      await fixture.drop();
    }
  },
);
