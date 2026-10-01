import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { insertFixtureOrder } from './fixture-order.js';
const fixture = JSON.parse(await readFile(process.env.GATE_DB_JSON, 'utf8'));
const url = new URL(fixture.url);
if (
  url.hostname !== '127.0.0.1' ||
  url.port !== '55432' ||
  !url.pathname.startsWith('/rentra_test_')
)
  throw new Error('Disposable local fixture required');
const sql = postgres(fixture.url);
try {
  const [customer] = await sql`SELECT id FROM "user" WHERE phone='9898981234'`;
  const order = await insertFixtureOrder(sql, {
    customerId: customer.id,
    rentableId: fixture.farm,
  });
  await sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,local_day,slot,state,starts_at,ends_at,guests,time_zone,currency,amount_rent_minor,amount_fee_minor,amount_deposit_minor)
    VALUES (${`QA${order.replaceAll('-', '').slice(0, 14)}`},${fixture.farm},${customer.id},${order},1,current_date+5,'day','confirmed',
      statement_timestamp()+interval '5 days',statement_timestamp()+interval '5 days 8 hours',2,'Asia/Kolkata','INR',0,0,0)`;
  await sql`UPDATE category SET slug='farmhouse' WHERE id=(SELECT category_id FROM rentable WHERE id=${fixture.farm})`;
  await sql`UPDATE rentable SET city_id=(SELECT city_id FROM rentable WHERE id=${fixture.venue}),area_id=(SELECT area_id FROM rentable WHERE id=${fixture.venue}) WHERE id=${fixture.farm}`;
  await sql`INSERT INTO category(slug,name,vertical_code,default_rental_unit) VALUES ('bowling','Bowling','entertainment','hour') ON CONFLICT DO NOTHING`;
} finally {
  await sql.end();
}
