import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apartmentProblem,
  cleaningFeeLine,
  normalizeArrivalRules,
} from '../../src/services/domain/apartment.js';

const unit = {
  bedrooms: 1,
  bathrooms: 1,
  beds: [{ type: 'double', count: 1 }],
  maxAdults: 2,
  maxChildren: 1,
  maxOccupants: 3,
};
const stay = {
  minNights: 1,
  maxNights: 30,
  arrivalRules: { weekdays: {}, ranges: [] },
  checkInTime: '14:00',
  checkOutTime: '11:00',
  turnoverNights: 0,
};

test('Story 3.10: apartment rules', () => {
  assert.equal(apartmentProblem('unit', unit), null);
  assert.match(apartmentProblem('unit', { ...unit, maxAdults: 3 }), /sleep 2/);
  assert.match(apartmentProblem('unit', { ...unit, maxOccupants: 1 }), /fewer than max adults/);
  assert.match(apartmentProblem('unit', { ...unit, bathrooms: 0 }), /Bathrooms/);
  assert.equal(apartmentProblem('stay', stay), null);
  assert.match(apartmentProblem('stay', { ...stay, minNights: 5, maxNights: 3 }), /cannot be more/);
  assert.match(apartmentProblem('stay', { ...stay, maxNights: 91 }), /1 to 90/);
  assert.equal(apartmentProblem('stay', { ...stay, maxNights: 90 }), null);
  assert.equal(apartmentProblem('stay', { ...stay, arrivalRules: { weekdays: { sat: 2 } } }), null);
  assert.match(
    apartmentProblem('stay', { ...stay, minNights: 3, arrivalRules: { weekdays: { sat: 2 } } }),
    /from 3 to 30/,
  );
  assert.match(
    apartmentProblem('stay', {
      ...stay,
      arrivalRules: { ranges: [{ from: '2026-12-31', to: '2026-12-01', minNights: 2 }] },
    }),
    /start on or before/,
  );
  assert.match(
    apartmentProblem('stay', {
      ...stay,
      arrivalRules: {
        ranges: Array(21).fill({ from: '2026-12-01', to: '2026-12-02', minNights: 2 }),
      },
    }),
    /at most 20/,
  );
  assert.match(apartmentProblem('stay', { ...stay, checkOutTime: '14:00' }), /before check-in/);
  assert.match(apartmentProblem('stay', { ...stay, turnoverNights: 4 }), /0 to 3/);
  assert.equal(
    apartmentProblem('price', {
      weekday: 3000,
      weekend: 3500,
      cleaningFee: 0,
      weekendNights: [5, 6],
    }),
    null,
  );
  assert.match(
    apartmentProblem('price', {
      weekday: 3000,
      weekend: 3500,
      cleaningFee: 50001,
      weekendNights: [],
    }),
    /Cleaning fee/,
  );
  assert.equal(cleaningFeeLine(0), 'No cleaning fee');
  assert.equal(cleaningFeeLine(1500), 'Cleaning fee ₹1,500 per stay');
  assert.deepEqual(normalizeArrivalRules({ weekdays: { sun: 2, mon: 3 } }), {
    weekdays: { mon: 3, sun: 2 },
    ranges: [],
  });
});

test('Story 3.10: apartments use night cancellation presets and their own booking model', async () => {
  const { CANCELLATION_PRESETS, policyFromTier, presetName } =
    await import('../../src/services/domain/cancellation-policy.js');
  const { bookingModel } = await import('../../src/services/domain/verticals.js');
  assert.deepEqual(policyFromTier('strict', 'unit_night'), CANCELLATION_PRESETS.night.strict);
  assert.equal(presetName(CANCELLATION_PRESETS.night.moderate, 'unit_night'), 'moderate');
  assert.deepEqual(policyFromTier('strict', 'slot'), CANCELLATION_PRESETS.day.strict);
  assert.equal(bookingModel({ rental_unit: 'unit_night' }), 'apartment');
  assert.equal(bookingModel({ rental_unit: 'slot' }), 'slot');
});
