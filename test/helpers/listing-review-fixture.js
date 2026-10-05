export async function seedReviewFixture(sql) {
  const [owner] =
    await sql`INSERT INTO "user"(email,role,account_status,name) VALUES ('property-owner@fixture.invalid','client','active','Property Owner') RETURNING id`;
  const [other] =
    await sql`INSERT INTO "user"(email,role,account_status,name) VALUES ('other-owner@fixture.invalid','client','active','Other Owner') RETURNING id`;
  const [admin] =
    await sql`INSERT INTO admin_user(email,password_hash,name) VALUES ('reviewer@fixture.invalid','fixture-only','Reviewer') RETURNING id`;
  const [second] =
    await sql`INSERT INTO admin_user(email,password_hash,name) VALUES ('second@fixture.invalid','fixture-only','Second Reviewer') RETURNING id`;
  const [limited] =
    await sql`INSERT INTO admin_user(email,password_hash,name,permissions) VALUES ('limited@fixture.invalid','fixture-only','Limited','["admin.records.read"]'::jsonb) RETURNING id`;
  const [city] =
    await sql`INSERT INTO city(slug,name,state) VALUES ('review-city','Surat','Gujarat') RETURNING id`;
  const [area] =
    await sql`INSERT INTO area(city_id,slug,name) VALUES (${city.id},'review-area','Dumas') RETURNING id`;
  const [category] =
    await sql`INSERT INTO category(slug,name) VALUES ('review-farm','Farmhouse') RETURNING id`;
  const [{ udt_name: geometryType }] =
    await sql`SELECT udt_name FROM information_schema.columns WHERE table_name='rentable' AND column_name='location'`;
  const [listing] =
    await sql`INSERT INTO rentable(client_id,slug,title,description,category_id,city_id,area_id,public_code,capacity,farm_size,exact_address,check_in_from,check_out_by,photos)
    VALUES (${owner.id},'review-farm','Review River Farm','A quiet farmhouse with enough description for a complete review submission.',${category.id},${city.id},${area.id},'review01',12,2,'12 Private Lane','09:00','19:00',${JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ url: `https://images.unsplash.com/photo-1518780664697-55e3ad937233?w=400&sig=${i}`, alt: `Farm photo ${i + 1}` })))}::text::jsonb) RETURNING id`;
  if (geometryType === 'geometry')
    await sql`UPDATE rentable SET location=ST_SetSRID(ST_MakePoint(72.8,21.1),4326) WHERE id=${listing.id}`;
  else {
    // Valid EWKB in the helper's text fallback, so the real Drizzle reader can decode it.
    const point = Buffer.alloc(25);
    point.writeUInt8(1, 0);
    point.writeUInt32LE(0x20000001, 1);
    point.writeUInt32LE(4326, 5);
    point.writeDoubleLE(72.8, 9);
    point.writeDoubleLE(21.1, 17);
    await sql`UPDATE rentable SET location=${point.toString('hex')} WHERE id=${listing.id}`;
  }
  for (const slug of ['pool', 'parking', 'garden']) {
    const [amenity] =
      await sql`INSERT INTO amenity(slug,group_slug,label_en) VALUES (${slug},'outdoors',${slug}) RETURNING id`;
    await sql`INSERT INTO amenity_vertical(amenity_id,vertical_code) VALUES (${amenity.id},'farmhouse')`;
    await sql`INSERT INTO rentable_amenity(rentable_id,amenity_id) VALUES (${listing.id},${amenity.id})`;
  }
  await sql`INSERT INTO rentable_price(rentable_id,slot,weekday_minor,weekend_minor) VALUES (${listing.id},'day',100000,150000)`;
  const [document] =
    await sql`INSERT INTO document(owner_type,owner_id,doc_type,storage_key,status) VALUES ('rentable',${listing.id},'extract_7_12','fixture/private-evidence','uploaded') RETURNING id`;
  await sql`UPDATE rentable SET booking_config=${JSON.stringify({ timeZone: 'Asia/Kolkata', leadTimeMinutes: 0, bookingHorizonDays: 90, inventoryReady: true, slots: { day: { enabled: true, startTime: '09:00', endTime: '18:00', endDayOffset: 0, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, capacity: 12, includedGuests: 12, extraGuestChargeMinor: 0 }, night: { enabled: false }, full_day: { enabled: false } } })}::text::jsonb,house_rules='{"cancellationConfirmed":true}'::jsonb WHERE id=${listing.id}`;
  await sql`UPDATE rentable SET house_rules=coalesce(house_rules,'{}'::jsonb)||'{"cancellationConfirmed":true}'::jsonb WHERE id=${listing.id}`;
  return {
    owner: owner.id,
    other: other.id,
    admin: admin.id,
    second: second.id,
    limited: limited.id,
    listing: listing.id,
    document: document.id,
  };
}

