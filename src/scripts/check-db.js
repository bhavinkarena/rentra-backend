import postgres from 'postgres';

const DATABASE_URL = 'postgresql://neondb_owner:npg_Om65hHJxGsPF@ep-frosty-haze-ayd7hzah-pooler.c-5.us-east-2.aws.neon.tech/rentra?sslmode=require&channel_binding=require';

const sql = postgres(DATABASE_URL, { prepare: false, max: 1 });

async function check() {
  const cities = await sql`SELECT * FROM city`;
  console.log('Cities:', cities);
  const areas = await sql`SELECT city_id, count(*)::int as count FROM area GROUP BY city_id`;
  console.log('Areas per city:', areas);
  await sql.end();
}

check().catch(console.error);
