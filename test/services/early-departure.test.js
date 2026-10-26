import assert from 'node:assert/strict';
import test from 'node:test';
import { earlyDepartureRoom } from '../../src/services/domain/early-departure.js';

const room = {
  checkIn: '2030-01-10',
  checkOut: '2030-01-13',
  rent: 1003,
  tax: 73,
  fee: 101,
  nights: [
    { night: '2030-01-10', rateMinor: 301, taxMinor: 21 },
    { night: '2030-01-11', rateMinor: 303, taxMinor: 23 },
    { night: '2030-01-12', rateMinor: 399, taxMinor: 29 },
  ],
  policy: { version: 1, earlyDeparture: { offered: true, pct: 37 } },
  checkInMinute: 840,
  timeZone: 'Asia/Kolkata',
};
test('unused nights start strictly later than the confirmed instant, at the booked schedule', () => {
  const before = earlyDepartureRoom(room, '2030-01-11T08:29:59.999Z');
  const equal = earlyDepartureRoom(room, '2030-01-11T08:30:00.000Z');
  const after = earlyDepartureRoom(room, '2030-01-11T08:30:00.001Z');
  assert.deepEqual(before.unusedNights, ['2030-01-11', '2030-01-12']);
  assert.deepEqual(equal.unusedNights, ['2030-01-12']);
  assert.deepEqual(after, equal);
  assert.equal(equal.inventoryEnd, '2030-01-12');
  assert.deepEqual(equal.consumedNights, ['2030-01-10', '2030-01-11']);
  assert.deepEqual(equal.unused, { rent: 399, tax: 29, fee: 40 });
  assert.deepEqual(equal.refund, { rent: 147, tax: 11, fee: 15 });
  assert.equal(
    Object.values(before.refund).reduce((a, b) => a + b),
    Math.floor(((702 + 52 + 71) * 37) / 100),
  );
});
test('zero/no offer and no unused nights produce zero entitlement without changing consumed stock', () => {
  for (const offer of [
    { offered: false, pct: 100 },
    { offered: true, pct: 0 },
  ]) {
    const result = earlyDepartureRoom(
      { ...room, policy: { version: 1, earlyDeparture: offer } },
      '2030-01-10T09:00Z',
    );
    assert.deepEqual(result.refund, { rent: 0, tax: 0, fee: 0 });
  }
  const result = earlyDepartureRoom(room, '2030-01-12T09:00Z');
  assert.equal(result.inventoryEnd, room.checkOut);
  assert.deepEqual(result.unusedNights, []);
  assert.deepEqual(result.refund, { rent: 0, tax: 0, fee: 0 });
});
test('unsafe, legacy, nonconsecutive and inconsistent snapshots are refused', () => {
  for (const change of [
    { timeZone: 'UTC' },
    { checkInMinute: null },
    { checkInMinute: 1440 },
    { policy: {} },
    { policy: { version: 1 } },
    { rent: 1004 },
    { tax: 72 },
    { fee: Number.MAX_SAFE_INTEGER + 1 },
    { nights: room.nights.slice(1) },
    { nights: [room.nights[0], room.nights[0], room.nights[2]] },
    { policy: { version: 1, earlyDeparture: { offered: 'true', pct: 50 } } },
  ])
    assert.throws(() => earlyDepartureRoom({ ...room, ...change }, '2030-01-11T09:00Z'), {
      message: 'EARLY_DEPARTURE_UNSUPPORTED',
    });
});
