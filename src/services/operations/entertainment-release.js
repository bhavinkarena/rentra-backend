import { priceGaps } from '../domain/hourly.js';
import { hourlyBookingConfigSchema } from '../schemas/zod/booking-config.js';

/** Release inspection only. The transaction rejects writes and uses one consistent snapshot. */
export async function inspectEntertainmentRelease(database, migrations, stage = 'expand') {
  if (!['expand', 'pilot', 'public'].includes(stage))
    throw new Error('Choose expand, pilot or public');
  return database.begin('isolation level repeatable read read only', async (tx) => {
    const checks = [];
    const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });
    const [ledger] =
      await tx`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`;
    const applied = ledger.present
      ? await tx`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`
      : [];
    const latest = Number(applied.at(-1)?.created_at || 0);
    check('migration journal current', latest === migrations.at(-1).folderMillis, {
      latest,
      expected: migrations.at(-1).folderMillis,
    });
    for (const migration of migrations.filter(
      (row) => row.folderMillis >= migrations[52].folderMillis,
    )) {
      check(
        `migration ${migration.folderMillis} checksum`,
        applied.some(
          (row) => Number(row.created_at) === migration.folderMillis && row.hash === migration.hash,
        ),
      );
    }
    const [schema] =
      await tx`SELECT to_regclass('public.vertical') IS NOT NULL AND to_regclass('public.rentable_resource') IS NOT NULL AS ready`;
    check('entertainment schema exists', schema.ready);
    if (!schema.ready) return { stage, checks, ready: false };
    const verticals = await tx`SELECT code,status FROM vertical ORDER BY sort_order,code`;
    check(
      'farmhouse remains public',
      verticals.some((row) => row.code === 'farmhouse' && row.status === 'public'),
    );
    const status = verticals.find((row) => row.code === 'entertainment')?.status;
    check(
      'launch switch state',
      stage === 'expand'
        ? status === 'hidden'
        : stage === 'pilot'
          ? status === 'partners'
          : ['partners', 'public'].includes(status),
      { status },
    );
    const constraints =
      await tx`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='inventory_reservation'::regclass AND conname='reservation_active_overlap_excl'`;
    check(
      'per-resource exclusion installed',
      constraints.some(
        (row) =>
          row.definition.includes('resource_id') && row.definition.includes('blocked_start_at'),
      ),
    );
    const [{ hourlyBookings }] =
      await tx`SELECT count(*)::int AS "hourlyBookings" FROM booking WHERE slot::text='hourly' OR resource_id IS NOT NULL`;
    const [{ timeData }] =
      await tx`SELECT EXISTS(SELECT 1 FROM rentable WHERE rental_unit::text='hour') OR EXISTS(SELECT 1 FROM inventory_reservation WHERE resource_id IS NOT NULL) OR EXISTS(SELECT 1 FROM document WHERE doc_type::text IN ('rent_agreement','shop_establishment','gst_certificate')) AS "timeData"`;
    const activities =
      await tx`SELECT slug FROM category WHERE vertical_code='entertainment' AND is_active`;
    const required = [
      'box-cricket',
      'pickleball',
      'badminton',
      'bowling',
      'turf',
      'gaming-zone',
      'trampoline-park',
      'go-karting',
    ];
    check(
      'launch activities seeded',
      required.every((slug) => activities.some((row) => row.slug === slug)),
    );
    const venues =
      await tx`SELECT r.id,r.booking_config AS config,r.category_id AS "categoryId",r.rental_unit AS unit FROM rentable r JOIN category c ON c.id=r.category_id JOIN city ON city.id=r.city_id WHERE c.vertical_code='entertainment' AND r.status='live' AND city.slug='surat'`;
    let bookable = 0;
    for (const venue of venues) {
      const { inventoryReady, ...config } = venue.config || {};
      if (
        !inventoryReady ||
        venue.unit !== 'hour' ||
        !hourlyBookingConfigSchema.safeParse(config).success
      )
        continue;
      const resources =
        await tx`SELECT DISTINCT ra.category_id AS "categoryId" FROM rentable_resource rr JOIN rentable_resource_activity ra ON ra.resource_id=rr.id AND ra.rentable_id=rr.rentable_id JOIN category c ON c.id=ra.category_id WHERE rr.rentable_id=${venue.id} AND rr.is_active AND c.is_active`;
      if (!resources.some((row) => row.categoryId === venue.categoryId)) continue;
      const rates =
        await tx`SELECT category_id AS "categoryId",day_kind AS "dayKind",start_minute AS "startMinute",end_minute AS "endMinute",hourly_rate_minor AS "hourlyRateMinor" FROM rentable_rate WHERE rentable_id=${venue.id}`;
      if (
        resources.every(
          (row) =>
            priceGaps(
              config,
              rates.filter((rate) => rate.categoryId === row.categoryId),
            ).length === 0,
        )
      )
        bookable++;
    }
    if (stage === 'public')
      check('Surat launch threshold', bookable >= 6, { bookable, required: 6 });
    return {
      stage,
      ready: checks.every((row) => row.pass),
      checks,
      verticals,
      liveSurat: venues.length,
      bookableSurat: bookable,
      hourlyBookings,
      rollback: {
        previousBackendSafe: hourlyBookings === 0,
        schemaRollbackSafe: hourlyBookings === 0 && !timeData,
      },
    };
  });
}