/** A customer with one confirmed upcoming visit on the property, accepted snapshot included. */
export async function seedConfirmedBooking(sql, listingId) {
  const { randomUUID } = await import('node:crypto');
  const [customer] =
    await sql`INSERT INTO "user"(email,phone,role,account_status,name) VALUES ('booked-guest@fixture.invalid','9000000077','customer','active','Booked Guest') RETURNING id`;
  // An onboarded customer: the booking pages redirect without a profile.
  await sql`UPDATE "user" SET profile_completed_at=now(),profile_version=1,consent_updated_at=now() WHERE id=${customer.id}`;
  const [order] =
    await sql`INSERT INTO booking_order(reference,customer_id,rentable_id,currency,time_zone,pricing_version,
      policy_version,policy_snapshot,listing_snapshot,amount_rent_minor,amount_fee_minor,amount_deposit_minor,
      idempotency_key,request_hash,state,confirmed_at)
    VALUES ('ORD-CP08',${customer.id},${listingId},'INR','Asia/Kolkata','v1','v1','{}',
      '{"title":"Review River Farm (as booked)"}',100000,8000,0,${randomUUID()},'hash','confirmed',now()) RETURNING id`;
  await sql`INSERT INTO booking(reference,rentable_id,customer_id,slot,state,starts_at,ends_at,
      order_id,item_position,local_day,currency,time_zone,guests,units_booked,amount_rent_minor,amount_fee_minor,amount_deposit_minor,confirmed_at)
    VALUES ('V-CP08',${listingId},${customer.id},'day','confirmed',
      now()+interval '5 days', now()+interval '5 days 8 hours',${order.id},1,(now()+interval '5 days')::date,'INR','Asia/Kolkata',2,1,100000,8000,0,now())`;
  return { customer: customer.id, order: order.id };
}

/** More bookings on the seed visit's day; each slot order has its own immutable identity. */
export async function seedBusyOwnerVisits(sql, orderId, from = 2, to = 40, listingTitle = null) {
  await sql`WITH orders AS (
    INSERT INTO booking_order(reference,customer_id,rentable_id,currency,time_zone,pricing_version,policy_version,policy_snapshot,listing_snapshot,
      amount_rent_minor,amount_fee_minor,amount_deposit_minor,idempotency_key,request_hash,state,confirmed_at)
    SELECT 'TODAY-ORDER-'||n,customer_id,rentable_id,currency,time_zone,pricing_version,policy_version,policy_snapshot,listing_snapshot||${JSON.stringify(listingTitle ? { title: listingTitle } : {})}::text::jsonb,
      amount_rent_minor,amount_fee_minor,amount_deposit_minor,gen_random_uuid(),request_hash,state,confirmed_at
    FROM booking_order CROSS JOIN generate_series(${from}::int,${to}::int) n WHERE id=${orderId} RETURNING id,reference)
    INSERT INTO booking(reference,rentable_id,customer_id,slot,state,starts_at,ends_at,blocked_start_at,blocked_end_at,order_id,item_position,local_day,
      currency,time_zone,guests,units_booked,amount_rent_minor,amount_fee_minor,amount_deposit_minor,hours_known)
    SELECT 'V-'||o.reference,b.rentable_id,b.customer_id,b.slot,b.state,b.starts_at,b.ends_at,b.blocked_start_at,b.blocked_end_at,o.id,1,b.local_day,
      b.currency,b.time_zone,b.guests,b.units_booked,b.amount_rent_minor,b.amount_fee_minor,b.amount_deposit_minor,b.hours_known
    FROM orders o CROSS JOIN booking b WHERE b.order_id=${orderId} AND b.item_position=1`;
}
