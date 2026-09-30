import { randomUUID } from 'node:crypto';

/**
 * A minimal order for fixtures that need a visit without the checkout flow.
 * Every booking belongs to an order (migration 0047).
 */
export async function insertFixtureOrder(
  sql,
  { customerId, rentableId, state = 'confirmed', title = 'Fixture farm' },
) {
  const [order] =
    await sql`INSERT INTO booking_order(reference,customer_id,rentable_id,state,currency,time_zone,
      pricing_version,policy_version,policy_snapshot,listing_snapshot,amount_rent_minor,amount_fee_minor,amount_deposit_minor,
      idempotency_key,request_hash)
    VALUES (${`FX-${randomUUID()}`},${customerId},${rentableId},${state},'INR','Asia/Kolkata','fixture','fixture','{}'::jsonb,
      ${JSON.stringify({ title })}::text::jsonb,0,0,0,${randomUUID()},${'0'.repeat(64)}) RETURNING id`;
  return order.id;
}
