import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import {
  createSupportRequest,
  replySupportRequest,
  readSupportRequest,
  manageSupportRequest,
  supportAttachment,
} from '../../src/services/support/service.js';
import { memoryEvidenceStore } from '../../src/services/uploads/evidence-store.js';

const png = (seed = 0) =>
  new File(
    [Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(24, seed)])],
    'photo.png',
    { type: 'image/png' },
  );

test(
  'CP17 storage failure saves nothing, assignee rules, malformed input, cross-case keys, update link, customer photos',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = db.sql,
      store = memoryEvidenceStore();
    try {
      const f = await seedReviewFixture(sql),
        booking = await seedConfirmedBooking(sql, f.listing);
      const [session] =
        await sql`INSERT INTO customer_session(user_id,expires_at) VALUES(${booking.customer},now()+interval '1 day') RETURNING id`;
      const customer = {
          kind: 'customer',
          session: { role: 'customer', userId: booking.customer, sessionId: session.id },
        },
        owner = { kind: 'owner', id: f.owner },
        admin = { kind: 'admin', id: f.admin };
      const open = (subject) =>
        createSupportRequest(sql, owner, {
          category: 'booking',
          subject,
          body: 'Please help with the arrival instructions for this booking.',
          orderId: booking.order,
          propertyId: f.listing,
          privacyRequestId: null,
          requestKey: randomUUID(),
        });
      const a = await open('Client case A'),
        b = await open('Client case B');
      const messages = async (id) =>
        (await sql`SELECT count(*)::int n FROM support_message WHERE request_id=${id}`)[0].n;
      const photos = async () => (await sql`SELECT count(*)::int n FROM support_attachment`)[0].n;
      const version = async (id) =>
        (await sql`SELECT version FROM support_request WHERE id=${id}`)[0].version;

      // The same request key on a different case is refused; it never replays or touches the other case.
      const key = randomUUID();
      await replySupportRequest(
        sql,
        owner,
        {
          id: a.id,
          version: await version(a.id),
          body: 'Follow-up on case A.',
          state: 'open',
          requestKey: key,
        },
        process.env,
        [],
        store,
      );
      await assert.rejects(
        replySupportRequest(
          sql,
          owner,
          {
            id: b.id,
            version: await version(b.id),
            body: 'Follow-up on case A.',
            state: 'open',
            requestKey: key,
          },
          process.env,
          [],
          store,
        ),
        { code: 'IDEMPOTENCY_CONFLICT' },
      );
      assert.deepEqual([await messages(a.id), await messages(b.id)], [2, 1]);

      // Photo storage unavailable or failing: no message, no attachment, no version change.
      const offline = {
        configured: () => false,
        put: async () => {
          throw new Error('offline');
        },
        get: async () => null,
      };
      const failing = {
        configured: () => true,
        put: async () => {
          throw new Error('storage write failed');
        },
        get: async () => null,
      };
      const before = [await messages(a.id), await photos(), await version(a.id)];
      const reply = async (extra) => ({
        id: a.id,
        version: await version(a.id),
        body: 'Public reply with a photo attached.',
        state: 'waiting_customer',
        requestKey: randomUUID(),
        ...extra,
      });
      await assert.rejects(
        replySupportRequest(sql, admin, await reply(), process.env, [png(1)], offline),
        (error) => error.code === 'UPLOADS_UNAVAILABLE' && error.statusCode === 503,
      );
      await assert.rejects(
        replySupportRequest(sql, admin, await reply(), process.env, [png(2)], failing),
        /storage write failed/,
      );
      assert.deepEqual([await messages(a.id), await photos(), await version(a.id)], before);
      assert.equal(
        (await sql`SELECT count(*)::int n FROM client_update WHERE action='support_reply'`)[0].n,
        0,
        'no update for an unsaved reply',
      );

      // Assignees must be active support operators; malformed input is refused before any write.
      const manage = async (extra) => ({
        id: a.id,
        version: await version(a.id),
        assignedTo: f.admin,
        priority: 'normal',
        relatedRequestId: null,
        reason: 'Assign to the support shift.',
        ...extra,
      });
      await assert.rejects(
        manageSupportRequest(sql, admin, await manage({ assignedTo: f.limited })),
        { code: 'INVALID_ASSIGNEE' },
      );
      await sql`UPDATE admin_user SET is_active=false WHERE id=${f.second}`;
      await assert.rejects(
        manageSupportRequest(sql, admin, await manage({ assignedTo: f.second })),
        { code: 'INVALID_ASSIGNEE' },
      );
      await assert.rejects(
        manageSupportRequest(sql, admin, await manage({ priority: 'critical' })),
      );
      await assert.rejects(
        manageSupportRequest(sql, admin, await manage({ assignedTo: 'not-a-uuid' })),
      );
      await assert.rejects(manageSupportRequest(sql, admin, await manage({ reason: 'x' })));
      assert.equal(
        (await sql`SELECT assigned_to FROM support_request WHERE id=${a.id}`)[0].assigned_to,
        null,
      );
      await assert.rejects(supportAttachment(sql, owner, a.id, 'not-a-uuid', process.env, store), {
        code: 'NOT_FOUND',
      });

      // A saved public reply creates exactly one client update that links to this support thread.
      await replySupportRequest(sql, admin, await reply(), process.env, [png(3)], store);
      const [update] = await sql`SELECT * FROM client_update WHERE action='support_reply'`;
      assert.equal(update.detail.supportId, a.id);
      assert.deepEqual(
        [update.category, update.kind, update.client_id],
        ['case', 'action', f.owner],
      );

      // Customer photo replies are private to the customer and Rentra.
      const guest = await createSupportRequest(sql, customer, {
        category: 'booking',
        subject: 'Customer photo case',
        body: 'Photo of the gate problem at arrival is attached below.',
        orderId: booking.order,
        privacyRequestId: null,
        requestKey: randomUUID(),
      });
      await replySupportRequest(
        sql,
        customer,
        {
          id: guest.id,
          version: await version(guest.id),
          body: 'Here is the gate photo.',
          state: 'open',
          requestKey: randomUUID(),
        },
        process.env,
        [png(4)],
        store,
      );
      const guestView = await readSupportRequest(sql, customer, guest.id);
      const photoId = guestView.messages.flatMap((m) => m.attachments ?? []).at(0)?.id;
      assert.ok(photoId);
      assert.equal(
        (await supportAttachment(sql, customer, guest.id, photoId, process.env, store)).mimeType,
        'image/png',
      );
      assert.equal(
        (await supportAttachment(sql, admin, guest.id, photoId, process.env, store)).mimeType,
        'image/png',
      );
      await assert.rejects(supportAttachment(sql, owner, guest.id, photoId, process.env, store), {
        code: 'NOT_FOUND',
      });
    } finally {
      await db.drop();
    }
  },
);
