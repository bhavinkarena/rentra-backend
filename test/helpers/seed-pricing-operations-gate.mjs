// Extend only serve-property-review's disposable local fixture; never use .env DATABASE_URL.
import { readFile, writeFile } from 'node:fs/promises';
import postgres from 'postgres';
const path = process.env.CP06_GATE_FIXTURE;
const fixture = JSON.parse(await readFile(path, 'utf8'));
const url = new URL(fixture.databaseUrl);
if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/rentra_test_'))
  throw new Error('Disposable fixture required');
const sql = postgres(fixture.databaseUrl);
try {
  const id = fixture.ids.listing;
  const schedule = {
    enabled: true,
    startTime: '09:00',
    endTime: '18:00',
    endDayOffset: 0,
    bufferBeforeMinutes: 30,
    bufferAfterMinutes: 30,
    capacity: 12,
    includedGuests: 12,
    extraGuestChargeMinor: 0,
  };
  await sql`UPDATE rentable SET booking_config=${sql.json({ inventoryReady: true, timeZone: 'Asia/Kolkata', leadTimeMinutes: 60, bookingHorizonDays: 90, slots: { day: schedule, night: { enabled: false }, full_day: { enabled: false } } })} WHERE id=${id}`;
  const [visit] =
    await sql`UPDATE booking SET starts_at=now()-interval '1 hour',ends_at=now()+interval '2 hours',blocked_start_at=now()-interval '90 minutes',blocked_end_at=now()+interval '150 minutes',hours_known=true,local_day=(now() AT TIME ZONE 'Asia/Kolkata')::date,day=(now() AT TIME ZONE 'Asia/Kolkata')::date WHERE order_id=${fixture.booking.order} RETURNING id`;
  await sql`INSERT INTO inventory_reservation(rentable_id,booking_id,source,state,blocked_start_at,blocked_end_at) SELECT rentable_id,id,'booking','committed',blocked_start_at,blocked_end_at FROM booking WHERE id=${visit.id}`;
  await sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,day,local_day,slot,state,amount_rent,amount_fee,starts_at,ends_at,hours_known,blocked_start_at,blocked_end_at,currency,time_zone,amount_rent_minor,amount_fee_minor,amount_deposit_minor)
 VALUES ('CP12-CANCELLED',${id},${fixture.booking.customer},${fixture.booking.order},2,current_date+20,current_date+20,'day','cancelled',1000,80,now()+interval '20 days',now()+interval '20 days 8 hours',true,now()+interval '20 days',now()+interval '20 days 8 hours','INR','Asia/Kolkata',100000,8000,0)`;
  await sql`UPDATE booking_order SET listing_snapshot=listing_snapshot||'{"contact":{"name":"Guest contact","phone":"9000000077"}}'::jsonb WHERE id=${fixture.booking.order}`;
  await writeFile(path, JSON.stringify({ ...fixture, operationalVisit: visit.id }));
  console.log('CP11/12 disposable fixture ready');
} finally {
  await sql.end();
}
