import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withListingInventory,
  prepareInventoryCheck,
} from '../../src/services/booking/inventory.js';

const id = 'df426891-0040-4a34-bf5d-5bce347a59ad';
const visit = {
  date: '2026-09-24',
  slot: 'day',
  startsAt: '2026-09-24T03:30:00Z',
  endsAt: '2026-09-24T15:30:00Z',
  blockedStartAt: '2026-09-24T03:30:00Z',
  blockedEndAt: '2026-09-24T15:30:00Z',
};
async function check(
  reservations = [],
  bookings = [],
  availability = [{ day: visit.date, slot: 'day', units_available: 1, blocked_by_client: false }],
) {
  const listing = { id, total_units: 1, booking_config: { inventoryReady: true } };
  const tx = async (strings) => {
    const query = strings.join('?');
    if (query.includes('UPDATE rentable')) return [listing];
    if (query.includes('clock_timestamp() AS now'))
      return [{ now: new Date('2026-09-23T00:00:00Z') }];
    if (query.includes('AS bookings')) return [{ bookings, reservations, availability }];
    return [];
  };
  return withListingInventory({ begin: (fn) => fn(tx) }, id, async (transaction) => {
    const inspect = await prepareInventoryCheck(transaction, listing);
    return inspect([visit]);
  });
}

test('batched inventory snapshot permits open dates but preserves owner blocks', async () => {
  assert.deepEqual(await check(), []);
  const conflicts = await check([
    {
      source: 'owner_block',
      state: 'committed',
      blocked_start_at: visit.blockedStartAt,
      blocked_end_at: visit.blockedEndAt,
    },
  ]);
  assert.equal(conflicts[0].code, 'OWNER_BLOCKED');
});

test('missing inventory is never treated as bookable', async () => {
  assert.equal((await check([], [], []))[0].code, 'INVENTORY_MISSING');
});

test('JSON timestamps preserve committed booking overlap checks', async () => {
  const booking = {
    id: 'booking',
    state: 'confirmed',
    hours_known: true,
    units_booked: 1,
    blocked_start_at: visit.blockedStartAt,
    blocked_end_at: visit.blockedEndAt,
  };
  const reservation = {
    booking_id: 'booking',
    source: 'booking',
    state: 'committed',
    blocked_start_at: visit.blockedStartAt,
    blocked_end_at: visit.blockedEndAt,
  };
  assert.equal((await check([reservation], [booking]))[0].code, 'INVENTORY_UNAVAILABLE');
});
