/**
 * Seed the fixed amenity taxonomy.
 *
 * Idempotent — re-running updates labels and ordering rather than duplicating,
 * so this is also how you edit a label or add a tag.
 *
 *   npm run seed:amenities
 */
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });

/**
 * [slug, en, hi, gu, valueType, filterable]
 *
 * `filterable` is deliberately sparse. A search facet for every tag gives a
 * wall of checkboxes nobody uses; the ones marked here are what guests
 * actually filter a farmhouse search by.
 */
const GROUPS = [
  ['water', [
    ['swimming_pool', 'Swimming pool', 'स्विमिंग पूल', 'સ્વિમિંગ પૂલ', 'dimensions', true],
    ['kids_pool', "Kids' pool", 'बच्चों का पूल', 'બાળકોનો પૂલ', 'none', false],
    ['rain_dance', 'Rain dance', 'रेन डांस', 'રેન ડાન્સ', 'none', true],
    ['ro_water', 'RO drinking water', 'RO पीने का पानी', 'RO પીવાનું પાણી', 'none', false],
    ['borewell', 'Borewell', 'बोरवेल', 'બોરવેલ', 'none', false],
    ['water_24hr', '24-hour water', '24 घंटे पानी', '24 કલાક પાણી', 'none', false],
  ]],
  ['comfort', [
    ['ac_bedrooms', 'AC bedrooms', 'AC बेडरूम', 'AC બેડરૂમ', 'count', true],
    ['fans', 'Fans', 'पंखे', 'પંખા', 'none', false],
    ['geyser', 'Geyser', 'गीजर', 'ગીઝર', 'none', false],
    ['extra_mattresses', 'Extra mattresses', 'अतिरिक्त गद्दे', 'વધારાના ગાદલા', 'count', false],
  ]],
  ['kitchen', [
    ['modular_kitchen', 'Modular kitchen', 'मॉड्यूलर किचन', 'મોડ્યુલર કિચન', 'none', true],
    ['kitchenette', 'Kitchenette', 'छोटा किचन', 'નાનું કિચન', 'none', false],
    ['utensils', 'Utensils provided', 'बर्तन उपलब्ध', 'વાસણ ઉપલબ્ધ', 'none', false],
    ['cook_available', 'Cook available', 'रसोइया उपलब्ध', 'રસોઈયો ઉપલબ્ધ', 'charge', false],
    ['barbecue', 'Barbecue setup', 'बारबेक्यू', 'બારબેક્યુ', 'none', false],
    ['gas_connection', 'Gas connection', 'गैस कनेक्शन', 'ગેસ કનેક્શન', 'none', false],
  ]],
  ['power', [
    ['generator', 'Generator backup', 'जनरेटर बैकअप', 'જનરેટર બેકઅપ', 'none', true],
    ['inverter', 'Inverter', 'इनवर्टर', 'ઇન્વર્ટર', 'none', false],
    ['solar', 'Solar', 'सोलर', 'સોલર', 'none', false],
  ]],
  ['outdoor', [
    ['open_lawn', 'Open lawn', 'खुला लॉन', 'ખુલ્લું લૉન', 'area', true],
    ['garden', 'Garden', 'बगीचा', 'બગીચો', 'none', false],
    ['orchard', 'Orchard', 'बाग', 'બાગ', 'none', false],
    ['bonfire', 'Bonfire allowed', 'बोनफायर की अनुमति', 'બોનફાયર માન્ય', 'none', true],
    ['cricket_pitch', 'Cricket pitch', 'क्रिकेट पिच', 'ક્રિકેટ પિચ', 'none', true],
    ['kids_play', "Kids' play area", 'बच्चों का खेल क्षेत्र', 'બાળકોનું રમતનું સ્થળ', 'none', false],
    ['gazebo', 'Gazebo', 'गज़ेबो', 'ગેઝેબો', 'none', false],
    ['floodlights', 'Floodlights', 'फ्लडलाइट', 'ફ્લડલાઇટ', 'none', false],
  ]],
  ['entertainment', [
    ['dj_allowed', 'DJ / music allowed', 'DJ / संगीत की अनुमति', 'DJ / સંગીત માન્ય', 'none', true],
    ['sound_system', 'Sound system', 'साउंड सिस्टम', 'સાઉન્ડ સિસ્ટમ', 'none', false],
    ['projector_tv', 'Projector or TV', 'प्रोजेक्टर या TV', 'પ્રોજેક્ટર અથવા TV', 'none', false],
    ['indoor_games', 'Indoor games', 'इनडोर गेम्स', 'ઇનડોર ગેમ્સ', 'none', false],
    ['swing', 'Swing', 'झूला', 'હિંચકો', 'none', false],
  ]],
  ['practical', [
    ['parking', 'Parking', 'पार्किंग', 'પાર્કિંગ', 'count', true],
    ['caretaker', 'Caretaker on site', 'केयरटेकर मौजूद', 'કેરટેકર હાજર', 'none', true],
    ['cctv', 'CCTV at entrance', 'प्रवेश पर CCTV', 'પ્રવેશ પર CCTV', 'none', false],
    ['wifi', 'Wifi', 'वाईफाई', 'વાઈફાઈ', 'none', false],
    ['first_aid', 'First-aid kit', 'फर्स्ट एड किट', 'ફર્સ્ટ એડ કિટ', 'none', false],
    ['wheelchair', 'Wheelchair access', 'व्हीलचेयर पहुंच', 'વ્હીલચેર પ્રવેશ', 'none', true],
  ]],
  ['event', [
    ['stage', 'Stage', 'स्टेज', 'સ્ટેજ', 'none', false],
    ['green_room', 'Green room', 'ग्रीन रूम', 'ગ્રીન રૂમ', 'none', false],
    ['banquet_lawn', 'Banquet lawn', 'बैंक्वेट लॉन', 'બેન્ક્વેટ લૉન', 'area', true],
    ['mandap_space', 'Mandap space', 'मंडप स्थान', 'મંડપ સ્થળ', 'none', false],
    ['bulk_parking', 'Bulk parking', 'बड़ी पार्किंग', 'મોટું પાર્કિંગ', 'count', false],
  ]],
];

