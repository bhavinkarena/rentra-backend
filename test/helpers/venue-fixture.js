/** Entertainment plan fixtures: a live box-cricket venue with two courts and a pickleball court. */
const hours = [{ open: '06:00', close: '01:00', closesNextDay: true }];
export const venueConfig = {
  model: 'hourly',
  timeZone: 'Asia/Kolkata',
  leadTimeMinutes: 30,
  bookingHorizonDays: 60,
  stepMinutes: 60,
  minDurationMinutes: 60,
  maxDurationMinutes: 180,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  weeklyHours: {
    mon: hours,
    tue: hours,
    wed: hours,
    thu: hours,
    fri: hours,
    sat: hours,
    sun: hours,
  },
  inventoryReady: true,
};

export async function seedVenue(sql, { status = 'live', vertical = 'public' } = {}) {
  await sql`UPDATE vertical SET status=${vertical} WHERE code='entertainment'`;
  const [owner] =
    await sql`INSERT INTO "user"(email,role,account_status,name) VALUES ('venue-owner@fixture.invalid','client','active','Venue Owner') RETURNING id`;
  const [admin] =
    await sql`INSERT INTO admin_user(email,password_hash,name) VALUES ('hourly-admin@fixture.invalid','fixture','Admin') RETURNING id`;
  const [city] =
    await sql`INSERT INTO city(slug,name,state) VALUES ('surat','Surat','Gujarat') RETURNING id`;
  const [area] =
    await sql`INSERT INTO area(city_id,slug,name) VALUES (${city.id},'vesu','Vesu') RETURNING id`;
  const [cricket] =
    await sql`INSERT INTO category(slug,name,vertical_code,default_rental_unit) VALUES ('box-cricket','Box cricket','entertainment','hour') RETURNING id`;
  const [pickle] =
    await sql`INSERT INTO category(slug,name,vertical_code,default_rental_unit) VALUES ('pickleball','Pickleball','entertainment','hour') RETURNING id`;
  const [venue] =
    await sql`INSERT INTO rentable(client_id,slug,title,category_id,city_id,area_id,public_code,rental_unit,capacity,cancellation_tier)
    VALUES (${owner.id},'smash-arena','Smash Arena',${cricket.id},${city.id},${area.id},'venue001','hour',12,'moderate') RETURNING id`;
  const court = async (name, capacity, sortOrder, activity) => {
    const [row] =
      await sql`INSERT INTO rentable_resource(rentable_id,name,capacity,sort_order) VALUES (${venue.id},${name},${capacity},${sortOrder}) RETURNING id`;
    await sql`INSERT INTO rentable_resource_activity(resource_id,rentable_id,category_id) VALUES (${row.id},${venue.id},${activity})`;
    return row.id;
  };
  const court1 = await court('Court 1', 12, 1, cricket.id);
  const court2 = await court('Court 2', 12, 2, cricket.id);
  await court('Pickleball 1', 4, 3, pickle.id);
  await sql`INSERT INTO rentable_rate(rentable_id,category_id,day_kind,start_minute,end_minute,hourly_rate_minor) VALUES
    (${venue.id},${cricket.id},'weekday',360,1080,80000),(${venue.id},${cricket.id},'weekday',1080,1500,120000),
    (${venue.id},${cricket.id},'weekend',360,960,100000),(${venue.id},${cricket.id},'weekend',960,1500,140000),
    (${venue.id},${pickle.id},'weekday',360,1500,60000),(${venue.id},${pickle.id},'weekend',360,1500,70000)`;
  await sql`UPDATE rentable SET status=${status}, booking_config=${sql.json(venueConfig)} WHERE id=${venue.id}`;
  return { owner: owner.id, admin: admin.id, venue: venue.id, court1, court2 };
}
