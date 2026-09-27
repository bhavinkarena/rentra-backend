import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import {
  createSupportRequest,
  replySupportRequest,
  readSupportRequest,
  listSupportRequests,
  manageSupportRequest,
  supportAttachment,
} from '../../src/services/support/service.js';
import { memoryEvidenceStore } from '../../src/services/uploads/evidence-store.js';

test(
  'CP17 participant isolation, private notes/photos, assignments, races and replay',
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
        admin = { kind: 'admin', id: f.admin },
        other = { kind: 'owner', id: f.other };
      const value = {
        category: 'booking',
        subject: 'Arrival support case',
        body: 'Please help with the arrival instructions for this booking.',
        orderId: booking.order,
        privacyRequestId: null,
        requestKey: randomUUID(),
      };
      const guest = await createSupportRequest(sql, customer, value);
      const input = { ...value, propertyId: f.listing, requestKey: randomUUID() };
      const race = await Promise.all([
        createSupportRequest(sql, owner, input),
        createSupportRequest(sql, owner, input),
      ]);
      assert.equal(race[0].id, race[1].id);
      const id = race[0].id;
      await assert.rejects(readSupportRequest(sql, customer, id), { code: 'NOT_FOUND' });
      await assert.rejects(readSupportRequest(sql, owner, guest.id), { code: 'NOT_FOUND' });
      await assert.rejects(readSupportRequest(sql, other, id), { code: 'NOT_FOUND' });
      await assert.rejects(
        createSupportRequest(sql, other, { ...input, requestKey: randomUUID() }),
        { code: 'NOT_FOUND' },
      );
      const manage = {
        id,
        version: 0,
        assignedTo: f.admin,
        priority: 'urgent',
        relatedRequestId: guest.id,
        reason: 'Coordinate two separate participant cases.',
      };
      const assignments = await Promise.allSettled([
        manageSupportRequest(sql, admin, manage),
        manageSupportRequest(sql, admin, manage),
      ]);
      assert.equal(assignments.filter((x) => x.status === 'fulfilled').length, 1);
      assert.equal(
        (await listSupportRequests(sql, admin, { assignment: 'mine', participant: 'client' }))
          .total,
        1,
      );
      const png = () =>
        new File([Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex')], 'private.png', {
          type: 'image/png',
        });
      const note = {
        id,
        version: 1,
        body: 'Internal investigation: never disclose to either participant.',
        state: 'resolved',
        internal: true,
        requestKey: randomUUID(),
      };
      await replySupportRequest(sql, admin, note, process.env, [png()], store);
      const privateRecord = await readSupportRequest(sql, admin, id),
        publicRecord = await readSupportRequest(sql, owner, id);
      assert.equal(privateRecord.messages.length, 2);
      assert.equal(publicRecord.messages.length, 1);
      assert.equal(publicRecord.state, 'open');
      assert.equal(publicRecord.relatedRequestId, undefined);
      assert.equal(publicRecord.assignedTo, undefined);
      assert.equal(publicRecord.history, undefined);
      assert.equal(
        (await sql`SELECT count(*)::int n FROM client_update WHERE action='support_reply'`)[0].n,
        0,
      );
      const privateId = privateRecord.messages[1].attachments[0].id;
      await assert.rejects(supportAttachment(sql, owner, id, privateId, process.env, store), {
        code: 'NOT_FOUND',
      });
      await assert.rejects(supportAttachment(sql, customer, id, privateId, process.env, store), {
        code: 'NOT_FOUND',
      });
      assert.equal(
        (await supportAttachment(sql, admin, id, privateId, process.env, store)).mimeType,
        'image/png',
      );
      await assert.rejects(
        replySupportRequest(
          sql,
          owner,
          { ...note, version: 2, requestKey: randomUUID() },
          process.env,
          [],
          store,
        ),
        { code: 'INVALID_STATE' },
      );
      const reply = {
        id,
        version: 2,
        body: 'Client-visible reply with a private photo.',
        state: 'waiting_customer',
        requestKey: randomUUID(),
      };
      await replySupportRequest(sql, admin, reply, process.env, [png()], store);
      await replySupportRequest(sql, admin, reply, process.env, [png()], store);
      await assert.rejects(
        replySupportRequest(
          sql,
          admin,
          { ...reply, body: 'Different replay body' },
          process.env,
          [png()],
          store,
        ),
        { code: 'IDEMPOTENCY_CONFLICT' },
      );
      assert.equal(
        (await sql`SELECT count(*)::int n FROM client_update WHERE action='support_reply'`)[0].n,
        1,
      );
      const record = await readSupportRequest(sql, owner, id);
      assert.equal(record.messages.length, 2);
      const photo = record.messages[1].attachments[0];
      assert.ok((await supportAttachment(sql, owner, id, photo.id, process.env, store)).body);
      await assert.rejects(supportAttachment(sql, other, id, photo.id, process.env, store), {
        code: 'NOT_FOUND',
      });
      await assert.rejects(
        supportAttachment(sql, customer, guest.id, photo.id, process.env, store),
        { code: 'NOT_FOUND' },
      );
      await assert.rejects(
        replySupportRequest(
          sql,
          owner,
          { ...reply, version: 3, state: 'open', requestKey: randomUUID() },
          process.env,
          [new File(['<script>bad</script>'], 'fake.png', { type: 'image/png' })],
          store,
        ),
        { code: 'INVALID_ATTACHMENT' },
      );
      assert.equal((await readSupportRequest(sql, owner, id)).version, 3);
      const closing = { ...reply, version: 3, state: 'resolved', requestKey: randomUUID() };
      await replySupportRequest(sql, owner, closing, process.env, [], store);
      assert.equal((await readSupportRequest(sql, owner, id)).state, 'resolved');
      assert.equal(
        (await sql`SELECT state FROM booking_order WHERE id=${booking.order}`)[0].state,
        'confirmed',
      );
      await assert.rejects(sql`UPDATE support_message SET body='erased' WHERE request_id=${id}`);
      await assert.rejects(sql`UPDATE support_request SET client_id=${f.other} WHERE id=${id}`);
      await sql`UPDATE "user" SET account_status='suspended' WHERE id=${f.owner}`;
      await assert.rejects(readSupportRequest(sql, owner, id), { code: 'NOT_FOUND' });
    } finally {
      await db.drop();
    }
  },
);
