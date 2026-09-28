// Extend only the owned CP30 disposable fixture; no configured database/provider.
import { readFile, writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { recordVisitTransition } from '@/services/booking/visit-lifecycle.js';
import { memoryEvidenceStore } from '@/services/uploads/evidence-store.js';
const path = process.env.CP06_GATE_FIXTURE;
const f = JSON.parse(await readFile(path, 'utf8')),
  url = new URL(f.databaseUrl);
if (url.hostname !== '127.0.0.1' || !/^\/rentra_test_[a-f0-9]{32}$/.test(url.pathname))
  throw Error('Owned disposable database required');
import { setPaymentGatewayConfiguration } from '@/services/payments/gateway-settings.js';
const db = postgres(url.toString(), { onnotice: () => {} });
try {
  await setPaymentGatewayConfiguration(
    db,
    {
      actorId: f.ids.admin,
      expectedVersion: 0,
      provider: 'razorpay',
      environment: 'test',
      enabled: true,
      collectionPurpose: 'full',
    },
    {
      RAZORPAY_TEST_KEY_ID: 'rzp_test_cp30fixture',
      RAZORPAY_TEST_KEY_SECRET: 'cp30-disposable-fake-provider-secret',
      RAZORPAY_TEST_WEBHOOK_SECRET: 'cp30-disposable-webhook-secret',
    },
  );
  await db.begin(async (db) => {
    const nested = (...args) => db(...args);
    Object.assign(nested, db);
    nested.begin = (run) => db.savepoint(run);
    const slot = {
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
    await db`UPDATE rentable SET booking_config=${JSON.stringify({ inventoryReady: true, timeZone: 'Asia/Kolkata', leadTimeMinutes: 60, bookingHorizonDays: 90, slots: { day: slot, night: { enabled: false }, full_day: { enabled: false } } })}::text::jsonb WHERE id=${f.ids.listing}`;
    const [original] = await db`SELECT * FROM booking WHERE order_id=${f.booking.order}`;
    const [order] =
      await db`INSERT INTO booking_order(reference,customer_id,rentable_id,currency,time_zone,pricing_version,policy_version,policy_snapshot,listing_snapshot,amount_rent_minor,amount_fee_minor,amount_deposit_minor,idempotency_key,request_hash,state,payment_mode,visit_provenance)
    SELECT ${randomUUID()},customer_id,rentable_id,currency,time_zone,pricing_version,policy_version,policy_snapshot,listing_snapshot,amount_rent_minor,amount_fee_minor,amount_deposit_minor,${randomUUID()},${'a'.repeat(64)},'confirmed','real','real' FROM booking_order WHERE id=${f.booking.order} RETURNING id`;
    const [visit] =
      await db`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,day,local_day,slot,state,amount_rent,amount_fee,starts_at,ends_at,hours_known,blocked_start_at,blocked_end_at,currency,time_zone,amount_rent_minor,amount_fee_minor,amount_deposit_minor,payment_mode,visit_provenance,units_booked,guests)
    VALUES (${randomUUID().slice(0, 16)},${f.ids.listing},${f.booking.customer},${order.id},1,current_date-2,current_date-2,'day','confirmed',1000,80,now()-interval '2 days',now()-interval '1 day',true,now()-interval '2 days',now()-interval '1 day','INR','Asia/Kolkata',100000,8000,0,'real','real',1,2) RETURNING id`;
    for (const [phase, hours] of [
      ['handover', 47],
      ['return', 26],
      ['complete', 25],
    ]) {
      const [version] = await db`SELECT lifecycle_version FROM booking WHERE id=${visit.id}`;
      await recordVisitTransition(
        nested,
        { kind: 'owner', id: f.ids.owner },
        {
          visitId: visit.id,
          phase,
          occurredAt: new Date(Date.now() - hours * 3600000).toISOString(),
          note: 'Synthetic observed visit evidence for local browser acceptance only.',
          attested: true,
          expectedVersion: version.lifecycle_version,
          requestKey: randomUUID(),
        },
        { store: memoryEvidenceStore() },
      );
    }
    f.reviewOrder = order.id;
    // Reconcile the original confirmed fixture before quote readiness is checked.
    await db`UPDATE booking SET hours_known=true,blocked_start_at=starts_at,blocked_end_at=ends_at WHERE id=${original.id}`;
    await db`INSERT INTO inventory_reservation(rentable_id,booking_id,source,state,blocked_start_at,blocked_end_at) SELECT rentable_id,id,'booking','committed',blocked_start_at,blocked_end_at FROM booking WHERE id=${original.id} ON CONFLICT DO NOTHING`;
    const [d] = await db`SELECT (current_date+7)::text AS "day"`;
    f.customerContinuation = {
      day: d.day,
      phone: '9000000077',
      listingPath: '/listing/review-farm-review01',
    };
    await db`INSERT INTO availability(rentable_id,day,slot,units_available,blocked_by_client) VALUES (${f.ids.listing},${d.day},'day',1,false) ON CONFLICT DO NOTHING`;
    await writeFile(path, JSON.stringify(f));
    console.log('Disposable customer continuation ready');
  });
} finally {
  await db.end();
}
