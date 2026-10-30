import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import {
  createSupportRequest,
  replySupportRequest,
  addSupportNote,
  readSupportRequest,
  listSupportRequests,
  supportAttachment,
} from '../../src/services/support/service.js';
import { memoryEvidenceStore } from '../../src/services/uploads/evidence-store.js';

const png = () =>
  new File([Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex')], 'n.png', {
    type: 'image/png',
  });

test(
  'Story 4.3 private notes: read-only permission, no state change, privacy, replay',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = db.sql,
      store = memoryEvidenceStore();
    try {
      const f = await seedReviewFixture(sql),
        booking = await seedConfirmedBooking(sql, f.listing);
      const [session] =
        await sql`INSERT INTO auth_session(user_id,expires_at) VALUES(${booking.customer},now()+interval '1 day') RETURNING id`;
      const customer = {
          kind: 'customer',
          session: { role: 'customer', userId: booking.customer, sessionId: session.id },
        },
        owner = { kind: 'owner', id: f.owner },
        admin = { kind: 'admin', id: f.admin };
      const [ro] =
        await sql`INSERT INTO admin_user(email,name,password_hash,permissions) VALUES ('support-ro@fixture.invalid','RO','x','["admin.support.read"]') RETURNING id`;
      const [none] =
        await sql`INSERT INTO admin_user(email,name,password_hash,permissions) VALUES ('support-none@fixture.invalid','None','x','[]') RETURNING id`;
      const [wo] =
        await sql`INSERT INTO admin_user(email,name,password_hash,permissions) VALUES ('support-wo@fixture.invalid','WO','x','["admin.support.write"]') RETURNING id`;
      const [gone] =
        await sql`INSERT INTO admin_user(email,name,password_hash,permissions,is_active) VALUES ('support-gone@fixture.invalid','Gone','x',NULL,false) RETURNING id`;
      const reader = { kind: 'admin', id: ro.id };
      const { id } = await createSupportRequest(sql, customer, {
        category: 'booking',
        subject: 'Arrival support case',
        body: 'Please help with the arrival instructions for this booking.',
        orderId: booking.order,
        privacyRequestId: null,
        requestKey: randomUUID(),
      });
      const row = async () =>
        (
          await sql`SELECT state,version,first_response_at,updated_at FROM support_request WHERE id=${id}`
        )[0];
      const count = async () =>
        (await sql`SELECT count(*)::int n FROM support_message WHERE request_id=${id}`)[0].n;
      const before = await row(),
        guestView = await readSupportRequest(sql, customer, id); // guest has version 0 open

      // Read-only admin adds a note with a photo: one internal row, case untouched.
      const note = { id, body: 'Checked with the owner by phone.', requestKey: randomUUID() };
      assert.deepEqual(await addSupportNote(sql, reader, note, process.env, [png()], store), {
        id,
      });
      assert.deepEqual(await row(), before);
      assert.equal(await count(), 2);
      assert.equal(
        (
          await sql`SELECT count(*)::int n FROM audit_log WHERE action='support_internal_note' AND entity_id=${id}`
        )[0].n,
        1,
      );
      // Replay: same key/body returns original; changed body conflicts.
      assert.deepEqual(await addSupportNote(sql, reader, note, process.env, [png()], store), {
        id,
      });
      assert.equal(await count(), 2);
      await assert.rejects(
        addSupportNote(sql, reader, { ...note, body: 'A different note.' }, process.env, [], store),
        { code: 'IDEMPOTENCY_CONFLICT' },
      );
      // Strict schema: state/version/priority keys refused, nothing saved.
      for (const extra of [
        { state: 'resolved' },
        { version: 0 },
        { priority: 'urgent' },
        { amount: 1 },
      ])
        await assert.rejects(
          addSupportNote(
            sql,
            reader,
            { ...note, ...extra, requestKey: randomUUID() },
            process.env,
            [],
            store,
          ),
          {
            name: 'ZodError',
          },
        );
      assert.equal(await count(), 2);
      // Non-admins and admins without read get 404.
      for (const actor of [
        customer,
        owner,
        { kind: 'admin', id: none.id },
        { kind: 'admin', id: gone.id },
      ])
        await assert.rejects(addSupportNote(sql, actor, { ...note, requestKey: randomUUID() }), {
          code: 'NOT_FOUND',
        });

      // Write-only admin may add a note; DB refuses a public message from a read-only admin.
      await addSupportNote(
        sql,
        { kind: 'admin', id: wo.id },
        { ...note, requestKey: randomUUID() },
      );
      await assert.rejects(
        sql`INSERT INTO support_message(request_id,actor_kind,actor_id,body,state_after,request_key,request_hash,internal) VALUES(${id},'admin',${ro.id},'Public by read-only.','open',${randomUUID()},${'a'.repeat(64)},false)`,
        { code: '23514' },
      );
      assert.equal(await count(), 3);
      // Reply cannot carry internal; read-only admin cannot reply.
      const reply = {
        id,
        body: 'We are on it.',
        state: 'in_progress',
        version: 0,
        requestKey: randomUUID(),
      };
      await assert.rejects(replySupportRequest(sql, admin, { ...reply, internal: true }), {
        name: 'ZodError',
      });
      await assert.rejects(replySupportRequest(sql, reader, reply), { code: 'NOT_FOUND' });
      // Capability flag.
      assert.equal((await readSupportRequest(sql, reader, id)).canReply, false);
      assert.equal((await readSupportRequest(sql, admin, id)).canReply, true);

      // Guest still sees no note/photo; their open version 0 still replies fine.
      const guest = await readSupportRequest(sql, customer, id);
      assert.equal(guest.messages.length, 1);
      assert.equal(guest.canReply, undefined);
      assert.equal(guest.version, guestView.version);
      assert.equal(
        (await listSupportRequests(sql, customer)).items[0].updatedAt,
        guestView.updatedAt,
      );
      const photoId = (await readSupportRequest(sql, admin, id)).messages[1].attachments[0].id;
      await assert.rejects(supportAttachment(sql, customer, id, photoId, process.env, store), {
        code: 'NOT_FOUND',
      });
      assert.equal(
        (await supportAttachment(sql, reader, id, photoId, process.env, store)).mimeType,
        'image/png',
      );
      await replySupportRequest(sql, customer, {
        id,
        body: 'Any update?',
        state: 'open',
        version: guestView.version,
        requestKey: randomUUID(),
      });
      // Public admin reply changes state and sets first response.
      await replySupportRequest(sql, admin, { ...reply, version: 1 });
      const after = await row();
      assert.equal(after.state, 'in_progress');
      assert.ok(after.first_response_at);
      assert.equal((await readSupportRequest(sql, customer, id)).messages.length, 3);

      // Owner on a client-participant case never sees a note.
      const ownerCase = await createSupportRequest(sql, owner, {
        category: 'booking',
        subject: 'Owner arrival case',
        body: 'Please help with the arrival instructions for this booking.',
        orderId: booking.order,
        propertyId: f.listing,
        privacyRequestId: null,
        requestKey: randomUUID(),
      });
      await addSupportNote(sql, reader, {
        id: ownerCase.id,
        body: 'Owner must not see this.',
        requestKey: randomUUID(),
      });
      const seen = await readSupportRequest(sql, owner, ownerCase.id);
      assert.equal(seen.messages.length, 1);
      assert.ok(!seen.messages.some((m) => m.internal));
    } finally {
      await db.drop();
    }
  },
);
