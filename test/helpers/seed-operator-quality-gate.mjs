// CP31 lab volume. Only disposable local fixtures; never use configured DATABASE_URL.
import { readFile, writeFile } from 'node:fs/promises';
import postgres from 'postgres';
const path = process.env.CP06_GATE_FIXTURE;
const f = JSON.parse(await readFile(path, 'utf8'));
const url = new URL(f.databaseUrl);
if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/rentra_test_'))
  throw new Error('Disposable fixture required');
const sql = postgres(f.databaseUrl, { onnotice: () => {} });
try {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO "user"(email,role,account_status,name)
      SELECT 'cp31-client-'||n||'@fixture.invalid','client','active','CP31 Client '||n FROM generate_series(1,1000) n`;
    await tx`INSERT INTO booking_order(reference,customer_id,rentable_id,currency,time_zone,pricing_version,
      policy_version,policy_snapshot,listing_snapshot,amount_rent_minor,amount_fee_minor,amount_deposit_minor,
      idempotency_key,request_hash,state,confirmed_at)
      SELECT 'CP31-ORDER-'||n,${f.booking.customer},${f.ids.listing},'INR','Asia/Kolkata','v1','v1','{}',
      '{"title":"CP31 historical fixture"}',100000,8000,0,gen_random_uuid(),'cp31-fixture','confirmed',now()-interval '60 days'
      FROM generate_series(1,1000) n`;
    await tx`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,local_day,slot,state,
      starts_at,ends_at,currency,time_zone,guests,units_booked,amount_rent_minor,amount_fee_minor,amount_deposit_minor)
      SELECT replace(reference,'ORDER','V'),${f.ids.listing},${f.booking.customer},id,1,current_date-60,'day','confirmed',
      now()-interval '60 days',now()-interval '59 days','INR','Asia/Kolkata',2,1,100000,8000,0
      FROM booking_order WHERE reference LIKE 'CP31-ORDER-%'`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action)
      SELECT 'admin',${f.ids.admin},'rentable',${f.ids.listing},'cp31_fixture_event' FROM generate_series(1,5000)`;
  });
  const [privacy] = await sql`INSERT INTO customer_privacy_request(customer_id,kind)
    VALUES (${f.booking.customer},'access') RETURNING id`;
  const [application] =
    await sql`INSERT INTO client_application(user_id,status,legal_name,residential_address,pincode,submitted_at)
    VALUES (${f.ids.other},'submitted','CP31 applicant','Fixture address','395001',now()) RETURNING id`;
  const [refund] = await sql`SELECT id FROM refund ORDER BY created_at LIMIT 1`;
  const [counts] = await sql`SELECT (SELECT count(*)::int FROM "user" WHERE role='client') clients,
    (SELECT count(*)::int FROM booking_order) orders,(SELECT count(*)::int FROM booking) visits,
    (SELECT count(*)::int FROM audit_log) audit_events`;
  await sql`ANALYZE`;
  await writeFile(
    path,
    JSON.stringify({
      ...f,
      quality: { privacy: privacy.id, application: application.id, refund: refund.id, counts },
    }),
    { mode: 0o600 },
  );
  console.log('CP31 disposable volume ready:', counts);
} finally {
  await sql.end();
}
