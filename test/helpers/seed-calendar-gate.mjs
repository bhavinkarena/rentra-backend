// Only the disposable local CP10 fixture, never the configured application database.
import { readFile, writeFile } from 'node:fs/promises';
import postgres from 'postgres';
const path = process.env.CP06_GATE_FIXTURE;
const fixture = JSON.parse(await readFile(path, 'utf8'));
const url = new URL(fixture.databaseUrl);
if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/rentra_test_'))
  throw new Error('Disposable fixture required');
const sql = postgres(fixture.databaseUrl);
const id = fixture.ids.listing;
const day = new Date(Date.now() + 5 * 86400000 + 19800000).toISOString().slice(0, 10);
const next = new Date(new Date(day).getTime() + 86400000).toISOString().slice(0, 10);
try {
  const slot = {
    enabled: true,
    startTime: '09:00',
    endTime: '18:00',
    endDayOffset: 0,
    bufferBeforeMinutes: 60,
    bufferAfterMinutes: 60,
    capacity: 12,
    includedGuests: 12,
    extraGuestChargeMinor: 0,
  };
  const config = {
    inventoryReady: true,
    timeZone: 'Asia/Kolkata',
    leadTimeMinutes: 60,
    bookingHorizonDays: 90,
    slots: {
      day: slot,
      night: { ...slot, startTime: '21:00', endTime: '08:00', endDayOffset: 1 },
      full_day: { enabled: false },
    },
  };
  await sql`UPDATE rentable SET booking_config=${sql.json(config)} WHERE id=${id}`;
  const [visit] =
    await sql`UPDATE booking SET hours_known=true,slot='night', starts_at=${day + 'T21:00:00+05:30'},ends_at=${next + 'T08:00:00+05:30'},blocked_start_at=${day + 'T20:00:00+05:30'},blocked_end_at=${next + 'T09:00:00+05:30'} WHERE order_id=${fixture.booking.order} RETURNING *`;
  await sql`INSERT INTO inventory_reservation(rentable_id,booking_id,source,state,blocked_start_at,blocked_end_at) VALUES (${id},${visit.id},'booking','committed',${visit.blocked_start_at},${visit.blocked_end_at})`;
  await sql`INSERT INTO booking_price_override(rentable_id,day,slot,rent_minor) VALUES (${id},${day},'day',125000)`;
  await writeFile(path, JSON.stringify({ ...fixture, calendarDay: day }));
  console.log('CP10 interval fixture ready');
} finally {
  await sql.end();
}
