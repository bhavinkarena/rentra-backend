import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apartmentNights,
  apartmentPrice,
  apartmentStayProblem,
  reservationRange,
  weekdayKey,
} from '../../src/services/domain/apartment.js';

/** Story 3.11: flat night prices, cleaning once, nights and occupancy rules. */
const profile = {
  maxAdults: 2,
  maxChildren: 1,
  maxOccupants: 3,
  minNights: 1,
  maxNights: 90,
  arrivalRules: {
    weekdays: { sat: 3 },
    ranges: [{ from: '2027-12-20', to: '2027-12-31', minNights: 5 }],
  },
  weekdayMinor: 500000,
  weekendMinor: 700000,
  weekendNights: [5, 6],
  cleaningMinor: 100000,
};
const today = '2027-01-01';

test('3 nights Fri-Mon: 7000 + 7000 + 5000 + cleaning 1000 = 20,000', () => {
  assert.equal(weekdayKey('2027-01-08'), 'fri');
  const nights = apartmentNights(profile, '2027-01-08', '2027-01-11');
  assert.deepEqual(
    nights.map((n) => n.rateMinor),
    [700000, 700000, 500000],
  );
  assert.deepEqual(apartmentPrice(profile, nights, 0), {
    rentMinor: 1900000,
    cleaningMinor: 100000,
    petMinor: 0,
    stayMinor: 2000000,
  });
  assert.equal(apartmentPrice(profile, nights, 30000).stayMinor, 2030000);
});

test('night and party rules', () => {
  const sel = (checkIn, checkOut, adults = 2, childAges = []) =>
    apartmentStayProblem(profile, { checkIn, checkOut, adults, childAges }, today);
  assert.equal(sel('2027-01-08', '2027-01-10'), null);
  assert.deepEqual(sel('2027-01-09', '2027-01-11'), {
    code: 'MIN_NIGHTS',
    message: 'Minimum 3 nights for Saturday arrival',
  });
  assert.equal(sel('2027-12-22', '2027-12-25').code, 'MIN_NIGHTS');
  assert.match(
    sel('2027-12-22', '2027-12-25').message,
    /Minimum 5 nights for arrivals from 2027-12-20/,
  );
  assert.equal(
    apartmentStayProblem(
      { ...profile, minNights: 3 },
      { checkIn: '2027-01-05', checkOut: '2027-01-07', adults: 1 },
      today,
    ).code,
    'MIN_NIGHTS',
  );
  assert.equal(sel('2027-01-04', '2027-04-05').code, 'MAX_NIGHTS'); // 91 nights
  assert.equal(
    apartmentStayProblem(
      { ...profile, maxNights: 5 },
      { checkIn: '2027-01-04', checkOut: '2027-01-10', adults: 1 },
      today,
    ).code,
    'MAX_NIGHTS',
  );
  assert.equal(sel('2027-01-04', '2027-01-06', 3).code, 'OCCUPANCY');
  assert.equal(sel('2027-01-04', '2027-01-06', 2, [4, 8]).code, 'OCCUPANCY');
  assert.equal(sel('2027-01-04', '2027-01-06', 0).code, 'OCCUPANCY');
  assert.equal(sel('2026-12-30', '2027-01-02').code, 'OUTSIDE_BOOKING_WINDOW');
  assert.equal(sel('2027-01-06', '2027-01-06').code, 'DATES_INVALID');
});

test('the reservation runs from check-in midnight to midnight after the turnover nights', () => {
  assert.deepEqual(reservationRange('2027-01-10', '2027-01-12', 1), {
    blockedStartAt: '2027-01-09T18:30:00.000Z',
    blockedEndAt: '2027-01-12T18:30:00.000Z',
  });
  assert.equal(
    reservationRange('2027-01-10', '2027-01-12', 0).blockedEndAt,
    '2027-01-11T18:30:00.000Z',
  );
});
