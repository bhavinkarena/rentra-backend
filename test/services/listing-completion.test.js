import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstIncompleteStepId } from '../../src/services/domain/listing-steps.js';
import { listingCompletion } from '../../src/services/domain/listing-completion.js';

const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const config = {
  model: 'hourly',
  timeZone: 'Asia/Kolkata',
  leadTimeMinutes: 30,
  bookingHorizonDays: 60,
  stepMinutes: 60,
  minDurationMinutes: 60,
  maxDurationMinutes: 180,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  weeklyHours: Object.fromEntries(
    days.map((d) => [d, [{ open: '06:00', close: '01:00', closesNextDay: true }]]),
  ),
  inventoryReady: true,
};
const venue = {
  rentalUnit: 'hour',
  categoryId: 'c1',
  categorySlug: 'box-cricket',
  title: 'Smash Arena box cricket',
  description: 'Two floodlit box-cricket cages off Vesu Main Road, nets on all sides.',
  bookingConfig: config,
};
const courts = [{ isActive: true, capacity: 12, activities: ['box-cricket'] }];
const band = (dayKind, startMinute, endMinute) => ({
  activity: 'box-cricket',
  dayKind,
  startMinute,
  endMinute,
  hourlyRate: 800,
});
const section = (completion, id) => completion.sections.find((s) => s.id === id);

test('venue pricing must cover every open minute, weekday and weekend', () => {
  const full = [band('weekday', 360, 1500), band('weekend', 360, 1500)];
  const priced = (hourlyRates) =>
    section(listingCompletion(venue, { resources: courts, hourlyRates }), 'pricing').done;
  assert.equal(priced(full), true);
  // Split bands that meet exactly still cover the day.
  assert.equal(
    priced([band('weekday', 360, 1080), band('weekday', 1080, 1500), band('weekend', 360, 1500)]),
    true,
  );
  assert.equal(priced([band('weekday', 360, 1500)]), false, 'no weekend price');
  assert.equal(priced([band('weekday', 360, 1440), band('weekend', 360, 1500)]), false, 'gap');
  assert.equal(priced([]), false);
  // Overlapping bands are refused, not averaged.
  assert.equal(
    priced([band('weekday', 360, 1500), band('weekday', 1000, 1200), band('weekend', 360, 1500)]),
    false,
  );
});

test('venue resumes at the first unfinished venue step', () => {
  const placed = {
    ...venue,
    cityId: 'x',
    areaId: 'y',
    location: { x: 1, y: 1 },
    exactAddress: 'a',
  };
  assert.equal(firstIncompleteStepId(listingCompletion(placed), 'hour'), 'space');
  const withCourts = listingCompletion(placed, { resources: courts });
  assert.equal(firstIncompleteStepId(withCourts, 'hour'), 'amenities');
  // A court that does not offer the main activity leaves the courts step open.
  const wrong = listingCompletion(placed, {
    resources: [{ ...courts[0], activities: ['pickleball'] }],
  });
  assert.equal(section(wrong, 'space').done, false);
});