let order = 0;
let inserted = 0;
let updated = 0;

for (const [group, tags] of GROUPS) {
  for (const [slug, en, hi, gu, valueType, filterable] of tags) {
    order += 1;
    const [before] = await sql`SELECT id FROM amenity WHERE slug = ${slug}`;
    await sql`
      INSERT INTO amenity (slug, group_slug, label_en, label_hi, label_gu,
                           value_type, is_filterable, sort_order)
      VALUES (${slug}, ${group}, ${en}, ${hi}, ${gu},
              ${valueType}, ${filterable}, ${order})
      ON CONFLICT (slug) DO UPDATE SET
        group_slug = EXCLUDED.group_slug,
        label_en = EXCLUDED.label_en,
        label_hi = EXCLUDED.label_hi,
        label_gu = EXCLUDED.label_gu,
        value_type = EXCLUDED.value_type,
        is_filterable = EXCLUDED.is_filterable,
        sort_order = EXCLUDED.sort_order,
        is_active = true`;
    if (before) updated += 1; else inserted += 1;
  }
}

const rows = await sql`
  SELECT group_slug,
         count(*)::int n,
         count(*) FILTER (WHERE is_filterable)::int facets
    FROM amenity GROUP BY group_slug ORDER BY min(sort_order)`;

console.log(`\n  ${inserted} inserted, ${updated} updated\n`);
for (const r of rows) {
  console.log(`  ${r.group_slug.padEnd(16)}${String(r.n).padStart(2)} tags   ${r.facets} filterable`);
}
const [{ total, facets }] = await sql`
  SELECT count(*)::int total, count(*) FILTER (WHERE is_filterable)::int facets FROM amenity`;
console.log(`\n  ${total} tags total, ${facets} search facets\n`);

await sql.end();
