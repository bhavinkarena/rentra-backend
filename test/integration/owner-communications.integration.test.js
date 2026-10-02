import { test } from 'node:test';
import { saveOwnerAccount } from '../../src/services/auth/owner-account.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import { seedReviewModeration } from '../helpers/review-moderation-fixture.js';
import {
  processOwnerNotification,
  scheduleOwnerNotifications,
} from '../../src/services/notifications/owner-jobs.js';
import {
  quietUntil,
  ownerPreferences,
  ownerUpdateHref,
  ownerNotificationMessage,
  ownerEventTitles,
} from '../../src/services/notifications/owner-domain.js';
import { ownerChannelAdapter } from '../../src/services/notifications/owner-delivery.js';
import { NotificationError, bodyHash } from '../../src/services/notifications/delivery.js';
import {
  readOwnerNotificationPreferences,
  saveOwnerNotificationPreferences,
} from '../../src/services/notifications/owner-preferences.js';
import { markClientUpdatesRead, listClientUpdates } from '../../src/services/auth/client-inbox.js';
import {
  createSupportRequest,
  replySupportRequest,
  listSupportRequests,
  readSupportRequest,
  supportAttachment,
} from '../../src/services/support/service.js';
import { memoryEvidenceStore } from '../../src/services/uploads/evidence-store.js';
import {
  createDispute,
  manageDispute,
  readDispute,
  disputeAttachment,
} from '../../src/services/disputes/service.js';
import {
  moderateReview,
  replyToReview,
  reviewQueue,
  reportReview,
  closeReviewReport,
} from '../../src/services/reviews/service.js';
import { issuePortalSession, validPortalSession } from '../../src/services/auth/portal-sessions.js';
import {
  requestOwnerContactChange,
  confirmOwnerContactChange,
  signOutOtherOwnerSessions,
  ownerSecurityPage,
} from '../../src/services/auth/owner-security.js';
import {
  readOwnerPrivacy,
  requestOwnerPrivacy,
} from '../../src/services/customer/owner-privacy.js';
import {
  privacyCommand,
  processPrivacyJob,
  privacyDownload,
} from '../../src/services/customer/privacy-fulfillment.js';
import { inviteStaff } from '../../src/services/auth/staff-team.js';
import { deliverCaretakerInvite } from '../../src/services/notifications/caretaker-invite.js';
import { publicContent, validateContent } from '../../src/services/content/service.js';
const enabled = {
  NODE_ENV: 'production',
  SESSION_SECRET: 'phase9-test-only-session-signing-secret',
  OWNER_NOTIFICATION_DELIVERY: 'enabled',
  OWNER_NOTIFICATION_ALLOW_TEST: 'true',
  NEXT_PUBLIC_SITE_URL: 'https://fixture.invalid',
  TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32),
  TWILIO_AUTH_TOKEN: 'fixture',
  TWILIO_FROM_NUMBER: '+15005550006',
  TWILIO_WHATSAPP_FROM: 'whatsapp:+15005550006',
  OWNER_WHATSAPP_TEMPLATES_JSON: JSON.stringify({ booking_confirmed: 'HX' + 'b'.repeat(32) }),
  RESEND_API_KEY: 'fixture',
  OTP_EMAIL_FROM: 'Rentra <owner@fixture.invalid>',
};
const options = { skip: !process.env.PORTAL_TEST_DATABASE_URL };
const photo = {
  size: 12,
  arrayBuffer: async () =>
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
};
async function fixture(run) {
  const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
  try {
    const f = await seedReviewFixture(db.sql);
    await run(db.sql, f);
  } finally {
    await db.drop();
  }
}
const daytime = () => new Date('2026-10-02T06:00:00Z');
test(
  'owner event outbox dedupes, pins tasks, honors preferences/quiet hours and handles fallback/retry/unknown',
  options,
  () =>
    fixture(async (sql, f) => {
      await sql`UPDATE "user" SET phone='9876543210',email_verified_at=now(),phone_verified_at=now() WHERE id=${f.owner}`;
      const booking = await seedConfirmedBooking(sql, f.listing);
      await sql`INSERT INTO booking_lifecycle_event(order_id,kind,payload) VALUES(${booking.order},'confirmed','{}'::jsonb)`;
      const [notice] =
        await sql`SELECT * FROM client_update WHERE client_id=${f.owner} AND action='booking_confirmed'`;
      assert.ok(notice);
      const rows = await sql`SELECT * FROM owner_notification WHERE update_id=${notice.id}`;
      assert.equal(rows.length, 2);
      await sql`SELECT client_update_insert(${f.owner},${notice.event_key},'booking','info','booking_confirmed',${f.listing},${booking.order},'{}'::jsonb,now())`;
      assert.equal(
        (await sql`SELECT count(*)::int n FROM owner_notification WHERE update_id=${notice.id}`)[0]
          .n,
        2,
      );
      const mobile = rows.find((r) => r.channel === 'mobile'),
        email = rows.find((r) => r.channel === 'email');
      let sends = 0,
        polls = 0;
      const adapter = (config) => ({
        send: async (row, text) => {
          sends++;
          assert.ok(text.includes('/partner/bookings/' + booking.order));
          return {
            id: 'SM' + 'c'.repeat(32),
            state: config.channel === 'whatsapp' ? 'undelivered' : 'accepted',
          };
        },
        fetch: async () => {
          polls++;
          return { id: 'SM' + 'c'.repeat(32), state: 'delivered' };
        },
      });
      await processOwnerNotification(sql, mobile.id, {
        env: enabled,
        now: () => new Date('2026-10-02T18:00:00Z'),
        adapter,
      });
      assert.equal(sends, 0);
      assert.equal(
        (
          await sql`SELECT next_attempt_at FROM owner_notification WHERE id=${mobile.id}`
        )[0].next_attempt_at.toISOString(),
        '2026-10-03T01:30:00.000Z',
      );
      await sql`UPDATE owner_notification SET next_attempt_at=now()-interval '1 second' WHERE id=${mobile.id}`;
      await Promise.all([
        processOwnerNotification(sql, mobile.id, { env: enabled, now: daytime, adapter }),
        processOwnerNotification(sql, mobile.id, { env: enabled, now: daytime, adapter }),
      ]);
      assert.equal(sends, 1);
      const [n] = await sql`SELECT * FROM owner_notification WHERE id=${mobile.id}`;
      assert.equal(n.channel, 'sms');
      assert.equal(n.state, 'pending');
      await sql`UPDATE owner_notification SET next_attempt_at=now()-interval '1 second' WHERE id=${mobile.id}`;
      await processOwnerNotification(sql, mobile.id, { env: enabled, now: daytime, adapter });
      assert.equal(sends, 2);
      const [pinned] = await sql`SELECT body_hash FROM owner_notification WHERE id=${mobile.id}`;
      await sql`UPDATE rentable SET title='Changed title after send' WHERE id=${f.listing}`;
      await sql`UPDATE owner_notification SET next_attempt_at=now()-interval '1 second' WHERE id=${mobile.id}`;
      await processOwnerNotification(sql, mobile.id, {
        env: enabled,
        now: daytime,
        adapter: () => ({
          fetch: async (row) => {
            assert.equal(row.body_hash, pinned.body_hash);
            polls++;
            return { id: row.provider_id, state: 'delivered' };
          },
        }),
      });
      assert.equal(polls, 1);
      assert.equal(
        (await sql`SELECT state FROM owner_notification WHERE id=${mobile.id}`)[0].state,
        'delivered',
      );
      await processOwnerNotification(sql, email.id, {
        env: enabled,
        now: daytime,
        adapter: () => ({
          send: async () => {
            throw new NotificationError('PROVIDER_RATE_LIMIT', true);
          },
        }),
      });
      assert.equal(
        (await sql`SELECT state FROM owner_notification WHERE id=${email.id}`)[0].state,
        'retry',
      );
      await sql`UPDATE owner_notification SET next_attempt_at=now()-interval '1 second' WHERE id=${email.id}`;
      await processOwnerNotification(sql, email.id, {
        env: enabled,
        now: daytime,
        adapter: () => ({
          send: async () => {
            throw new NotificationError('DELIVERY_OUTCOME_UNKNOWN');
          },
        }),
      });
      assert.equal(
        (await sql`SELECT state FROM owner_notification WHERE id=${email.id}`)[0].state,
        'unknown',
      );
      assert.equal(await processOwnerNotification(sql, email.id, { env: enabled, adapter }), false);
      const preferences = await readOwnerNotificationPreferences(sql, f.owner);
      const muted = ownerPreferences();
      muted.booking = { email: false, mobile: false };
      await assert.rejects(
        saveOwnerNotificationPreferences(sql, f.owner, {
          expectedVersion: preferences.version,
          preferences: muted,
        }),
        { statusCode: 422 },
      );
      muted.booking.mobile = true;
      muted.team = { mobile: false, email: false };
      await saveOwnerNotificationPreferences(sql, f.owner, {
        expectedVersion: preferences.version,
        preferences: muted,
      });
      await sql`SELECT client_update_insert(${f.owner},'team:optional','team','info','caretaker_evidence',${f.listing},NULL,'{}'::jsonb,now())`;
      const team = await sql`SELECT id FROM owner_notification WHERE event_key='team:optional'`;
      for (const t of team)
        await processOwnerNotification(sql, t.id, { env: enabled, now: daytime, adapter });
      assert.equal(
        (
          await sql`SELECT count(*)::int n FROM owner_notification WHERE event_key='team:optional' AND state='suppressed'`
        )[0].n,
        2,
      );
      assert.equal(quietUntil(new Date('2026-10-02T18:00:00Z'), true), null);
      for (const event of Object.keys(ownerEventTitles)) {
        const text = ownerNotificationMessage(
          { event, detail: { disputeId: randomUUID() }, property_title: 'Property' },
          enabled.NEXT_PUBLIC_SITE_URL,
        );
        assert.match(text, /https:\/\/fixture.invalid\/partner/);
      }
      assert.ok(ownerUpdateHref({ event: 'application_approved' }).startsWith('/partner'));
      await scheduleOwnerNotifications(sql);
      await scheduleOwnerNotifications(sql);
    }),
);
test(
  'support create photos, owner topics, unread replies, pending restrictions and dispute private evidence/summary',
  options,
  () =>
    fixture(async (sql, f) => {
      const owner = { kind: 'owner', id: f.owner },
        other = { kind: 'owner', id: f.other },
        store = memoryEvidenceStore();
      const input = {
        category: 'calendar',
        subject: 'Help opening my dates',
        body: 'Please explain how to open dates for next week.',
        orderId: null,
        privacyRequestId: null,
        propertyId: f.listing,
        requestKey: randomUUID(),
      };
      const created = await createSupportRequest(sql, owner, input, enabled, [photo], store);
      assert.equal(
        (await createSupportRequest(sql, owner, input, enabled, [photo], store)).id,
        created.id,
      );
      assert.equal(store.files.size, 1);
      await assert.rejects(
        createSupportRequest(
          sql,
          other,
          { ...input, requestKey: randomUUID() },
          enabled,
          [photo],
          store,
        ),
        { statusCode: 404 },
      );
      await replySupportRequest(
        sql,
        { kind: 'admin', id: f.admin },
        {
          id: created.id,
          body: 'Please add the dates shown in the calendar.',
          state: 'waiting_customer',
          version: 0,
          requestKey: randomUUID(),
        },
        enabled,
        [],
        store,
      );
      assert.equal((await listSupportRequests(sql, owner, {}, enabled)).items[0].unread, true);
      const [notice] =
        await sql`SELECT id FROM client_update WHERE detail->>'supportId'=${created.id}`;
      await assert.rejects(markClientUpdatesRead(sql, f.owner, { all: true }), {
        code: 'READ_CONFIRM_REQUIRED',
      });
      await markClientUpdatesRead(sql, f.owner, { id: notice.id });
      assert.ok(
        (await listClientUpdates(sql, f.owner, { filter: 'action' })).items.some(
          (r) => r.id === notice.id && r.read,
        ),
      );
      const detail = await readSupportRequest(sql, owner, created.id, enabled);
      const file = detail.messages[0].attachments[0];
      assert.ok(await supportAttachment(sql, owner, created.id, file.id, enabled, store));
      await assert.rejects(supportAttachment(sql, other, created.id, file.id, enabled, store), {
        statusCode: 404,
      });
      await replySupportRequest(
        sql,
        owner,
        {
          id: created.id,
          body: 'Thanks, I opened the dates.',
          state: 'resolved',
          version: 1,
          requestKey: randomUUID(),
        },
        enabled,
        [],
        store,
      );
      assert.ok(
        !(await listClientUpdates(sql, f.owner, { filter: 'action' })).items.some(
          (r) => r.id === notice.id,
        ),
      );
      await sql`UPDATE "user" SET account_status='pending_application' WHERE id=${f.other}`;
      await assert.rejects(
        createSupportRequest(
          sql,
          other,
          { ...input, propertyId: null, requestKey: randomUUID() },
          enabled,
        ),
        { code: 'INVALID_TOPIC' },
      );
      const booking = await seedConfirmedBooking(sql, f.listing);
      const [visit] = await sql`SELECT id FROM booking WHERE order_id=${booking.order}`;
      const withVisit = await createSupportRequest(
        sql,
        owner,
        { ...input, orderId: booking.order, visitId: visit.id, requestKey: randomUUID() },
        enabled,
      );
      const scopedContext = await readSupportRequest(sql, owner, withVisit.id, enabled);
      assert.equal(
        scopedContext.context.visitReference,
        (await sql`SELECT reference FROM booking WHERE id=${visit.id}`)[0].reference,
      );
      await assert.rejects(
        createSupportRequest(
          sql,
          owner,
          { ...input, orderId: booking.order, visitId: randomUUID(), requestKey: randomUUID() },
          enabled,
        ),
        { statusCode: 404 },
      );
      const customer = {
        kind: 'customer',
        session: {
          role: 'customer',
          userId: booking.customer,
          sessionId: (
            await sql`INSERT INTO auth_session(user_id,expires_at) VALUES(${booking.customer},now()+interval '1 day') RETURNING id`
          )[0].id,
        },
      };
      const caseInput = {
        orderId: booking.order,
        visitId: visit.id,
        kind: 'service',
        subject: 'Guest private claim',
        body: 'PRIVATE GUEST CLAIM — never expose the original.',
        claimedMinor: 1000,
        requestKey: randomUUID(),
      };
      const dispute = await createDispute(sql, customer, caseInput, [photo], store);
      assert.equal((await createDispute(sql, customer, caseInput, [photo], store)).id, dispute.id);
      let d = await readDispute(sql, owner, dispute.id);
      assert.ok(!JSON.stringify(d).includes('PRIVATE GUEST CLAIM'));
      assert.equal(d.messages.length, 0);
      await manageDispute(
        sql,
        { kind: 'admin', id: f.admin },
        {
          id: dispute.id,
          version: 1,
          command: 'request_response',
          party: 'owner',
          due: new Date(Date.now() + 86400000).toISOString(),
          body: 'Please tell us what happened on this visit.',
          claimSummary: 'The guest says the advertised garden was unavailable.',
          requestKey: randomUUID(),
        },
      );
      d = await readDispute(sql, owner, dispute.id);
      assert.equal(d.claimSummary, 'The guest says the advertised garden was unavailable.');
      assert.ok(!JSON.stringify(d).includes('PRIVATE GUEST CLAIM'));
      const customerDetail = await readDispute(sql, customer, dispute.id),
        attachment = customerDetail.messages[0].attachments[0];
      await assert.rejects(disputeAttachment(sql, owner, dispute.id, attachment.id, store), {
        statusCode: 404,
      });
      assert.ok(await disputeAttachment(sql, customer, dispute.id, attachment.id, store));
    }),
);
test(
  'reviews direct replies/edit/delete, stats, duplicate reports and report outcome notices',
  options,
  () =>
    fixture(async (sql, f) => {
      const booking = await seedConfirmedBooking(sql, f.listing),
        r = await seedReviewModeration(sql, f, booking);
      let [row] = await sql`SELECT version FROM review WHERE id=${r.reviewId}`;
      const mod = {
        id: r.reviewId,
        version: row.version,
        state: 'published',
        reason: 'Meets policy despite a low score.',
        category: 'meets_policy',
        preview: true,
      };
      const preview = await moderateReview(sql, f.admin, mod);
      await moderateReview(sql, f.admin, {
        ...mod,
        preview: false,
        previewToken: preview.preview.token,
      });
      const owner = { kind: 'owner', id: f.owner };
      const queue = await reviewQueue(sql, owner, 1, null, 'needs_reply');
      assert.equal(queue.rows.length, 1);
      assert.equal(queue.stats.count, 1);
      assert.equal(Number(queue.stats.average), 1);
      assert.ok(queue.rows[0].guest_first_name);
      [row] = await sql`SELECT version FROM review WHERE id=${r.reviewId}`;
      await replyToReview(sql, f.owner, {
        id: r.reviewId,
        version: row.version,
        body: 'Thank you. We have repaired the garden.',
      });
      assert.equal((await reviewQueue(sql, owner, 1, null, 'needs_reply')).rows.length, 0);
      await assert.rejects(
        replyToReview(sql, f.owner, {
          id: r.reviewId,
          version: row.version,
          body: 'A stale reply should never overwrite it.',
        }),
        { code: 'CHANGED' },
      );
      [row] = await sql`SELECT version FROM review WHERE id=${r.reviewId}`;
      await replyToReview(sql, f.owner, { id: r.reviewId, version: row.version, body: null });
      assert.equal((await reviewQueue(sql, owner, 1, null, 'needs_reply')).rows.length, 1);
      const report = await reportReview(sql, owner, {
        id: r.reviewId,
        reason: 'Please review the personal information in this post.',
      });
      const duplicate = await reportReview(sql, owner, {
        id: r.reviewId,
        reason: 'A duplicate report for the same review.',
      });
      assert.equal(duplicate.id, report.id);
      assert.equal(duplicate.alreadyReported, true);
      assert.ok(duplicate.reportedAt);
      await closeReviewReport(sql, f.admin, {
        id: report.id,
        resolution: 'The review meets the publication policy and remains public.',
      });
      assert.equal(
        (
          await sql`SELECT count(*)::int n FROM client_update WHERE client_id=${f.owner} AND action='review_report_closed'`
        )[0].n,
        1,
      );
    }),
);
test(
  'owner contact codes are session-bound, verified, rate-limited and rotate sessions atomically',
  options,
  () =>
    fixture(async (sql, f) => {
      const sessionId = await issuePortalSession(sql, 'client', f.owner, 3600),
        second = await issuePortalSession(sql, 'client', f.owner, 3600),
        actor = { id: f.owner, sessionId };
      let code;
      await assert.rejects(
        requestOwnerContactChange(
          sql,
          actor,
          { channel: 'email', identifier: 'new@fixture.invalid' },
          enabled,
          async () => {
            throw Error('unavailable');
          },
        ),
        { code: 'OTP_DELIVERY_FAILED' },
      );
      const issued = await requestOwnerContactChange(
        sql,
        actor,
        { channel: 'email', identifier: 'new@fixture.invalid' },
        enabled,
        async (m) => {
          code = m.code;
        },
      );
      assert.ok(issued.challengeId);
      assert.ok(!JSON.stringify(issued).includes(code));
      await assert.rejects(
        requestOwnerContactChange(
          sql,
          actor,
          { channel: 'email', identifier: 'again@fixture.invalid' },
          enabled,
          async () => {},
        ),
        { code: 'OTP_COOLDOWN' },
      );
      assert.equal(
        (
          await confirmOwnerContactChange(
            sql,
            { id: f.owner, sessionId: second },
            { challengeId: issued.challengeId, code },
            enabled,
          )
        ).code,
        'CODE_EXPIRED',
      );
      assert.equal(
        (
          await confirmOwnerContactChange(
            sql,
            actor,
            { challengeId: issued.challengeId, code: code === '000000' ? '000001' : '000000' },
            enabled,
          )
        ).code,
        'WRONG_CODE',
      );
      const saved = await confirmOwnerContactChange(
        sql,
        actor,
        { challengeId: issued.challengeId, code },
        enabled,
      );
      assert.ok(saved.sessionId);
      assert.equal(
        (await sql`SELECT email FROM "user" WHERE id=${f.owner}`)[0].email,
        'new@fixture.invalid',
      );
      assert.equal(
        await validPortalSession(sql, { role: 'client', userId: f.owner, sessionId }, 'client'),
        false,
      );
      const current = { id: f.owner, sessionId: saved.sessionId };
      const phone = await requestOwnerContactChange(
        sql,
        current,
        { channel: 'sms', identifier: '+919876543210' },
        enabled,
        async (m) => {
          code = m.code;
        },
      );
      const changed = await confirmOwnerContactChange(
        sql,
        current,
        { challengeId: phone.challengeId, code },
        enabled,
      );
      assert.equal(
        (await sql`SELECT phone FROM "user" WHERE id=${f.owner}`)[0].phone,
        '9876543210',
      );
      const latest = { id: f.owner, sessionId: changed.sessionId };
      await issuePortalSession(sql, 'client', f.owner, 3600);
      await signOutOtherOwnerSessions(sql, latest);
      assert.equal((await ownerSecurityPage(sql, latest)).sessions.length, 1);
    }),
);
test(
  'owner CMS, caretaker delivery/copy fallback and reviewed privacy export/deletion share scoped pipeline',
  options,
  () =>
    fixture(async (sql, f) => {
      const guide = await publicContent(sql, 'owner_help');
      assert.equal(new Set(guide.body.faqs.map((r) => r.group)).size, 7);
      assert.deepEqual(validateContent('owner_help', guide.body), guide.body);
      await assert.rejects(publicContent(sql, 'unsupported'), { statusCode: 404 });
      assert.throws(() =>
        validateContent('owner_help', {
          ...guide.body,
          faqs: [{ ...guide.body.faqs[0], href: 'https://evil.invalid' }],
        }),
      );
      const link = await inviteStaff(sql, f.owner, {
        name: 'Caretaker Fixture',
        phone: '9876543210',
        propertyIds: [f.listing],
        evidence: true,
      });
      assert.equal(
        (await deliverCaretakerInvite(sql, f.owner, link, { env: {} })).deliveryState,
        'not_sent',
      );
      const sent = await deliverCaretakerInvite(sql, f.owner, link, {
        env: enabled,
        adapter: () => ({
          send: async (row, body) => {
            assert.ok(body.includes(link.token));
            return { id: 'SM' + 'd'.repeat(32), state: 'accepted' };
          },
        }),
      });
      assert.equal(sent.deliveryState, 'accepted');
      assert.equal(
        (await sql`SELECT delivery_state FROM staff_invitation WHERE id=${link.invitationId}`)[0]
          .delivery_state,
        'accepted',
      );
      const actor = {
          kind: 'owner',
          id: f.owner,
          sessionId: await issuePortalSession(sql, 'client', f.owner, 3600),
        },
        admin = {
          kind: 'admin',
          id: f.admin,
          sessionId: await issuePortalSession(sql, 'admin', f.admin, 3600),
        };
      const access = await requestOwnerPrivacy(sql, actor, { kind: 'access' });
      assert.equal((await requestOwnerPrivacy(sql, actor, { kind: 'access' })).id, access.id);
      const command = async (id, cmd, extra = {}) => {
        const [r] = await sql`SELECT version FROM customer_privacy_request WHERE id=${id}`;
        return privacyCommand(
          sql,
          admin,
          id,
          {
            command: cmd,
            version: r.version,
            reason: 'Reviewed owner identity and retention scope',
            confirmed: true,
            ...extra,
          },
          enabled,
        );
      };
      const review = (id) =>
        command(id, 'review', {
          authority: 'self',
          identityReference: 'checked-owner-identity',
          deliveryReference: 'verified-owner-contact',
          retentionAccepted: true,
        });
      await review(access.id);
      let preview = await command(access.id, 'preview');
      await command(access.id, 'queue', { previewToken: preview.previewToken });
      assert.equal(await processPrivacyJob(sql, access.id, { env: enabled }), true);
      const exported = JSON.parse(
        (await privacyDownload(sql, actor, access.id, false, enabled)).toString(),
      );
      assert.equal(exported.format, 'rentra-owner-data-v1');
      assert.equal(exported.properties[0].id, f.listing);
      assert.ok(!JSON.stringify(exported).includes(link.token));
      assert.ok(!JSON.stringify(exported).includes('token_hash'));
      await assert.rejects(
        privacyDownload(
          sql,
          {
            kind: 'owner',
            id: f.other,
            sessionId: await issuePortalSession(sql, 'client', f.other, 3600),
          },
          access.id,
          false,
          enabled,
        ),
        { statusCode: 404 },
      );
      const booking = await seedConfirmedBooking(sql, f.listing);
      assert.equal((await readOwnerPrivacy(sql, actor)).deletionBlocked, true);
      await assert.rejects(requestOwnerPrivacy(sql, actor, { kind: 'deletion' }), {
        code: 'ACTIVE_OBLIGATIONS',
      });
      await sql`UPDATE booking SET state='cancelled' WHERE order_id=${booking.order}`;
      const deletion = await requestOwnerPrivacy(sql, actor, { kind: 'deletion' });
      await review(deletion.id);
      preview = await command(deletion.id, 'preview');
      await command(deletion.id, 'queue', { previewToken: preview.previewToken });
      assert.equal(await processPrivacyJob(sql, deletion.id, { env: enabled }), true);
      const [erased] =
        await sql`SELECT email,phone,name,account_status,privacy_erased_at FROM "user" WHERE id=${f.owner}`;
      assert.equal(erased.name, null);
      assert.equal(erased.email, null);
      assert.equal(erased.account_status, 'blocked');
      assert.ok(erased.privacy_erased_at);
    }),
);
test('provider adapters validate pinned recipients and send approved WhatsApp variables or idempotent emails', async () => {
  const config = {
    channel: 'whatsapp',
    account: enabled.TWILIO_ACCOUNT_SID,
    token: 'fixture',
    sender: enabled.TWILIO_WHATSAPP_FROM,
    contentSid: 'HX' + 'b'.repeat(32),
  };
  const row = {
    id: randomUUID(),
    recipient: 'whatsapp:+919876543210',
    sender: config.sender,
    variables: { 1: 'New booking', 2: 'Farm', 3: 'https://fixture.invalid/partner' },
  };
  let calls = 0;
  const adapter = ownerChannelAdapter(config, async (url, init) => {
    calls++;
    assert.equal(init.body.get('ContentSid'), config.contentSid);
    assert.ok(init.body.get('ContentVariables'));
    return Response.json({
      sid: 'SM' + 'c'.repeat(32),
      account_sid: config.account,
      to: row.recipient,
      from: row.sender,
      status: 'queued',
    });
  });
  assert.equal((await adapter.send(row)).state, 'accepted');
  assert.equal(calls, 1);
  await assert.rejects(
    ownerChannelAdapter(config, async () =>
      Response.json({
        sid: 'SM' + 'c'.repeat(32),
        account_sid: config.account,
        to: 'whatsapp:+919999999999',
        from: row.sender,
        status: 'delivered',
      }),
    ).send(row),
    { code: 'DELIVERY_SCOPE_MISMATCH' },
  );
  const email = {
    ...row,
    recipient: 'owner@fixture.invalid',
    sender: enabled.OTP_EMAIL_FROM,
    title: 'New booking',
    provider_id: 'email-fixture',
  };
  const mail = ownerChannelAdapter(
    { channel: 'email', token: 'fixture', sender: email.sender },
    async (url, init) => {
      if (init.method === 'POST') {
        assert.equal(init.headers['Idempotency-Key'], `owner/${row.id}`);
        return Response.json({ id: email.provider_id });
      }
      return Response.json({
        id: email.provider_id,
        to: [email.recipient],
        from: email.sender,
        last_event: 'delivered',
      });
    },
  );
  assert.equal((await mail.send(email, 'Body')).state, 'accepted');
  assert.equal((await mail.fetch(email)).state, 'delivered');
  const sms = {
    ...row,
    recipient: '+919876543210',
    sender: enabled.TWILIO_FROM_NUMBER,
    body_hash: bodyHash('Body'),
  };
  assert.equal(
    (
      await ownerChannelAdapter({ ...config, channel: 'sms', sender: sms.sender }, async () =>
        Response.json({
          sid: 'SM' + 'c'.repeat(32),
          account_sid: config.account,
          to: sms.recipient,
          from: sms.sender,
          body: 'Body',
          status: 'delivered',
        }),
      ).send(sms, 'Body')
    ).state,
    'delivered',
  );
});

