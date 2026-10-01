import test from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedVenue } from '../helpers/venue-fixture.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';

test(
  'Phase 13 HTTP contract: farmhouse byte equality, mismatch 422, hidden venue 404',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    let server;
    try {
      Object.assign(process.env, {
        DATABASE_URL: fixture.url,
        NODE_ENV: 'test',
        NEXT_PUBLIC_SITE_URL: 'http://localhost:3106',
        SESSION_SECRET: 'phase13-contract-test-signing-secret',
        CLOUDINARY_CLOUD_NAME: 'fixture',
        CLOUDINARY_API_KEY: 'fixture',
        CLOUDINARY_API_SECRET: 'fixture',
        LOG_FORMAT: 'off',
      });
      globalThis.__rentraSql = sql;
      const farm = await seedReviewFixture(sql);
      const venue = await seedVenue(sql);
      await sql`UPDATE rentable SET status='live' WHERE id=${farm.listing}`;
      const { createApp } = await import('../../src/app.js');
      const { clearDiscoveryRegistryCache } = await import('../../src/services/db/discovery.js');
      server = await new Promise((resolve) => {
        const listener = createApp().listen(0, '127.0.0.1', () => resolve(listener));
      });
      const base = `http://127.0.0.1:${server.address().port}/api/v1/discovery`;
      const get = (path) => fetch(base + path);
      const before = await (await get('/search')).text();
      assert.ok(JSON.parse(before).data.items.some((row) => row.id === farm.listing));
      const mismatch = await get('/search?vertical=entertainment&category=review-farm');
      assert.equal(mismatch.status, 422);
      assert.equal((await mismatch.json()).code, 'VERTICAL_MISMATCH');
      const foreign = await (await get('/search?vertical=entertainment&slot=night')).json();
      assert.ok(foreign.data.items.some((row) => row.id === venue.venue));
      await sql`UPDATE vertical SET status='hidden' WHERE code='entertainment'`;
      clearDiscoveryRegistryCache(sql);
      assert.equal(
        await (await get('/search')).text(),
        before,
        'launch switch never changes farmhouse search bytes',
      );
      assert.equal((await get('/listings/venue001')).status, 404);
      const registry = await (await get('/registry')).json();
      assert.deepEqual(
        registry.data.verticals.map((row) => row.code),
        ['farmhouse'],
      );
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      delete globalThis.__rentraSql;
      await fixture.drop();
    }
  },
);
