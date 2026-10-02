import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import {
  createSupportRequest,
  replySupportRequest,
  readSupportRequest,
} from '../../src/services/support/service.js';
import { navigationCounts } from '../../src/services/auth/client-inbox.js';
import { capabilitiesFor } from '../../src/services/auth/capabilities.js';

test(
  'applicant support preserves topic, account and record boundaries; navigation counts are owner scoped',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const sql = db.sql;
    try {
      const f = await seedReviewFixture(sql);
      const [applicant] =
        await sql`INSERT INTO "user"(email,role,account_status,name) VALUES ('applicant@fixture.invalid','client','pending_application','Applicant') RETURNING id`;
      const actor = { kind: 'owner', id: applicant.id };
      const input = (category) => ({
        category,
        subject: 'Help with verification',
        body: 'Please explain which verification document is required.',
        orderId: null,
        propertyId: null,
        privacyRequestId: null,
        requestKey: randomUUID(),
      });
      assert.ok(
        capabilitiesFor(
          { role: 'client', accountStatus: 'pending_application' },
          'client',
        ).includes('client.support.write'),
      );
      assert.ok(
        !capabilitiesFor(
          { role: 'client', accountStatus: 'pending_application' },
          'client',
        ).includes('client.records.read'),
      );
      for (const category of ['verification', 'account', 'other']) {
        const opened = await createSupportRequest(sql, actor, input(category));
        await replySupportRequest(sql, actor, {
          id: opened.id,
          version: 0,
          body: 'Here is a little more context.',
          state: 'open',
          requestKey: randomUUID(),
        });
        assert.equal((await readSupportRequest(sql, actor, opened.id)).category, category);
        await assert.rejects(readSupportRequest(sql, { kind: 'owner', id: f.other }, opened.id), {
          code: 'NOT_FOUND',
        });
        if (category === 'verification')
          await replySupportRequest(
            sql,
            { kind: 'admin', id: f.admin },
            {
              id: opened.id,
              version: 1,
              body: 'Please confirm the document type.',
              state: 'waiting_customer',
              requestKey: randomUUID(),
              internal: false,
            },
          );
      }
      await assert.rejects(createSupportRequest(sql, actor, input('privacy')), {
        code: 'INVALID_TOPIC',
      });
      await assert.rejects(
        createSupportRequest(sql, actor, { ...input('other'), propertyId: f.listing }),
        { code: 'INVALID_TOPIC' },
      );
      const pendingCounts = await navigationCounts(sql, {
        id: applicant.id,
        accountStatus: 'pending_application',
      });
      assert.equal(pendingCounts.supportAwaiting, 1);
      assert.equal(pendingCounts.unread, 1);
      assert.equal(pendingCounts.bookingsAction, undefined);
      const ownerCounts = await navigationCounts(sql, { id: f.owner, accountStatus: 'active' });
      assert.equal(ownerCounts.supportAwaiting, 0);
      assert.equal(ownerCounts.propertiesNeedsChanges, 1);
      assert.equal(ownerCounts.reviewsUnreplied, 0);
      const otherCounts = await navigationCounts(sql, { id: f.other, accountStatus: 'active' });
      assert.equal(otherCounts.propertiesNeedsChanges, 0);
      await sql`UPDATE "user" SET account_status='suspended' WHERE id=${applicant.id}`;
      await assert.rejects(createSupportRequest(sql, actor, input('other')), { code: 'NOT_FOUND' });
    } finally {
      await db.drop();
    }
  },
);
