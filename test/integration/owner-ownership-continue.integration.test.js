import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';

test(
  'continuing the ownership step without a new file keeps the document already uploaded',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = fixture.sql;
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = fixture.url;
      process.env.SESSION_SECRET ??= 'owner-ownership-continue-secret-only';
      const f = await seedReviewFixture(sql);
      await sql`UPDATE "user" SET account_status='active' WHERE id=${f.owner}`;
      const { runWithContext } = await import('@/runtime/context.js');
      const { encryptSession } = await import('@/services/auth/session-crypto.js');
      const { issuePortalSession } = await import('@/services/auth/portal-sessions.js');
      const { uploadOwnershipDocument } = await import('@/services/auth/listings.js');
      const token = await encryptSession({
        role: 'client',
        userId: f.owner,
        sessionId: await issuePortalSession(sql, 'client', f.owner, 3600),
      });
      const send = (values) => {
        const form = new FormData();
        for (const [key, value] of Object.entries(values)) form.append(key, value);
        return runWithContext({ req: { cookies: { rentra_session: token } } }, () => uploadOwnershipDocument(null, form));
      };
      const step = { id: f.listing, docType: 'extract_7_12', nameOnDocument: 'Property Owner' };

      // The fixture already holds an uploaded 7/12 extract.
      await sql`UPDATE document SET name_on_document='Property Owner' WHERE id=${f.document}`;
      assert.deepEqual(await send(step), { ok: true, unchanged: true });

      // Changing what the form says still needs the file it describes.
      assert.deepEqual((await send({ ...step, docType: 'sale_deed' })).errors, { file: 'Choose the document' });
      assert.deepEqual((await send({ ...step, nameOnDocument: 'Someone Else' })).errors, { file: 'Choose the document' });

      await sql`UPDATE document SET deleted_at=now() WHERE id=${f.document}`;
      assert.deepEqual((await send(step)).errors, { file: 'Choose the document' }, 'a deleted document is not on file');
      await sql`UPDATE document SET deleted_at=NULL WHERE id=${f.document}`;

      await sql`UPDATE document SET status='rejected' WHERE id=${f.document}`;
      assert.deepEqual((await send(step)).errors, { file: 'Choose the document' }, 'a rejected document still needs a new file');
    } finally {
      await fixture.drop();
    }
  },
);
