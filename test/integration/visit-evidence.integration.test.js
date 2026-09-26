import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import { recordVisitTransition } from '../../src/services/booking/visit-lifecycle.js';
import {
  closeVisitIncident,
  correctVisitEvidence,
  readVisitAttachment,
  reportVisitIncident,
} from '../../src/services/booking/visit-evidence.js';
import { listBookingRecords, readBookingRecord } from '../../src/services/booking/records.js';
import { memoryEvidenceStore } from '../../src/services/uploads/evidence-store.js';

const png = (seed) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, seed),
  ]);
const photo = (buffer) => new File([buffer], 'photo.png', { type: 'image/png' });
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const bytesOf = async (stream) => Buffer.from(await new Response(stream).arrayBuffer());

test(
  'CP13 private evidence photos, incidents, superseding corrections, scope and append-only history',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = fixture.sql;
    try {
      const f = await seedReviewFixture(sql),
        booked = await seedConfirmedBooking(sql, f.listing);
      const store = memoryEvidenceStore();
      const [{ udt_name }] =
        await sql`SELECT udt_name FROM information_schema.columns WHERE table_name='rentable' AND column_name='location'`;
      if (udt_name !== 'geometry') {
        await sql`CREATE FUNCTION st_x(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
        await sql`CREATE FUNCTION st_y(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
      }
      const owner = { kind: 'owner', id: f.owner },
        other = { kind: 'owner', id: f.other },
        admin = { kind: 'admin', id: f.admin };
      // Visit A: a real visit happening now. Visit B: a Test visit yesterday (no overlapping inventory).
      const [a] =
        await sql`UPDATE booking SET visit_provenance='real',hours_known=true,starts_at=now()-interval '1 hour',ends_at=now()+interval '2 hours',
        blocked_start_at=now()-interval '1 hour',blocked_end_at=now()+interval '2 hours' WHERE order_id=${booked.order} RETURNING *`;
      const [b] =
        await sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,day,local_day,slot,state,amount_rent,amount_fee,starts_at,ends_at,hours_known,
        blocked_start_at,blocked_end_at,currency,time_zone,amount_rent_minor,amount_fee_minor,amount_deposit_minor,visit_provenance,units_booked,guests)
        VALUES ('CP13-TEST',${f.listing},${booked.customer},${booked.order},2,current_date-1,current_date-1,'day','confirmed',1000,80,
        now()-interval '28 hours',now()-interval '24 hours',true,now()-interval '28 hours',now()-interval '24 hours','INR','Asia/Kolkata',100000,8000,0,'test',1,2) RETURNING *`;
      for (const visit of [a, b])
        await sql`INSERT INTO inventory_reservation(rentable_id,booking_id,source,state,blocked_start_at,blocked_end_at) VALUES (${f.listing},${visit.id},'booking','committed',${visit.blocked_start_at},${visit.blocked_end_at})`;
      const version = async (id) =>
        (await sql`SELECT lifecycle_version FROM booking WHERE id=${id}`)[0].lifecycle_version;
      const transition = async (
        actor,
        visitId,
        phase,
        minutes,
        files = [],
        requestKey = randomUUID(),
      ) => ({
        input: {
          visitId,
          phase,
          occurredAt: ago(minutes),
          note: `Observed ${phase} directly at the property with the guest present.`,
          attested: true,
          expectedVersion: await version(visitId),
          requestKey,
        },
        files,
        actor,
      });
      const run = (t) => recordVisitTransition(sql, t.actor, t.input, { files: t.files, store });

      // Handover with two private photos; replay is one effect; changed photos with the same key conflict.
      const handover = await transition(owner, a.id, 'handover', 40, [
        photo(png(1)),
        photo(png(2)),
      ]);
      const priorVersion = handover.input.expectedVersion;
      const first = await run(handover);
      assert.equal((await run(handover)).id, first.id);
      await assert.rejects(run({ ...handover, files: [photo(png(3))] }), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
      const attachments =
        await sql`SELECT * FROM visit_attachment WHERE evidence_id=${first.id} ORDER BY position`;
      assert.equal(attachments.length, 2);
      assert.ok(
        attachments.every(
          (x) =>
            x.retention_class === 'visit_evidence' &&
            x.nature === 'actual' &&
            x.mime_type === 'image/png',
        ),
      );
      assert.equal(store.files.size, 2, 'the conflicting retry uploaded nothing new');
      assert.equal(
        (await sql`SELECT visit_version FROM visit_evidence WHERE id=${first.id}`)[0].visit_version,
        priorVersion,
      );

      // Unsafe or stale submissions write nothing and upload nothing.
      const unsafe = await transition(owner, a.id, 'return', 20, [
        photo(Buffer.from('GIF89a' + 'x'.repeat(40))),
      ]);
      await assert.rejects(run(unsafe), { code: 'INVALID_ATTACHMENT' });
      const stale = await transition(owner, a.id, 'return', 20, [photo(png(4))]);
      stale.input.expectedVersion -= 1;
      await assert.rejects(run(stale), { code: 'VISIT_CHANGED' });
      assert.equal(store.files.size, 2);
      assert.equal(
        (await sql`SELECT count(*)::int n FROM visit_evidence WHERE booking_id=${a.id}`)[0].n,
        1,
      );
      await assert.rejects(run(await transition(other, a.id, 'return', 20)), {
        code: 'OPERATOR_REQUIRED',
      });

      // Authorized, audited reads; guessed, foreign and mismatched ids are the same 404.
      const read = (actor, orderId, id, s = store) =>
        readVisitAttachment(sql, actor, orderId, id, { store: s, ip: '127.0.0.1' });
      const ownRead = await read(owner, booked.order, attachments[0].id);
      assert.equal(ownRead.status, 200);
      assert.equal(ownRead.contentType, 'image/png');
      assert.deepEqual(await bytesOf(ownRead.body), png(1));
      assert.equal((await read(admin, booked.order, attachments[1].id)).status, 200);
      assert.equal((await read(other, booked.order, attachments[0].id)).status, 404);
      assert.equal((await read(owner, randomUUID(), attachments[0].id)).status, 404);
      assert.equal((await read(owner, booked.order, 'not-a-uuid')).status, 404);
      assert.equal(
        (await read(owner, booked.order, attachments[0].id, memoryEvidenceStore())).status,
        502,
      );
      await assert.rejects(
        read({ kind: 'customer', id: booked.customer }, booked.order, attachments[0].id),
        { code: 'OPERATOR_REQUIRED' },
      );
      const views =
        await sql`SELECT actor_type,ip FROM audit_log WHERE action='visit_attachment_viewed' ORDER BY at`;
      assert.deepEqual(
        views.map((v) => v.actor_type),
        ['client', 'admin'],
        'only successful reads are audited',
      );

      // Incidents: owner reports on the real visit, admin on the Test visit; natures follow provenance.
      const report = (actor, visitId, extra = {}, files = []) =>
        reportVisitIncident(
          sql,
          actor,
          {
            visitId,
            category: 'damage',
            summary: 'Broken garden chair',
            description: 'One garden chair was found broken near the pool after the group left.',
            occurredAt: ago(15),
            attested: true,
            requestKey: randomUUID(),
            ...extra,
          },
          { files, store },
        );
      const same = { requestKey: randomUUID(), occurredAt: ago(15) };
      const incident = await report(owner, a.id, same, [photo(png(5))]);
      assert.match(incident.reference, /^INC-[0-9A-F]{10}$/);
      assert.equal((await report(owner, a.id, same, [photo(png(5))])).id, incident.id);
      await assert.rejects(report(owner, a.id, same, [photo(png(6))]), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
      await assert.rejects(report(other, a.id), { code: 'VISIT_NOT_FOUND' });
      await assert.rejects(
        report(owner, a.id, { occurredAt: new Date(Date.now() + 3600000).toISOString() }),
        { code: 'INVALID_EVIDENCE_TIME' },
      );
      const simulated = await report(admin, b.id, {
        category: 'access',
        summary: 'Gate code test',
        description: 'Simulated access problem logged against the Test visit only.',
      });
      const natures = await sql`SELECT id,nature FROM visit_incident ORDER BY created_at`;
      assert.deepEqual(
        natures.map((n) => n.nature),
        ['actual', 'simulation'],
      );
      const [incidentPhoto] =
        await sql`SELECT * FROM visit_attachment WHERE incident_id=${incident.id}`;
      assert.equal(incidentPhoto.retention_class, 'incident_evidence');

      // Complete both visits so only the open incident keeps the order in the admin queue.
      await run(await transition(owner, a.id, 'return', 20));
      await run(await transition(owner, a.id, 'complete', 10));
      for (const [phase, minutes] of [
        ['handover', 27 * 60],
        ['return', 25 * 60],
        ['complete', 24 * 60],
      ])
        await run(await transition(admin, b.id, phase, minutes));
      const queue = async (actor) =>
        (await listBookingRecords(sql, actor, { tab: 'action_needed' })).total;
      assert.equal(await queue(admin), 2 - 1, 'open incident is admin work');
      assert.equal(await queue(owner), 0, 'owners are not asked to act on Rentra follow-up');

      // Closure: admin only, version-guarded, one winner, final.
      await assert.rejects(
        closeVisitIncident(sql, owner, {
          incidentId: incident.id,
          expectedVersion: 1,
          resolutionNote: 'Owner cannot close this.',
        }),
        { code: 'OPERATOR_REQUIRED' },
      );
      await assert.rejects(
        closeVisitIncident(sql, admin, {
          incidentId: incident.id,
          expectedVersion: 2,
          resolutionNote: 'Wrong version attempt.',
        }),
        { code: 'INCIDENT_CHANGED' },
      );
      const closing = await Promise.allSettled(
        [1, 2].map(() =>
          closeVisitIncident(sql, admin, {
            incidentId: incident.id,
            expectedVersion: 1,
            resolutionNote: 'Chair replaced by the owner; no guest charge raised here.',
          }),
        ),
      );
      assert.equal(closing.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(closing.find((r) => r.status === 'rejected').reason.code, 'INCIDENT_CHANGED');
      assert.equal(await queue(admin), 1, 'the Test visit incident is still open');
      await assert.rejects(
        sql`UPDATE visit_incident SET state='open',resolution_note=NULL,closed_at=NULL,closed_by=NULL,version=3 WHERE id=${incident.id}`,
      );
      await assert.rejects(
        sql`UPDATE visit_incident SET summary='Rewritten summary' WHERE id=${simulated.id}`,
      );
      await assert.rejects(sql`DELETE FROM visit_incident WHERE id=${simulated.id}`);

      // Corrections: admin decision, linear chain, ordered times, original kept, state untouched.
      const correct = (actor, input) =>
        correctVisitEvidence(sql, actor, {
          supersedesId: null,
          correctedOccurredAt: null,
          correctedNote: null,
          requestKey: randomUUID(),
          reason: 'Owner reported the wrong handover time.',
          ...input,
        });
      await assert.rejects(correct(owner, { evidenceId: first.id, correctedOccurredAt: ago(50) }), {
        code: 'OPERATOR_REQUIRED',
      });
      await assert.rejects(correct(admin, { evidenceId: first.id, correctedOccurredAt: ago(15) }), {
        code: 'INVALID_EVIDENCE_TIME',
      });
      await assert.rejects(correct(admin, { evidenceId: first.id, correctedOccurredAt: ago(70) }), {
        code: 'INVALID_EVIDENCE_TIME',
      });
      const fix = { evidenceId: first.id, correctedOccurredAt: ago(50), requestKey: randomUUID() };
      const c1 = await correct(admin, fix);
      assert.equal((await correct(admin, fix)).id, c1.id, 'replay is one correction');
      await assert.rejects(
        correct(admin, {
          evidenceId: first.id,
          correctedNote: 'A second correction prepared against the original.',
        }),
        { code: 'EVIDENCE_CHANGED' },
      );
      const c2 = await correct(admin, {
        evidenceId: first.id,
        supersedesId: c1.id,
        correctedNote: 'Keys handed to the guest leader after the arrival walkthrough.',
      });
      await assert.rejects(
        correct(admin, {
          evidenceId: first.id,
          supersedesId: c2.id,
          correctedNote: 'Keys handed to the guest leader after the arrival walkthrough.',
        }),
        { code: 'NO_CHANGE' },
      );
      const [simEvidence] =
        await sql`SELECT id FROM visit_evidence WHERE booking_id=${b.id} AND kind='handover'`;
      await correct(admin, {
        evidenceId: simEvidence.id,
        correctedNote: 'Simulated handover note corrected for the Test visit.',
      });
      assert.deepEqual(
        (await sql`SELECT nature FROM visit_evidence_correction ORDER BY created_at`).map(
          (r) => r.nature,
        ),
        ['actual', 'actual', 'simulation'],
      );
      assert.equal((await sql`SELECT state FROM booking WHERE id=${a.id}`)[0].state, 'completed');
      const [original] =
        await sql`SELECT occurred_at,note FROM visit_evidence WHERE id=${first.id}`;
      assert.equal(new Date(original.occurred_at).toISOString(), handover.input.occurredAt);
      assert.equal(original.note, handover.input.note);

      // Append-only at the database, including direct writes that bypass the services.
      await assert.rejects(
        sql`UPDATE visit_evidence SET note='Rewritten note that tries to erase history.' WHERE id=${first.id}`,
      );
      await assert.rejects(sql`DELETE FROM visit_attachment WHERE id=${attachments[0].id}`);
      await assert.rejects(
        sql`UPDATE visit_evidence_correction SET reason='Changed reason text here.' WHERE id=${c1.id}`,
      );
      await assert.rejects(
        sql`INSERT INTO visit_evidence_correction(evidence_id,booking_id,supersedes_id,reason,corrected_note,nature,actor_kind,actor_id,request_key,request_hash)
          VALUES (${simEvidence.id},${b.id},NULL,'Relabel as actual evidence.','Trying to turn Test evidence into actual.','actual','admin',${f.admin},${randomUUID()},${'c'.repeat(64)})`,
      );
      await assert.rejects(
        sql`INSERT INTO visit_attachment(booking_id,evidence_id,position,storage_key,sha256,mime_type,bytes,retention_class,nature,actor_kind,actor_id)
          VALUES (${b.id},${first.id},2,'k',${'d'.repeat(64)},'image/png',10,'visit_evidence','actual','owner',${f.owner})`,
      );

      // Read models: operators see photos (never storage keys); admins see names; customers see neither.
      const ownerView = await readBookingRecord(sql, owner, booked.order);
      const visitA = ownerView.visits.find((v) => v.id === a.id);
      const handoverView = visitA.evidence.find((e) => e.kind === 'handover');
      assert.equal(handoverView.attachments.length, 2);
      assert.equal(handoverView.corrections.length, 2);
      assert.equal(handoverView.original.note, handover.input.note);
      assert.equal(
        handoverView.note,
        'Keys handed to the guest leader after the arrival walkthrough.',
      );
      assert.equal(handoverView.occurredAt, fix.correctedOccurredAt);
      assert.equal(handoverView.headCorrectionId, c2.id);
      assert.equal(handoverView.actorKind, 'owner');
      assert.equal(handoverView.actorName, undefined);
      assert.equal(visitA.incidents[0].state, 'closed');
      assert.doesNotMatch(JSON.stringify(ownerView), /storage|visit-evidence\//);
      const adminView = await readBookingRecord(sql, admin, booked.order);
      assert.equal(
        adminView.visits.find((v) => v.id === a.id).evidence[0].actorName,
        'Property Owner',
      );
      assert.equal(adminView.visits.find((v) => v.id === b.id).incidents[0].actorName, 'Reviewer');
      const [sessionRow] =
        await sql`INSERT INTO customer_session(user_id,expires_at) VALUES (${booked.customer},now()+interval '1 day') RETURNING id`;
      const customerView = await readBookingRecord(
        sql,
        {
          kind: 'customer',
          session: { role: 'customer', userId: booked.customer, sessionId: sessionRow.id },
        },
        booked.order,
      );
      const customerA = customerView.visits.find((v) => v.id === a.id);
      assert.equal(customerA.incidents, undefined);
      assert.equal(customerA.evidence[0].note, undefined);
      assert.equal(customerA.evidence[0].attachments, undefined);
      assert.equal(
        customerA.evidence[0].occurredAt,
        fix.correctedOccurredAt,
        'customers see the effective time only',
      );
      assert.equal(customerA.reviewEligible, true, 'real completed visit stays review-eligible');
      assert.equal(
        customerView.visits.find((v) => v.id === b.id).reviewEligible,
        false,
        'Test evidence never qualifies',
      );
    } finally {
      await fixture.drop();
    }
  },
);
