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
    await sql`INSERT INTO rentable_amenity(rentable_id,amenity_id) VALUES (${listing.id},${amenity.id})`;
  }
  await sql`INSERT INTO rentable_price VALUES (${listing.id},'day',1000,1500)`;
  const [document] =
    await sql`INSERT INTO document(owner_type,owner_id,doc_type,storage_key,status) VALUES ('rentable',${listing.id},'extract_7_12','fixture/private-evidence','uploaded') RETURNING id`;
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