test(
  'owner display name is locked after submission, language stays editable and legal name stays separate',
  options,
  () =>
    fixture(async (sql, f) => {
      const [owner] = await sql`SELECT name FROM "user" WHERE id=${f.owner}`;
      await sql`INSERT INTO client_application(user_id,legal_name,status) VALUES(${f.owner},'Legal Owner Name','submitted')`;
      for (const status of ['submitted', 'approved']) {
        await sql`UPDATE client_application SET status=${status} WHERE user_id=${f.owner}`;
        assert.ok(
          (
            await saveOwnerAccount(sql, f.owner, {
              name: 'Changed Display Name',
              preferredLocale: 'hi',
            })
          ).errors.name,
        );
        assert.equal(
          (await saveOwnerAccount(sql, f.owner, { name: owner.name, preferredLocale: 'gu' })).ok,
          true,
        );
        assert.equal(
          (await sql`SELECT legal_name FROM client_application WHERE user_id=${f.owner}`)[0]
            .legal_name,
          'Legal Owner Name',
        );
      }
      await sql`UPDATE client_application SET status='more_info_needed' WHERE user_id=${f.owner}`;
      assert.equal(
        (
          await saveOwnerAccount(sql, f.owner, {
            name: 'Changed Display Name',
            preferredLocale: 'en',
          })
        ).ok,
        true,
      );
      assert.equal(
        (
          await sql`SELECT count(*)::int n FROM audit_log WHERE actor_id=${f.owner} AND action='account_settings_saved'`
        )[0].n,
        3,
      );
    }),
);
