import { randomUUID } from 'node:crypto';

/**
 * Hotel plan fixtures: a live Surat hotel with Deluxe (3 rooms) and Standard (2 rooms),
 * each with a base plan; Deluxe also has Breakfast (derived) and Non-refundable (derived).
 */
export async function seedHotel(sql, { status = 'live', deluxeRooms = 3 } = {}) {
  const [owner] =
    await sql`INSERT INTO "user"(email,role,account_status,name) VALUES (${`hotel-owner-${randomUUID()}@fixture.invalid`},'client','active','Hotel Owner') RETURNING id`;
  const [admin] =
    await sql`INSERT INTO admin_user(email,password_hash,name) VALUES (${`hotel-admin-${randomUUID()}@fixture.invalid`},'fixture','Admin') RETURNING id`;
  const [city] = (await sql`SELECT id FROM city WHERE slug='surat'`).length
    ? await sql`SELECT id FROM city WHERE slug='surat'`
    : await sql`INSERT INTO city(slug,name,state) VALUES ('surat','Surat','Gujarat') RETURNING id`;
  const [area] =
    await sql`INSERT INTO area(city_id,slug,name) VALUES (${city.id},${`adajan-${randomUUID().slice(0, 8)}`},'Adajan') RETURNING id`;
  const [category] = (await sql`SELECT id FROM category WHERE slug='hotel'`).length
    ? await sql`SELECT id FROM category WHERE slug='hotel'`
    : await sql`INSERT INTO category(slug,name,vertical_code,default_rental_unit) VALUES ('hotel','Hotel','hotel','night') RETURNING id`;
  const code = randomUUID().slice(0, 8);
  const [hotel] =
    await sql`INSERT INTO rentable(client_id,slug,title,category_id,city_id,area_id,public_code,rental_unit,capacity)
    VALUES (${owner.id},${`riverside-${code}`},'Riverside Residency',${category.id},${city.id},${area.id},${`htl${code.slice(0, 5)}`},'night',4) RETURNING id`;
  await sql`INSERT INTO hotel_profile(rentable_id,child_free_age) VALUES (${hotel.id},6)`;
  const room = async (name, count, sortOrder) => {
    const [row] =
      await sql`INSERT INTO room_type(rentable_id,name,max_adults,max_children,max_occupancy,base_occupancy,room_count,extra_adult_minor,extra_child_minor,sort_order)
      VALUES (${hotel.id},${name},3,2,4,2,${count},70000,40000,${sortOrder}) RETURNING id`;
    return row.id;
  };
  const deluxe = await room('Deluxe Double', deluxeRooms, 1);
  const standard = await room('Standard Twin', 2, 2);
  const plan = async (roomTypeId, values) => {
    const [row] =
      await sql`INSERT INTO rate_plan ${sql({ room_type_id: roomTypeId, rentable_id: hotel.id, ...values })} RETURNING id`;
    return row.id;
  };
  const deluxeBase = await plan(deluxe, {
    name: 'Room only',
    weekday_minor: 260000,
    weekend_minor: 300000,
    free_cancel_hours: 48,
  });
  const deluxeBreakfast = await plan(deluxe, {
    name: 'Breakfast included',
    meal_plan: 'CP',
    derived_from: deluxeBase,
    derived_per_guest_minor: 25000,
    free_cancel_hours: 48,
    sort_order: 1,
  });
  const deluxeNonRefundable = await plan(deluxe, {
    name: 'Non-refundable',
    derived_from: deluxeBase,
    derived_pct_bps: -1000,
    late_charge: 'full_stay',
    no_show: 'full_stay',
    sort_order: 2,
  });
  const standardBase = await plan(standard, {
    name: 'Room only',
    weekday_minor: 200000,
    weekend_minor: 230000,
    free_cancel_hours: 24,
  });
  await sql`UPDATE rentable SET status=${status} WHERE id=${hotel.id}`;
  return {
    owner: owner.id,
    admin: admin.id,
    city: city.id,
    area: area.id,
    category: category.id,
    hotel: hotel.id,
    deluxe,
    standard,
    deluxeBase,
    deluxeBreakfast,
    deluxeNonRefundable,
    standardBase,
  };
}

export async function seedCustomer(sql) {
  const [user] = await sql`INSERT INTO "user"(email,phone,role,account_status,name)
    VALUES (${`guest-${randomUUID()}@fixture.invalid`},${`9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`},'customer','active','Guest') RETURNING id`;
  return user.id;
}

/**
 * A held order with one 'stay' booking, as checkout (Phase 7) will create it.
 * `sql` may be a transaction.
 */
export async function insertStayBooking(
  sql,
  { customerId, rentableId, quote, holdMinutes = 15, now = new Date() },
) {
  const expires = new Date(new Date(now).getTime() + holdMinutes * 60_000).toISOString();
  const [order] =
    await sql`INSERT INTO booking_order(reference,customer_id,rentable_id,state,currency,time_zone,pricing_version,policy_version,
      policy_snapshot,listing_snapshot,amount_rent_minor,amount_fee_minor,amount_deposit_minor,idempotency_key,request_hash,hold_expires_at)
    VALUES (${`HT-${randomUUID()}`},${customerId},${rentableId},'held','INR','Asia/Kolkata','hotel-v1','hotel-v1','{}'::jsonb,
      '{"title":"Riverside Residency"}'::jsonb,${quote.totals.roomMinor},0,0,${randomUUID()},${quote.hash},${expires}) RETURNING id`;
  const [booking] =
    await sql`INSERT INTO booking(reference,rentable_id,customer_id,slot,starts_at,ends_at,guests,order_id,item_position,local_day,
      time_zone,currency,blocked_start_at,blocked_end_at,hours_known,amount_rent_minor,amount_fee_minor,amount_deposit_minor)
    VALUES (${`RS${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`},${rentableId},${customerId},'stay',${quote.startsAt},${quote.endsAt},
      ${quote.lines.reduce((sum, line) => sum + line.adults + line.childAges.length, 0)},${order.id},1,${quote.checkIn},'Asia/Kolkata','INR',
      ${quote.startsAt},${quote.endsAt},true,${quote.totals.roomMinor},0,0) RETURNING id`;
  return { orderId: order.id, bookingId: booking.id };
}
