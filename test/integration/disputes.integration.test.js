import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import { seedFinanceFixture } from '../helpers/finance-fixture.js';
import { memoryEvidenceStore } from '../../src/services/uploads/evidence-store.js';
import {
  createDispute,
  readDispute,
  listDisputes,
  disputeContext,
  replyDispute,
  manageDispute,
  disputeAttachment,
} from '../../src/services/disputes/service.js';

test(
  'CP23 private evidence, participant isolation, assignment and conflicting resolution',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = db.sql,
      store = memoryEvidenceStore();
    try {
      const f = await seedReviewFixture(sql),
        b = await seedConfirmedBooking(sql, f.listing);
      const [visit] = await sql`SELECT id FROM booking WHERE order_id=${b.order}`;
      const [session] =
        await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${b.customer},now()+interval '1 day') RETURNING id`;
      const owner = { kind: 'owner', id: f.owner },
        admin = { kind: 'admin', id: f.admin },
        other = { kind: 'owner', id: f.other },
        customer = {
          kind: 'customer',
          session: { role: 'customer', userId: b.customer, sessionId: session.id },
        };
      const input = {
        orderId: b.order,
        visitId: visit.id,
        kind: 'deposit',
        subject: 'Deposit concern for recorded visit',
        body: 'Private owner claim with recorded observations.',
        claimedMinor: 50000,
        requestKey: randomUUID(),
      };
      const c = await createDispute(sql, owner, input);
      assert.equal((await createDispute(sql, owner, input)).id, c.id);
      await assert.rejects(
        createDispute(sql, owner, {
          ...input,
          body: 'Different content with the same replay key.',
        }),
        { code: 'REQUEST_KEY_CONFLICT' },
      );
      await assert.rejects(createDispute(sql, other, { ...input, requestKey: randomUUID() }), {
        statusCode: 404,
      });
      await assert.rejects(disputeContext(sql, other, b.order), { statusCode: 404 });
      await assert.rejects(readDispute(sql, other, c.id), { statusCode: 404 });
      await assert.rejects(readDispute(sql, { kind: 'admin', id: f.limited }, c.id), {
        statusCode: 403,
      });
      assert.equal((await listDisputes(sql, other)).items.length, 0);
      assert.equal((await readDispute(sql, customer, c.id)).messages.length, 0);
      const initial = await readDispute(sql, admin, c.id);
      assert.equal(initial.finance.depositExecutionAvailable, false);
      assert.equal(initial.finance.allocations.length, 0);
      const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
        file = { size: bytes.length, arrayBuffer: async () => bytes };
      const response = {
        id: c.id,
        version: 1,
        body: 'Private photo evidence from the property owner.',
        requestKey: randomUUID(),
      };
      await replyDispute(sql, owner, response, [file], store);
      assert.equal(
        (await replyDispute(sql, owner, response, [file], { configured: () => false })).replayed,
        true,
      );
      const read = await readDispute(sql, owner, c.id),
        attachment = read.messages.flatMap((m) => m.attachments)[0];
      assert.equal(
        (await disputeAttachment(sql, owner, c.id, attachment.id, store)).mimeType,
        'image/png',
      );
      await assert.rejects(disputeAttachment(sql, customer, c.id, attachment.id, store), {
        statusCode: 404,
      });
      await assert.rejects(disputeAttachment(sql, other, c.id, attachment.id, store), {
        statusCode: 404,
      });
      await assert.rejects(
        replyDispute(
          sql,
          owner,
          { ...response, version: 2, requestKey: randomUUID(), audience: 'everyone' },
          [],
          store,
        ),
        { statusCode: 403 },
      );
      await assert.rejects(
        replyDispute(sql, owner, { ...response, version: 2, requestKey: randomUUID() }, [file], {
          configured: () => false,
        }),
        { statusCode: 503 },
      );
      assert.equal((await readDispute(sql, owner, c.id)).version, 2);
      const assign = {
        id: c.id,
        version: 2,
        command: 'assign',
        body: 'Assign to an active finance operator for review.',
        assigneeId: f.limited,
        requestKey: randomUUID(),
      };
      await assert.rejects(manageDispute(sql, admin, assign), { code: 'INVALID_ASSIGNEE' });
      await assert.rejects(manageDispute(sql, owner, assign), { statusCode: 403 });
      await manageDispute(sql, admin, { ...assign, assigneeId: f.second });
      await sql`UPDATE admin_user SET is_active=false WHERE id=${f.second}`;
      await assert.rejects(
        replyDispute(sql, owner, { ...response, requestKey: randomUUID() }, [], store),
        { code: 'DISPUTE_CHANGED' },
      );
      await assert.rejects(
        replyDispute(
          sql,
          owner,
          { ...response, version: 3, requestKey: randomUUID() },
          [{ size: 5, arrayBuffer: async () => Buffer.from('hello') }],
          store,
        ),
        { code: 'INVALID_ATTACHMENT' },
      );
      await assert.rejects(
        manageDispute(sql, admin, {
          id: c.id,
          version: 3,
          command: 'request_response',
          party: 'customer',
          due: '2000-01-01T00:00:00Z',
          body: 'A deadline must be a future date.',
          requestKey: randomUUID(),
        }),
        { code: 'INVALID_DEADLINE' },
      );
      const otherCase = await createDispute(sql, owner, {
        ...input,
        requestKey: randomUUID(),
        subject: 'Separate incident and separate evidence',
      });
      await assert.rejects(disputeAttachment(sql, owner, otherCase.id, attachment.id, store), {
        statusCode: 404,
      });

      await manageDispute(sql, admin, {
        id: c.id,
        version: 3,
        command: 'request_response',
        party: 'customer',
        due: new Date(Date.now() + 86400000).toISOString(),
        body: 'Please provide your response and relevant evidence.',
        requestKey: randomUUID(),
      });
      assert.equal((await readDispute(sql, customer, c.id)).messages.length, 1);
      await replyDispute(
        sql,
        customer,
        {
          id: c.id,
          version: 4,
          body: 'Private customer response disputes the claimed damage.',
          requestKey: randomUUID(),
        },
        [],
        store,
      );
      const ownerRead = await readDispute(sql, owner, c.id);
      assert.equal(ownerRead.requestedParty, null);
      assert.ok(!ownerRead.messages.some((m) => m.body.startsWith('Private customer')));
      const decision = {
        id: c.id,
        version: 5,
        command: 'resolve',
        outcome: 'no_action',
        body: 'No deposit collection is evidenced. Close without financial action.',
        requestKey: randomUUID(),
      };
      await assert.rejects(manageDispute(sql, admin, decision), { code: 'PREVIEW_REQUIRED' });
      const preview = await manageDispute(sql, admin, { ...decision, preview: true });
      assert.equal((await readDispute(sql, admin, c.id)).state, 'open');
      await assert.rejects(
        manageDispute(sql, admin, {
          ...decision,
          body: 'Changed decision needs a fresh preview of the case.',
          previewToken: preview.preview.previewToken,
        }),
        { code: 'PREVIEW_REQUIRED' },
      );
      const results = await Promise.allSettled([
        manageDispute(sql, admin, { ...decision, previewToken: preview.preview.previewToken }),
        manageDispute(sql, admin, {
          ...decision,
          requestKey: randomUUID(),
          previewToken: preview.preview.previewToken,
        }),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal((await readDispute(sql, customer, c.id)).resolution, decision.body);
      assert.equal((await sql`SELECT count(*)::int n FROM refund`)[0].n, 0);
      assert.equal((await sql`SELECT count(*)::int n FROM payout`)[0].n, 0);
      await assert.rejects(
        sql`UPDATE dispute_message SET body='Rewritten prior evidence' WHERE case_id=${c.id}`,
      );
      await assert.rejects(sql`UPDATE dispute_case SET version=version+1 WHERE id=${c.id}`);
      const provider = await createDispute(sql, customer, {
        ...input,
        kind: 'provider',
        requestKey: randomUUID(),
      });
      assert.equal(
        (await readDispute(sql, customer, provider.id)).finance.providerSubmissionAvailable,
        false,
      );
      await sql`UPDATE rentable SET client_id=${f.other} WHERE id=${f.listing}`;
      assert.equal((await readDispute(sql, owner, c.id)).bookingLinkAvailable, false);
      await assert.rejects(readDispute(sql, other, c.id), { statusCode: 404 });
      await sql`UPDATE auth_session SET revoked_at=now() WHERE id=${session.id}`;
      await assert.rejects(readDispute(sql, customer, c.id));
    } finally {
      await db.drop();
    }
  },
);

test(
  'CP23 financial context separates live and Test captures and resolution never executes money',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = db.sql;
    try {
      const f = await seedReviewFixture(sql),
        finance = await seedFinanceFixture(sql, f),
        admin = { kind: 'admin', id: f.admin };
      await sql`UPDATE admin_user SET permissions='["admin.payments.read"]'::jsonb WHERE id=${f.limited}`;
      const before =
        await sql`SELECT (SELECT count(*) FROM refund)::int refunds,(SELECT count(*) FROM payout)::int payouts`;
      for (const [environment, source] of [
        ['live', finance.live],
        ['test', finance.test],
      ]) {
        const c = await createDispute(sql, admin, {
          orderId: source.orderId,
          visitId: source.bookingId,
          kind: 'service',
          subject: 'Service dispute with financial evidence',
          body: 'Review recorded evidence and route any refund separately.',
          claimedMinor: 0,
          requestKey: randomUUID(),
        });
        const read = await readDispute(sql, admin, c.id);
        assert.equal(read.finance.allocations.length, 2);
        assert.ok(read.finance.allocations.every((a) => a.environment === environment));
        assert.equal(
          read.finance.allocations.find((a) => a.component === 'rent').captured_minor,
          '100000',
        );
        assert.equal(
          read.finance.allocations.find((a) => a.component === 'rent').refunded_minor,
          environment === 'live' ? '20000' : '0',
        );
        assert.equal(read.finance.depositExecutionAvailable, false);
        const readonly = { kind: 'admin', id: f.limited };
        assert.equal((await readDispute(sql, readonly, c.id)).canWrite, false);
        const command = {
          id: c.id,
          version: 1,
          command: 'resolve',
          outcome: 'refund_review',
          body: 'Refer this case to separate verified-capture refund review.',
          requestKey: randomUUID(),
        };
        await assert.rejects(manageDispute(sql, readonly, command), { statusCode: 403 });
        const preview = await manageDispute(sql, admin, { ...command, preview: true });
        await manageDispute(sql, admin, { ...command, previewToken: preview.preview.previewToken });
        assert.equal((await readDispute(sql, admin, c.id)).outcome, 'refund_review');
      }
      assert.deepEqual(
        await sql`SELECT (SELECT count(*) FROM refund)::int refunds,(SELECT count(*) FROM payout)::int payouts`,
        before,
      );
    } finally {
      await db.drop();
    }
  },
);
