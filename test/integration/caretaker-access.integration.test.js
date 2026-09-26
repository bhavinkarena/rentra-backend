import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedConfirmedBooking, seedReviewFixture } from '../helpers/listing-review-fixture.js';

const future = (days) => {
  const date = new Date(Date.now() + days * 86400000 + 5.5 * 3600000);
  return `${date.toISOString().slice(0, 10)}T11:00`;
};
const ALL = [
  'ownerIdentity',
  'matchesPhotos',
  'amenitiesPresent',
  'locationMatches',
  'ownershipOriginal',
  'safeForGuests',
];
const MONEY = ['rentMinor', 'feeMinor', 'depositMinor', 'payments', 'amount_rent_minor', 'refunds'];

test(
  'CP16 caretaker access: scoped invitations, one-time links, live reassignment and revocation',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = fixture.url;
      const f = await seedReviewFixture(sql);
      const id = f.listing;
      const { submitProperty, decidePropertyReview } = await import('@/services/admin/listings.js');
      const v = await import('@/services/admin/verification.js');
      const team = await import('@/services/auth/staff-team.js');
      const { issuePortalSession, validPortalSession } =
        await import('@/services/auth/portal-sessions.js');
      const { capabilitiesFor } = await import('@/services/auth/capabilities.js');
      const visits = await import('@/services/booking/staff-visits.js');
      const { recordVisitTransition } = await import('@/services/booking/visit-lifecycle.js');
      const { readBookingRecord } = await import('@/services/booking/records.js');

      const [{ udt_name: geometryType }] =
        await sql`SELECT udt_name FROM information_schema.columns WHERE table_name='rentable' AND column_name='location'`;
      if (geometryType !== 'geometry') {
        // Local test clusters have no PostGIS; the owner booking record only reads coordinates.
        await sql`CREATE FUNCTION st_x(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
        await sql`CREATE FUNCTION st_y(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
      }
      // A published property with a started visit, and a second unassigned property.
      const { submissionId } = await submitProperty(sql, { id, clientId: f.owner });
      await decidePropertyReview(sql, {
        id,
        adminId: f.admin,
        input: { submissionId, outcome: 'approved_for_visit', reason: 'Ready for verification' },
      });
      const { visitId } = await v.scheduleVerification(sql, {
        adminId: f.admin,
        id,
        input: { submissionId, mode: 'video_call', scheduledAt: future(2) },
      });
      await v.recordVerificationOutcome(sql, {
        adminId: f.admin,
        id,
        visitId,
        input: {
          expectedVersion: 1,
          outcome: 'passed',
          findings: 'Video walk-through matched the photos.',
          checklist: ALL,
        },
      });
      await v.publishProperty(sql, { adminId: f.admin, id, input: { submissionId } });
      const booked = await seedConfirmedBooking(sql, id);
      // Same shape as the CP11/12 gate seed: a visit in progress with its committed reservation.
      await sql`UPDATE booking SET starts_at=now()-interval '1 hour', ends_at=now()+interval '2 hours',
        blocked_start_at=now()-interval '90 minutes', blocked_end_at=now()+interval '150 minutes', hours_known=true,
        local_day=(now() AT TIME ZONE 'Asia/Kolkata')::date, day=(now() AT TIME ZONE 'Asia/Kolkata')::date WHERE order_id=${booked.order}`;
      await sql`INSERT INTO inventory_reservation(rentable_id,booking_id,source,state,blocked_start_at,blocked_end_at)
        SELECT rentable_id,id,'booking','committed',blocked_start_at,blocked_end_at FROM booking WHERE order_id=${booked.order}`;
      const [visit] =
        await sql`SELECT id, lifecycle_version FROM booking WHERE order_id=${booked.order}`;
      const [second] =
        await sql`INSERT INTO rentable(client_id,slug,title,category_id,city_id,area_id,public_code,status)
        SELECT client_id,'second-farm','Second Farm',category_id,city_id,area_id,'second01','live' FROM rentable WHERE id=${id} RETURNING id`;
      const [foreign] =
        await sql`INSERT INTO rentable(client_id,slug,title,category_id,city_id,area_id,public_code,status)
        SELECT ${f.other},'foreign-farm','Foreign Farm',category_id,city_id,area_id,'foreign01','live' FROM rentable WHERE id=${id} RETURNING id`;

      // Invitation: guessed properties and bad numbers are refused whole.
      const invite = (input) =>
        team.inviteStaff(sql, f.owner, {
          name: 'Ramesh Caretaker',
          phone: '98765 43210',
          evidence: false,
          ...input,
        });
      await assert.rejects(
        invite({ propertyIds: [id, foreign.id] }),
        (e) => e.statusCode === 422 && Boolean(e.fields.propertyIds),
      );
      await assert.rejects(invite({ propertyIds: [id], phone: '12345' }), (e) =>
        Boolean(e.fields.phone),
      );
      await assert.rejects(invite({ propertyIds: [] }), (e) => Boolean(e.fields.propertyIds));
      const first = await invite({ propertyIds: [id] });
      await assert.rejects(invite({ propertyIds: [id] }), { code: 'STAFF_EXISTS' });
      assert.equal((await team.inspectInvite(sql, first.token)).state, 'valid');
      assert.deepEqual((await team.inspectInvite(sql, first.token)).properties, [
        'Review River Farm',
      ]);
      assert.equal((await team.inspectInvite(sql, 'x'.repeat(43))).state, 'invalid');
      assert.equal(
        await issuePortalSession(sql, 'staff', first.staffId, 3600),
        null,
        'no session before acceptance',
      );

      // A reissued link kills the first; a link works once, even under a race.
      const second_link = await team.reissueStaffLink(sql, f.owner, first.staffId);
      assert.equal((await team.inspectInvite(sql, first.token)).state, 'revoked');
      const race = await Promise.allSettled([
        team.consumeInvite(sql, second_link.token),
        team.consumeInvite(sql, second_link.token),
      ]);
      assert.deepEqual(race.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
      assert.equal((await team.inspectInvite(sql, second_link.token)).state, 'used');
      await assert.rejects(team.consumeInvite(sql, second_link.token), { code: 'INVITE_USED' });

      // Session: valid while active; read-only without the evidence grant.
      const sessionId = await issuePortalSession(sql, 'staff', first.staffId, 3600);
      const claims = { staffId: first.staffId, sessionId };
      assert.equal(await validPortalSession(sql, claims, 'staff'), true);
      assert.equal(
        await validPortalSession(sql, { ...claims, staffId: randomUUID() }, 'staff'),
        false,
      );
      assert.equal(
        await validPortalSession(
          sql,
          { userId: first.staffId, role: 'client', sessionId },
          'client',
        ),
        false,
        'a staff session is never a client session',
      );
      let caps = capabilitiesFor({ active: true, permissions: { evidence: false } }, 'staff');
      assert.deepEqual(caps, ['staff.assigned-visits.read']);
      const [owner] = await sql`SELECT name, phone FROM "user" WHERE id=${f.owner}`;
      const actor = (capabilities) => ({
        id: first.staffId,
        ownerId: f.owner,
        ownerName: owner.name,
        ownerPhone: owner.phone,
        capabilities,
      });

      // Reads: assigned property only, never money.
      const list = await visits.listStaffVisits(sql, actor(caps), { tab: 'today' });
      assert.equal(list.items.length, 1);
      assert.equal(list.items[0].id, visit.id);
      const record = await visits.readStaffVisitRecord(sql, actor(caps), booked.order);
      assert.equal(record.propertyTitle, 'Review River Farm');
      assert.equal(record.arrival.address, '12 Private Lane');
      assert.equal(record.canRecord, false);
      for (const key of MONEY)
        assert.equal(JSON.stringify(record).includes(key), false, `record exposes ${key}`);
      assert.equal(
        JSON.stringify(record).includes('booked-guest@fixture.invalid'),
        false,
        'no guest identity',
      );
      assert.equal(await visits.readStaffVisitRecord(sql, actor(caps), randomUUID()), null);

      // Evidence: refused without the grant, accepted with it, attributed to the caretaker.
      const transition = (expectedVersion) =>
        recordVisitTransition(
          sql,
          { kind: 'staff', id: first.staffId },
          {
            visitId: visit.id,
            phase: 'handover',
            occurredAt: new Date(Date.now() - 60000).toISOString(),
            note: 'Guest group of two received the keys at the gate.',
            attested: true,
            expectedVersion,
            requestKey: randomUUID(),
          },
        );
      await assert.rejects(transition(visit.lifecycle_version), { code: 'OPERATOR_REQUIRED' });
      const [member] = (await team.listTeam(sql, f.owner)).members;
      assert.equal(member.state, 'active');
      await assert.rejects(
        team.updateStaffAccess(sql, f.owner, first.staffId, {
          expectedVersion: member.version + 5,
          propertyIds: [id],
          evidence: 'on',
        }),
        { code: 'STAFF_CHANGED' },
      );
      const granted = await team.updateStaffAccess(sql, f.owner, first.staffId, {
        expectedVersion: member.version,
        propertyIds: [id],
        evidence: 'on',
      });
      caps = capabilitiesFor({ active: true, permissions: { evidence: true } }, 'staff');
      await transition(visit.lifecycle_version);
      const [evidence] =
        await sql`SELECT actor_kind, actor_id FROM visit_evidence WHERE booking_id=${visit.id}`;
      assert.deepEqual([evidence.actor_kind, evidence.actor_id], ['staff', first.staffId]);
      const ownerView = await readBookingRecord(sql, { kind: 'owner', id: f.owner }, booked.order);
      assert.equal(ownerView.visits[0].evidence[0].actorKind, 'staff');
      assert.equal(ownerView.visits[0].evidence[0].actorName, 'Ramesh Caretaker');

      // Reassignment applies to the next request.
      const moved = await team.updateStaffAccess(sql, f.owner, first.staffId, {
        expectedVersion: granted.version,
        propertyIds: [second.id],
        evidence: 'on',
      });
      assert.equal(
        (await visits.listStaffVisits(sql, actor(caps), { tab: 'today' })).items.length,
        0,
      );
      assert.equal(await visits.readStaffVisitRecord(sql, actor(caps), booked.order), null);
      const [now] = await sql`SELECT lifecycle_version FROM booking WHERE id=${visit.id}`;
      await assert.rejects(
        recordVisitTransition(
          sql,
          { kind: 'staff', id: first.staffId },
          {
            visitId: visit.id,
            phase: 'return',
            occurredAt: new Date().toISOString(),
            note: 'Guests returned the keys and the property is clean.',
            attested: true,
            expectedVersion: now.lifecycle_version,
            requestKey: randomUUID(),
          },
        ),
        { code: 'OPERATOR_REQUIRED' },
      );

      // Owner suspension ends caretaker sessions; reinstatement restores them.
      await sql`UPDATE "user" SET account_status='suspended' WHERE id=${f.owner}`;
      assert.equal(await validPortalSession(sql, claims, 'staff'), false);
      await sql`UPDATE "user" SET account_status='active' WHERE id=${f.owner}`;

      // Revocation: immediate for sessions and links.
      const pending = await team.reissueStaffLink(sql, f.owner, first.staffId);
      const revoked = await team.revokeStaff(sql, f.owner, first.staffId, {
        expectedVersion: moved.version,
        reason: 'Left the job',
      });
      assert.ok(revoked.sessionsRevoked >= 1);
      assert.equal(await validPortalSession(sql, claims, 'staff'), false);
      assert.equal((await team.inspectInvite(sql, pending.token)).state, 'revoked');
      assert.equal(await issuePortalSession(sql, 'staff', first.staffId, 3600), null);
      await assert.rejects(team.reissueStaffLink(sql, f.owner, first.staffId), {
        code: 'STAFF_REVOKED',
      });

      // Another owner cannot see or touch this caretaker.
      assert.equal((await team.listTeam(sql, f.other)).members.length, 0);
      await assert.rejects(
        team.revokeStaff(sql, f.other, first.staffId, { expectedVersion: 1, reason: 'Not mine' }),
        { statusCode: 404 },
      );

      // Expired links never work; re-inviting a revoked caretaker starts fresh.
      const again = await invite({ propertyIds: [id] });
      assert.equal(again.staffId, first.staffId);
      await sql`UPDATE staff_invitation SET expires_at=now()-interval '1 minute' WHERE token_hash=encode(sha256(convert_to(${again.token},'UTF8')),'hex')`;
      assert.equal((await team.inspectInvite(sql, again.token)).state, 'expired');
      await assert.rejects(team.consumeInvite(sql, again.token), { code: 'INVITE_EXPIRED' });
      const [fresh] = (await team.listTeam(sql, f.owner)).members;
      assert.equal(fresh.state, 'invite_expired');
      assert.equal(fresh.permissions.evidence, false);

      // History records every owner and caretaker action.
      const actions = (await team.listTeam(sql, f.owner)).history.map((h) => h.action);
      for (const action of [
        'staff_invited',
        'staff_link_issued',
        'staff_invite_accepted',
        'staff_access_changed',
        'staff_revoked',
      ])
        assert.ok(actions.includes(action), `history has ${action}`);
    } finally {
      delete globalThis.__rentraSql;
      await fixture.drop();
    }
  },
);
