import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import {
  listCatalogues,
  readCatalogue,
  catalogueCommand,
} from '../../src/services/catalogues/service.js';
import {
  getDiscoveryRegistry,
  countDiscoveryRoute,
  searchDiscovery,
} from '../../src/services/db/discovery.js';
import { resolveDiscoveryRoute, parseDiscoveryQuery } from '../../src/services/domain/discovery.js';

test(
  'CP24 catalogue authorization, immutable references, preview freshness, archive and discovery',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = db.sql;
    try {
      const f = await seedReviewFixture(sql),
        booked = await seedConfirmedBooking(sql, f.listing);
      const admin = { kind: 'admin', id: f.admin },
        second = { kind: 'admin', id: f.second };
      const [listing] = await sql`SELECT * FROM rentable WHERE id=${f.listing}`;
      const [snapshot] =
        await sql`SELECT listing_snapshot,policy_snapshot FROM booking_order WHERE id=${booked.order}`;
      const original = await getDiscoveryRegistry(sql);
      const route = resolveDiscoveryRoute(original, [
        'review-city',
        'review-farm',
        'area',
        'review-area',
      ]);
      assert.equal(await countDiscoveryRoute(route, sql), 0);
      assert.equal((await searchDiscovery(parseDiscoveryQuery().filters, route, sql)).total, 0);
      const input = {
        command: 'save',
        version: 1,
        fields: { label: 'Farm stays', sortOrder: 4, isActive: true },
        reason: 'Clarify the category label',
        preview: true,
      };
      for (const actor of [
        { kind: 'owner', id: f.owner },
        { kind: 'customer', id: booked.customer },
        { kind: 'admin', id: f.limited },
      ]) {
        await assert.rejects(listCatalogues(sql, actor, 'categories'), { statusCode: 403 });
        await assert.rejects(
          catalogueCommand(sql, actor, 'categories', listing.category_id, input),
          { statusCode: 403 },
        );
      }
      await sql`UPDATE admin_user SET permissions='["admin.catalogues.read"]'::jsonb WHERE id=${f.limited}`;
      assert.equal(
        (await listCatalogues(sql, { kind: 'admin', id: f.limited }, 'categories')).canWrite,
        false,
      );
      await assert.rejects(
        catalogueCommand(
          sql,
          { kind: 'admin', id: f.limited },
          'categories',
          listing.category_id,
          input,
        ),
        { statusCode: 403 },
      );
      await assert.rejects(listCatalogues(sql, admin, 'constructor'), { statusCode: 404 });
      await assert.rejects(listCatalogues(sql, admin, 'categories', { page: '-1' }), {
        code: 'INVALID_CATALOGUE',
      });
      assert.equal(
        (await listCatalogues(sql, admin, 'categories', { q: 'Farm' })).items[0].usageCount,
        1,
      );
      assert.equal((await listCatalogues(sql, admin, 'categories', { q: '%' })).items.length, 0);
      const preview = await catalogueCommand(sql, admin, 'categories', listing.category_id, input);
      assert.equal(preview.impact.count, 1);
      assert.equal(preview.canApply, true);
      assert(preview.impact.paths.includes(route.path));
      assert.equal(
        (await readCatalogue(sql, admin, 'categories', listing.category_id)).record.name,
        'Farmhouse',
      );
      await assert.rejects(
        catalogueCommand(sql, admin, 'categories', listing.category_id, {
          ...input,
          preview: false,
        }),
        { code: 'STALE_PREVIEW' },
      );
      await assert.rejects(
        catalogueCommand(sql, admin, 'categories', listing.category_id, {
          ...input,
          fields: { ...input.fields, form: 'movable' },
        }),
        { code: 'INVALID_CATALOGUE' },
      );
      const secondPreview = await catalogueCommand(
        sql,
        second,
        'categories',
        listing.category_id,
        input,
      );
      assert.notEqual(secondPreview.previewHash, preview.previewHash);
      const attempts = await Promise.allSettled([
        catalogueCommand(sql, admin, 'categories', listing.category_id, {
          ...input,
          preview: false,
          previewHash: preview.previewHash,
        }),
        catalogueCommand(sql, second, 'categories', listing.category_id, {
          ...input,
          preview: false,
          previewHash: secondPreview.previewHash,
        }),
      ]);
      assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(attempts.find((r) => r.status === 'rejected').reason.code, 'STALE_CATALOGUE');
      const edited = await readCatalogue(sql, admin, 'categories', listing.category_id);
      assert.equal(edited.record.name, 'Farm stays');
      assert.equal(edited.record.version, 2);
      assert.equal(
        resolveDiscoveryRoute(await getDiscoveryRegistry(sql), [
          'review-city',
          'review-farm',
          'area',
          'review-area',
        ]).path,
        route.path,
      );
      const archive = { ...input, version: 2, fields: { ...input.fields, isActive: false } };
      const blocked = await catalogueCommand(
        sql,
        admin,
        'categories',
        listing.category_id,
        archive,
      );
      assert.equal(blocked.canApply, false);
      await assert.rejects(
        catalogueCommand(sql, admin, 'categories', listing.category_id, {
          ...archive,
          preview: false,
          previewHash: blocked.previewHash,
        }),
        { code: 'MIGRATION_REQUIRED' },
      );
      async function create(type, fields) {
        const value = {
          command: 'save',
          version: 0,
          fields,
          reason: 'Add a fixture catalogue entry',
          preview: true,
        };
        const p = await catalogueCommand(sql, admin, type, 'new', value);
        return catalogueCommand(sql, admin, type, 'new', {
          ...value,
          preview: false,
          previewHash: p.previewHash,
        });
      }
      const fresh = await create('categories', {
        label: 'New category',
        slug: 'new-category',
        sortOrder: 0,
        isActive: true,
        form: 'fixed',
        rentalUnit: 'slot',
      });
      await assert.rejects(
        create('categories', {
          label: ' NEW CATEGORY ',
          slug: 'another-category',
          sortOrder: 0,
          isActive: true,
          form: 'fixed',
          rentalUnit: 'slot',
        }),
        { code: 'DUPLICATE_LABEL' },
      );
      await assert.rejects(
        create('categories', {
          label: 'Other label',
          slug: 'new-category',
          sortOrder: 0,
          isActive: true,
          form: 'fixed',
          rentalUnit: 'slot',
        }),
        { code: 'DUPLICATE_SLUG' },
      );
      const replace = {
        command: 'replace',
        version: 2,
        replacementId: fresh.id,
        reason: 'Review category replacement effects',
        preview: true,
      };
      const replacement = await catalogueCommand(
        sql,
        admin,
        'categories',
        listing.category_id,
        replace,
      );
      assert.equal(replacement.canApply, false);
      assert.equal(replacement.impact.count, 1);
      const inactive = {
        ...input,
        version: 1,
        fields: { label: 'New category', sortOrder: 0, isActive: false },
      };
      await sql`INSERT INTO redirect(from_path,to_path) VALUES ('/legacy-fixture','/review-city/new-category')`;
      const redirectPreview = await catalogueCommand(sql, admin, 'categories', fresh.id, inactive);
      assert.equal(redirectPreview.canApply, false);
      assert.equal(redirectPreview.impact.redirects.length, 1);
      await sql`DELETE FROM redirect WHERE from_path='/legacy-fixture'`;
      const p = await catalogueCommand(sql, admin, 'categories', fresh.id, inactive);
      // A reference arrives after preview. Confirmation must not trust its original count.
      await sql`UPDATE rentable SET category_id=${fresh.id} WHERE id=${f.listing}`;
      await assert.rejects(
        catalogueCommand(sql, admin, 'categories', fresh.id, {
          ...inactive,
          preview: false,
          previewHash: p.previewHash,
        }),
        { code: 'MIGRATION_REQUIRED' },
      );
      await sql`UPDATE rentable SET category_id=${listing.category_id} WHERE id=${f.listing}`;
      const p2 = await catalogueCommand(sql, admin, 'categories', fresh.id, inactive);
      await catalogueCommand(sql, admin, 'categories', fresh.id, {
        ...inactive,
        preview: false,
        previewHash: p2.previewHash,
      });
      assert(!(await getDiscoveryRegistry(sql)).categories.some((r) => r.id === fresh.id));
      await assert.rejects(sql`UPDATE rentable SET category_id=${fresh.id} WHERE id=${f.listing}`, {
        code: '23514',
      });
      const area = await create('areas', {
        label: 'New locality',
        slug: 'new-locality',
        cityId: listing.city_id,
        sortOrder: 0,
        isActive: true,
      });
      await assert.rejects(
        catalogueCommand(sql, admin, 'areas', area.id, {
          ...input,
          fields: {
            label: 'New locality',
            sortOrder: 0,
            isActive: true,
            centre: { latitude: 91, longitude: 72, approved: true },
          },
        }),
        { code: 'INVALID_CATALOGUE' },
      );
      await assert.rejects(
        catalogueCommand(sql, admin, 'areas', area.id, {
          ...input,
          fields: {
            label: 'New locality',
            sortOrder: 0,
            isActive: true,
            centre: { latitude: 21, longitude: 72, approved: false },
          },
        }),
        { code: 'INVALID_CATALOGUE' },
      );
      const city = await create('cities', {
        label: 'Other city',
        slug: 'other-city',
        state: 'Gujarat',
        sortOrder: 0,
        isActive: true,
      });
      const otherArea = await create('areas', {
        label: 'New locality',
        slug: 'new-locality',
        cityId: city.id,
        sortOrder: 0,
        isActive: true,
      });
      await assert.rejects(
        catalogueCommand(sql, admin, 'areas', area.id, {
          ...replace,
          version: 1,
          replacementId: otherArea.id,
        }),
        { code: 'INVALID_REPLACEMENT' },
      );
      const cityPreview = await catalogueCommand(sql, admin, 'cities', city.id, {
        ...input,
        fields: { label: 'Other city', state: 'Gujarat', sortOrder: 0, isActive: false },
      });
      assert.equal(cityPreview.canApply, false);
      assert.equal(cityPreview.impact.children.length, 1);
      const countAmenity = await create('amenities', {
        label: 'Spaces',
        slug: 'spaces',
        sortOrder: 0,
        isActive: true,
        labelHi: '',
        labelGu: '',
        groupSlug: 'outdoors',
        isFilterable: true,
        valueType: 'count',
      });
      const [amenity] = await sql`SELECT * FROM amenity WHERE slug='pool'`;
      const amenityReplacement = await catalogueCommand(sql, admin, 'amenities', amenity.id, {
        ...replace,
        version: 1,
        replacementId: countAmenity.id,
      });
      assert.match(amenityReplacement.blocked, /Value type changes/);
      assert.equal(amenityReplacement.impact.count, 1);
      const amFields = {
        label: 'Pool',
        sortOrder: 1,
        isActive: true,
        labelHi: 'पूल',
        labelGu: 'પૂલ',
        groupSlug: 'outdoors',
        isFilterable: true,
      };
      await assert.rejects(
        catalogueCommand(sql, admin, 'amenities', amenity.id, {
          ...input,
          fields: { ...amFields, valueType: 'count' },
        }),
        { code: 'INVALID_CATALOGUE' },
      );
      const ap = await catalogueCommand(sql, admin, 'amenities', amenity.id, {
        ...input,
        fields: amFields,
      });
      await catalogueCommand(sql, admin, 'amenities', amenity.id, {
        ...input,
        fields: amFields,
        preview: false,
        previewHash: ap.previewHash,
      });
      assert(
        (await getDiscoveryRegistry(sql)).amenities.some(
          (r) => r.slug === 'pool' && r.name === 'Pool',
        ),
      );
      assert.deepEqual(
        (
          await sql`SELECT listing_snapshot,policy_snapshot FROM booking_order WHERE id=${booked.order}`
        )[0],
        snapshot,
      );
      assert.equal(
        (await sql`SELECT category_id FROM rentable WHERE id=${f.listing}`)[0].category_id,
        listing.category_id,
      );
      assert.equal(
        (
          await sql`SELECT count(*)::int count FROM audit_log WHERE entity='catalogue.categories' AND action='catalogue.update'`
        )[0].count,
        2,
      );
      await sql`UPDATE admin_user SET is_active=false WHERE id=${f.admin}`;
      await assert.rejects(readCatalogue(sql, admin, 'categories', listing.category_id), {
        statusCode: 403,
      });
    } finally {
      await db.drop();
    }
  },
);
