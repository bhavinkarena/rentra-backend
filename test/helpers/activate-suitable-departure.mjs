// Test-only time-shift, following apartment integration fixtures; never an application operation.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { addLocalDays, propertyToday } from '../../src/services/domain/booking-dates.js';
const fixture = JSON.parse(await readFile(resolve('tmp/story312/fixture.json'), 'utf8'));
const url = new URL(fixture.databaseUrl);
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.port, '55432');
assert.match(url.pathname, /^\/rentra_test_[a-f0-9]{32}$/);
const width = Number(process.argv[2]);
assert.ok([390, 1440].includes(width));
const sql = postgres(url.href, { max: 1 });
try {
  const stay = fixture.departures.find((row) => row.width === width);
  assert.ok(stay);
  assert.ok(stay.expected, 'Prepare the expected refund before activation');
  const hour = new Date(Date.now() + 330 * 60000).getUTCHours();
  const from = hour >= 14 ? propertyToday() : addLocalDays(propertyToday(), -1);
  const shift = Math.round((Date.parse(stay.from) - Date.parse(from)) / 86400000);
  await sql.begin(async (tx) => {
    // Reset only earlier completed local scenarios so the same unit can model a second current stay.
    await tx`UPDATE inventory_reservation r SET state='released',released_at=now() FROM booking b WHERE r.booking_id=b.id AND b.rentable_id=${fixture.ids.apartment} AND b.state='completed' AND r.state='committed'`;
    const [b] = await tx`SELECT id,slot_snapshot FROM booking WHERE order_id=${stay.orderId}`;
    assert.equal(b.slot_snapshot.checkIn, stay.from, 'activate each fixture once');
    const back = (date) => addLocalDays(date, -shift);
    const s = b.slot_snapshot;
    const snapshot = {
      ...s,
      date: back(s.date),
      checkIn: back(s.checkIn),
      checkOut: back(s.checkOut),
      apartment: {
        ...s.apartment,
        nightly: s.apartment.nightly.map((n) => ({ ...n, night: back(n.night) })),
      },
    };
    await tx`ALTER TABLE booking DISABLE TRIGGER USER`;
    await tx`UPDATE booking SET local_day=${back(s.date)},starts_at=starts_at-make_interval(days=>${shift}),ends_at=ends_at-make_interval(days=>${shift}),blocked_start_at=blocked_start_at-make_interval(days=>${shift}),blocked_end_at=blocked_end_at-make_interval(days=>${shift}),slot_snapshot=${JSON.stringify(snapshot)}::text::jsonb WHERE id=${b.id}`;
    await tx`ALTER TABLE booking ENABLE TRIGGER USER`;
    await tx`UPDATE inventory_reservation SET blocked_start_at=blocked_start_at-make_interval(days=>${shift}),blocked_end_at=blocked_end_at-make_interval(days=>${shift}) WHERE booking_id=${b.id}`;
  });
  stay.expected.consumedNights = [from];
  stay.expected.unusedNights = [addLocalDays(from, 1), addLocalDays(from, 2)];
  await writeFile(resolve('tmp/story312/fixture.json'), JSON.stringify(fixture));
  console.log(`Activated local ${width}px departure fixture.`);
} finally {
  await sql.end();
}
