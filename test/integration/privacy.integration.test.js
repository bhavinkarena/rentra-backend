import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import { seedFinanceFixture } from '../helpers/finance-fixture.js';
import { issuePortalSession } from '../../src/services/auth/portal-sessions.js';
import {
  listPrivacyRequests,
  readPrivacyRequest,
  privacyCommand,
  processPrivacyJob,
  privacyDownload,
  runPrivacyJobs,
} from '../../src/services/customer/privacy-fulfillment.js';
import {
  requestCustomerPrivacy,
  readCustomerAccount,
} from '../../src/services/customer/account.js';
import { correctCustomerProfile } from '../../src/services/admin/customers.js';
const env = { NODE_ENV: 'test', SESSION_SECRET: 'cp27-disposable-encryption-secret' };
test(
  'CP27 scoped export, live permission checks, retention, checkpoints and receipts',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      db = fixture.sql;
    try {
      const f = await seedReviewFixture(db),
        booking = await seedConfirmedBooking(db, f.listing);
      const actor = {
        kind: 'admin',
        id: f.admin,
        sessionId: await issuePortalSession(db, 'admin', f.admin, 3600),
      };
      const [readonly] =
        await db`INSERT INTO admin_user(email,name,password_hash,permissions) VALUES ('privacy-read@fixture.invalid','Read','fixture','["admin.privacy.read"]') RETURNING id`;
      const [session] =
        await db`INSERT INTO auth_session(user_id,expires_at) VALUES (${booking.customer},now()+interval '1 day') RETURNING id`;
      const customer = {
        kind: 'customer',
        session: { role: 'customer', userId: booking.customer, sessionId: session.id },
      };
      const [foreign] =
        await db`INSERT INTO "user"(role,account_status,name,email) VALUES ('customer','active','Foreign PRIVATE','foreign@fixture.invalid') RETURNING id`;
      const [otherSession] =
        await db`INSERT INTO auth_session(user_id,expires_at) VALUES (${foreign.id},now()+interval '1 day') RETURNING id`;
      const other = {
        kind: 'customer',
        session: { role: 'customer', userId: foreign.id, sessionId: otherSession.id },
      };
      const access = await requestCustomerPrivacy(db, customer.session, 'access', env);
      assert.equal(
        (await requestCustomerPrivacy(db, customer.session, 'access', env)).id,
        access.id,
      );
      const detail = () => readPrivacyRequest(db, actor, access.id);
      const cmd = async (id, command, extra = {}, who = actor) => {
        const [r] = await db`SELECT version FROM customer_privacy_request WHERE id=${id}`;
        return privacyCommand(
          db,
          who,
          id,
          {
            command,
            version: r.version,
            reason: 'Verified the requested privacy scope',
            confirmed: true,
            ...extra,
          },
          env,
        );
      };
      const review = (id) =>
        cmd(id, 'review', {
          authority: 'self',
          identityReference: 'verified-case-identity',
          deliveryReference: 'verified-case-handoff',
          retentionAccepted: true,
        });
      assert.equal((await listPrivacyRequests(db, actor)).total, 1);
      await assert.rejects(readPrivacyRequest(db, { kind: 'admin', id: f.limited }, access.id), {
        statusCode: 403,
      });
      await assert.rejects(cmd(access.id, 'review', {}, { kind: 'admin', id: readonly.id }), {
        statusCode: 403,
      });
      await assert.rejects(cmd(access.id, 'preview'), { code: 'REVIEW_REQUIRED' });
      await assert.rejects(
        cmd(access.id, 'review', { authority: 'self', identityReference: 'verified-identity' }),
        { statusCode: 422 },
      );
      await db`UPDATE auth_session SET created_at=now()-interval '16 minutes' WHERE id=${actor.sessionId}`;
      await assert.rejects(review(access.id), { code: 'RECENT_AUTH_REQUIRED' });
      await db`UPDATE auth_session SET created_at=now() WHERE id=${actor.sessionId}`;
      await review(access.id);
      const version = (await detail()).request.version;
      await assert.rejects(
        privacyCommand(
          db,
          actor,
          access.id,
          {
            command: 'review',
            version: version - 1,
            reason: 'Verified the requested privacy scope',
            confirmed: true,
          },
          env,
        ),
        { code: 'PRIVACY_CHANGED' },
      );
      let p = await cmd(access.id, 'preview');
      await db`UPDATE "user" SET profile_version=profile_version+1 WHERE id=${booking.customer}`;
      await assert.rejects(cmd(access.id, 'queue', { previewToken: p.previewToken }), {
        code: 'PRIVACY_PREVIEW_CHANGED',
      });
      p = await cmd(access.id, 'preview');
      const races = await Promise.allSettled([
        cmd(access.id, 'queue', { previewToken: p.previewToken }),
        cmd(access.id, 'queue', { previewToken: p.previewToken }),
      ]);
      assert.equal(races.filter((x) => x.status === 'fulfilled').length, 1);
      await assert.rejects(privacyDownload(db, actor, access.id, false, env), {
        code: 'ARTIFACT_NOT_READY',
      });
      await db`INSERT INTO customer_payment_method(customer_id,provider,environment,provider_customer_id,token_ciphertext,token_hash,method_family,display_label,last4,consented_at)
      VALUES (${booking.customer},'fixture','test','PROVIDER_PRIVATE','CIPHERTEXT_PRIVATE',${'c'.repeat(64)},'card','Card','1234',now())`;
      // Both customer-visible and internal support statements exist, plus a foreign thread.
      for (const [id, body] of [
        [booking.customer, 'Own visible support statement'],
        [foreign.id, 'Foreign PRIVATE support statement'],
      ]) {
        const [r] =
          await db`INSERT INTO support_request(reference,customer_id,category,subject,context,policy_version,request_key,request_hash) VALUES (${randomUUID()},${id},'other','Fixture support subject','{}','v1',${randomUUID()},${'a'.repeat(64)}) RETURNING id`;
        await db`INSERT INTO support_message(request_id,actor_kind,actor_id,body,state_after,request_key,request_hash) VALUES (${r.id},'customer',${id},${body},'open',${randomUUID()},${'a'.repeat(64)})`;
        await db`INSERT INTO support_message(request_id,actor_kind,actor_id,body,state_after,internal,request_key,request_hash) VALUES (${r.id},'admin',${f.admin},'INTERNAL_PRIVATE statement','open',true,${randomUUID()},${'a'.repeat(64)})`;
      }
      assert.equal(await processPrivacyJob(db, access.id, { env }), true);
      assert.equal((await detail()).job.state, 'completed');
      const raw = (await privacyDownload(db, customer, access.id, false, env)).toString(),
        exported = JSON.parse(raw);
      assert.equal(exported.account.id, booking.customer);
      assert.equal(exported.bookings.length, 1);
      assert.equal(exported.messages.length, 1);
      assert(
        !/Foreign PRIVATE|foreign@|INTERNAL_PRIVATE|CIPHERTEXT_PRIVATE|PROVIDER_PRIVATE|code_hash|storage_key|sessionId/.test(
          raw,
        ),
      );
      const [artifact] =
        await db`SELECT artifact_ciphertext FROM privacy_job WHERE request_id=${access.id}`;
      assert(!artifact.artifact_ciphertext.includes('Booked Guest'));
      assert.equal(
        (await readCustomerAccount(db, customer.session, env)).requests[0].exportAvailable,
        true,
      );
      await assert.rejects(privacyDownload(db, other, access.id, false, env), { statusCode: 404 });
      await assert.rejects(
        privacyDownload(db, { kind: 'owner', id: f.owner }, access.id, false, env),
        { statusCode: 403 },
      );
      await db`UPDATE admin_user SET permissions='["admin.records.read"]' WHERE id=${readonly.id}`;
      await assert.rejects(
        privacyDownload(db, { kind: 'admin', id: readonly.id }, access.id, false, env),
        { statusCode: 403 },
      );
      await db`UPDATE privacy_job SET expires_at=now()-interval '1 second' WHERE request_id=${access.id}`;
      await assert.rejects(privacyDownload(db, customer, access.id, false, env), {
        code: 'EXPORT_EXPIRED',
      });
      await runPrivacyJobs(db, { env });
      assert.equal(
        (await db`SELECT artifact_ciphertext FROM privacy_job WHERE request_id=${access.id}`)[0]
          .artifact_ciphertext,
        null,
      );
      assert.equal(
        JSON.parse((await privacyDownload(db, actor, access.id, true, env)).toString()).outcome,
        'scoped_export_ready',
      );
      const deletion = await requestCustomerPrivacy(db, customer.session, 'deletion', env);
      await cmd(deletion.id, 'review', {
        authority: 'representative',
        identityReference: 'reviewed-authority-reference',
        deliveryReference: 'verified-handoff-reference',
        retentionAccepted: false,
      });
      await assert.rejects(cmd(deletion.id, 'preview'), { code: 'RETENTION_REVIEW_REQUIRED' });
      await review(deletion.id);
      await assert.rejects(cmd(deletion.id, 'preview'), { code: 'ACTIVE_OBLIGATIONS' });
      await db`UPDATE booking SET state='cancelled' WHERE order_id=${booking.order}`;
      await db`INSERT INTO customer_favourite(customer_id,rentable_id) VALUES (${booking.customer},${f.listing})`;
      await db`UPDATE "user" SET photo_public_id='profile-photos/fixture',marketing_consent=true,profile_version=profile_version+1 WHERE id=${booking.customer}`;
      const history = JSON.stringify(
        await db`SELECT * FROM booking WHERE order_id=${booking.order}`,
      );
      const financial = JSON.stringify(
        await db`SELECT * FROM booking_order WHERE id=${booking.order}`,
      );
      const freshAccess = await requestCustomerPrivacy(db, customer.session, 'access', env);
      await review(freshAccess.id);
      const freshPreview = await cmd(freshAccess.id, 'preview');
      await cmd(freshAccess.id, 'queue', { previewToken: freshPreview.previewToken });
      await assert.rejects(cmd(deletion.id, 'preview'), { code: 'OTHER_JOB_ACTIVE' });
      await processPrivacyJob(db, freshAccess.id, { env });
      assert.equal((await privacyDownload(db, actor, freshAccess.id, false, env)).length > 0, true);
      p = await cmd(deletion.id, 'preview');
      await cmd(deletion.id, 'queue', { previewToken: p.previewToken });
      await assert.rejects(privacyDownload(db, actor, freshAccess.id, false, env), {
        code: 'EXPORT_EXPIRED',
      });
      await assert.rejects(privacyDownload(db, customer, access.id, true, env));
      assert.equal(
        (
          await db`SELECT revoked_at IS NOT NULL revoked FROM auth_session WHERE id=${session.id}`
        )[0].revoked,
        true,
      );
      assert.equal(
        (await db`SELECT marketing_consent FROM "user" WHERE id=${booking.customer}`)[0]
          .marketing_consent,
        false,
      );
      await assert.rejects(
        correctCustomerProfile(db, {
          adminId: f.admin,
          customerId: booking.customer,
          input: {
            expectedVersion: 2,
            expectedProfileVersion: 1,
            name: 'New Name',
            email: 'new@fixture.invalid',
            preferredLocale: 'en',
            reason: 'A reviewed account correction',
          },
        }),
        { code: 'PRIVACY_ACCOUNT_LOCKED' },
      );
      assert.equal(
        await processPrivacyJob(db, deletion.id, { env, destroyPhoto: async () => false }),
        false,
      );
      let d = await readPrivacyRequest(db, actor, deletion.id);
      assert.equal(d.job.state, 'failed');
      assert.equal(d.job.stage, 1);
      assert.equal(d.job.errorCode, 'PHOTO_REMOVAL_FAILED');
      assert.equal(d.request.receipt, null);
      await cmd(deletion.id, 'retry');
      let destroyed = 0;
      assert.equal(
        await processPrivacyJob(db, deletion.id, {
          env,
          destroyPhoto: async () => {
            destroyed++;
            return true;
          },
          beforeStage: (stage) => {
            if (stage === 4) throw Error('Fixture receipt failure');
          },
        }),
        false,
      );
      d = await readPrivacyRequest(db, actor, deletion.id);
      assert.equal(d.job.stage, 4);
      assert.equal(d.job.results.length, 4);
      assert.equal(d.request.receipt, null);
      assert.equal(d.customer.name, null);
      await cmd(deletion.id, 'retry');
      await Promise.all([
        processPrivacyJob(db, deletion.id, {
          env,
          destroyPhoto: async () => {
            destroyed++;
            return true;
          },
        }),
        processPrivacyJob(db, deletion.id, { env }),
      ]);
      d = await readPrivacyRequest(db, actor, deletion.id);
      assert.equal(d.job.state, 'completed');
      assert.equal(destroyed, 1);
      assert.equal(d.request.receipt.fullDeletion, false);
      assert.equal(d.request.receipt.stages.length, 4);
      assert(d.request.receipt.outstanding.length);
      assert(d.request.receipt.retentionReviewDueAt);
      assert.equal(
        (
          await db`SELECT count(*)::int n FROM customer_favourite WHERE customer_id=${booking.customer}`
        )[0].n,
        0,
      );
      assert.equal(
        (
          await db`SELECT is_active FROM customer_payment_method WHERE customer_id=${booking.customer}`
        )[0].is_active,
        false,
      );
      assert.equal(
        JSON.stringify(await db`SELECT * FROM booking WHERE order_id=${booking.order}`),
        history,
      );
      assert.equal(
        JSON.stringify(await db`SELECT * FROM booking_order WHERE id=${booking.order}`),
        financial,
      );
      const [user] =
        await db`SELECT name,email,phone,account_status,privacy_erasure_pending,privacy_erased_at FROM "user" WHERE id=${booking.customer}`;
      assert.equal(user.name, null);
      assert.equal(user.email, null);
      assert.equal(user.phone, null);
      assert.equal(user.account_status, 'blocked');
      assert.equal(user.privacy_erasure_pending, false);
      assert(user.privacy_erased_at);
      // Reuse the ledger fixture: real Test/live captures, allocations, refunds and payouts.
      const finance = await seedFinanceFixture(db, f);
      const [scope] =
        await db`SELECT customer_id FROM booking_order WHERE id=${finance.live.orderId}`;
      const [financialRequest] =
        await db`INSERT INTO customer_privacy_request(customer_id,kind) VALUES (${scope.customer_id},'deletion') RETURNING id`;
      await review(financialRequest.id);
      await assert.rejects(cmd(financialRequest.id, 'preview'), { code: 'ACTIVE_OBLIGATIONS' });
      await db`UPDATE refund SET state='failed' WHERE state='requested'`;
      await db`UPDATE payment_order SET state='processing' WHERE id=${finance.test.paymentId}`;
      await assert.rejects(cmd(financialRequest.id, 'preview'), { code: 'ACTIVE_OBLIGATIONS' });
      await db`UPDATE payment_order SET state='succeeded' WHERE id=${finance.test.paymentId}`;
      const tables = [
        'booking_order',
        'booking',
        'payment_order',
        'payment_attempt',
        'payment_transaction',
        'payment_allocation',
        'refund',
        'refund_allocation',
        'payout',
      ];
      const ledger = async () =>
        JSON.stringify(
          await Promise.all(tables.map((table) => db`SELECT * FROM ${db(table)} ORDER BY id`)),
        );
      const beforeLedger = await ledger();
      const financialPreview = await cmd(financialRequest.id, 'preview');
      await cmd(financialRequest.id, 'queue', { previewToken: financialPreview.previewToken });
      assert.equal(await processPrivacyJob(db, financialRequest.id, { env }), true);
      assert.equal(
        (await readPrivacyRequest(db, actor, financialRequest.id)).job.state,
        'completed',
      );
      assert.equal(await ledger(), beforeLedger);
      // An oversized automatic scope fails visibly; retry never silently truncates it.
      await db`INSERT INTO customer_favourite(customer_id,rentable_id) SELECT ${foreign.id},gen_random_uuid() FROM generate_series(1,5001)`;
      const bounded = await requestCustomerPrivacy(db, other.session, 'access', env);
      await review(bounded.id);
      const boundedPreview = await cmd(bounded.id, 'preview');
      await cmd(bounded.id, 'queue', { previewToken: boundedPreview.previewToken });
      assert.equal(await processPrivacyJob(db, bounded.id, { env }), false);
      const failedBound = await readPrivacyRequest(db, actor, bounded.id);
      assert.equal(failedBound.job.errorCode, 'EXPORT_REVIEW_REQUIRED');
      assert.equal(failedBound.request.receipt, null);
      const auditRows =
        await db`SELECT action,after FROM audit_log WHERE entity='customer_privacy_request' AND entity_id IN (${access.id},${deletion.id})`;
      assert(auditRows.some((r) => r.action === 'privacy_export_downloaded'));
      assert(auditRows.some((r) => r.action === 'privacy_receipt_downloaded'));
      assert(!JSON.stringify(auditRows).includes('verified-case-identity'));
    } finally {
      await fixture.drop();
    }
  },
);
