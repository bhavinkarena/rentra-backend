import 'server-only';
import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { z } from 'zod';
import { capabilitiesFor } from '../auth/capabilities.js';
import { recentAuthentication } from '../auth/recent-auth.js';
import { lockCustomerAccount } from '../auth/customer-access.js';
import { destroyProfilePhoto } from '../uploads/cloudinary.js';
import { forbidden, notFound, conflict, unprocessable, unavailable } from '@/utils/apiError.js';

export const PRIVACY_POLICY = 'rentra-retention-v1';
export const RETAINED = [
  {
    class: 'financial',
    schedule:
      'Eight financial years after FY end provisionally; finance validates applicable accounting/GST deadlines and holds.',
    identifyingFields: 'Historical booking contacts, notes and linked account UUID may remain.',
    reason: 'Preserve bookings, payments, refunds, allocations and cancellation evidence.',
  },
  {
    class: 'cases',
    schedule:
      'Ordinary support: one year after closure; disputes and operational evidence: three years after final closure; linked financial evidence follows its deadline.',
    identifyingFields:
      'Participant statements, attachment photos and historic contact details may remain.',
    reason:
      'Preserve support, review, incident and dispute evidence; review public review text separately.',
  },
  {
    class: 'audit',
    schedule:
      'Security/access: one year from event; minimized privacy receipts: three years from closure; financial audit follows financial deadline.',
    identifyingFields:
      'Account UUID, historical contact fields and verification references may remain.',
    reason: 'Accountability and investigation. No authentication secrets in exports.',
  },
  {
    class: 'external',
    schedule:
      'Routine backup target: 35 days, unverified; KYC: one year after all linked purposes end, subject to reviewed exceptions.',
    identifyingFields:
      'Shared person/KYC records, encrypted payment tokens, provider data, backups and delivered messages require separate review.',
    reason:
      'Local payment-method disable is not provider erasure. These actions are outstanding, not completed by this job.',
  },
];
const uuid = z.string().uuid();
const parse = (schema, input) => {
  const r = schema.safeParse(input);
  if (!r.success)
    throw unprocessable({}, 'Check the privacy review, version, reason and confirmation.');
  return r.data;
};
function key(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16)
    throw unavailable('PRIVACY_KEY_UNAVAILABLE');
  return createHash('sha256')
    .update('rentra:privacy-export:' + env.SESSION_SECRET)
    .digest();
}
function encrypt(value, id, env) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(env), iv);
  cipher.setAAD(Buffer.from(id));
  const bytes = Buffer.concat([cipher.update(value), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map((b) => b.toString('base64')).join('.');
}
function decrypt(value, id, env) {
  const [iv, tag, bytes] = value.split('.').map((v) => Buffer.from(v, 'base64'));
  const cipher = createDecipheriv('aes-256-gcm', key(env), iv);
  cipher.setAAD(Buffer.from(id));
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}
async function admin(tx, actor, write = false) {
  if (actor?.kind !== 'admin' || !uuid.safeParse(actor.id).success) throw forbidden();
  const [row] =
    await tx`SELECT is_active,permissions FROM admin_user WHERE id=${actor.id} FOR SHARE`;
  const grants = row
    ? capabilitiesFor({ isActive: row.is_active, permissions: row.permissions }, 'admin')
    : [];
  if (!grants.includes('admin.privacy.read') || (write && !grants.includes('admin.privacy.write')))
    throw forbidden('CAPABILITY_REQUIRED');
  if (
    write &&
    !(
      await recentAuthentication(tx, {
        kind: 'admin',
        principalId: actor.id,
        sessionId: actor.sessionId,
      })
    ).fresh
  )
    throw forbidden(
      'RECENT_AUTH_REQUIRED',
      'Sign in again within 15 minutes before a privacy decision.',
    );
  return grants.includes('admin.privacy.write');
}
async function audit(tx, actor, id, action, after = {}, reason = null) {
  await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,after,reason) VALUES (${actor.kind},${actor.id ?? null},'customer_privacy_request',${id},${action},${JSON.stringify(after)}::text::jsonb,${reason})`;
}
async function load(tx, id, lock = false) {
  if (!uuid.safeParse(id).success) throw notFound();
  const [scope] = await tx`SELECT customer_id FROM customer_privacy_request WHERE id=${id}`;
  if (!scope) throw notFound();
  // Same account-first ordering as profile, phone and account lifecycle writers.
  const [customer] =
    await tx`SELECT * FROM "user" WHERE id=${scope.customer_id} AND role='customer' ${lock ? tx`FOR UPDATE` : tx``}`;
  if (!customer) throw notFound();
  const [request] =
    await tx`SELECT * FROM customer_privacy_request WHERE id=${id} ${lock ? tx`FOR UPDATE` : tx``}`;
  return { customer, request };
}
export async function privacyInventory(tx, id) {
  const [counts] = await tx`SELECT
    (SELECT count(*)::int FROM booking_order WHERE customer_id=${id}) orders,
    (SELECT count(*)::int FROM booking WHERE customer_id=${id}) visits,
    (SELECT count(*)::int FROM booking WHERE customer_id=${id} AND state NOT IN ('completed','cancelled')) active_visits,
    (SELECT count(*)::int FROM booking_order WHERE customer_id=${id} AND state='held' AND hold_expires_at>clock_timestamp()) holds,
    (SELECT count(*)::int FROM dispute_case WHERE customer_id=${id} AND state<>'resolved') disputes,
    (SELECT count(*)::int FROM refund r JOIN payment_transaction t ON t.id=r.transaction_id JOIN payment_attempt a ON a.id=t.attempt_id JOIN payment_order p ON p.id=a.payment_order_id JOIN booking_order o ON o.id=p.booking_order_id WHERE o.customer_id=${id} AND r.state IN ('requested','processing','unknown')) pending_refunds,
    (SELECT count(*)::int FROM payment_order p JOIN booking_order o ON o.id=p.booking_order_id WHERE o.customer_id=${id} AND p.state IN ('created','processing','unknown')) pending_payments,
    (SELECT count(*)::int FROM support_request WHERE customer_id=${id}) support,
    (SELECT count(*)::int FROM review WHERE author_id=${id}) reviews,
    (SELECT count(*)::int FROM customer_favourite WHERE customer_id=${id}) favourites,
    (SELECT count(*)::int FROM customer_payment_method WHERE customer_id=${id} AND is_active) payment_methods`;
  const [profile] =
    await tx`SELECT version,photo_public_id IS NOT NULL has_photo FROM customer_profile WHERE user_id=${id}`;
  return {
    ...counts,
    profileVersion: profile?.version ?? 0,
    hasPhoto: Boolean(profile?.has_photo),
  };
}
const obligated = (i) =>
  i.active_visits || i.holds || i.disputes || i.pending_refunds || i.pending_payments;
function token(actor, request, customer, inventory, env) {
  return createHmac('sha256', key(env))
    .update(
      JSON.stringify({
        actor: actor.id,
        request: request.id,
        version: request.version,
        review: request.review,
        customerVersion: customer.lifecycle_version,
        updatedAt: customer.updated_at,
        inventory,
      }),
    )
    .digest('hex');
}
function jobView(j) {
  return j
    ? {
        state: j.state,
        stage: j.stage,
        attempts: j.attempts,
        results: j.results,
        errorCode: j.error_code,
        expiresAt: j.expires_at,
      }
    : null;
}
export async function listPrivacyRequests(db, actor, input = {}) {
  const f = parse(
    z.object({
      state: z.enum(['all', 'open', 'in_review', 'closed']).default('all'),
      page: z.coerce.number().int().min(1).max(100000).default(1),
    }),
    input,
  );
  return db.begin(async (tx) => {
    await admin(tx, actor);
    const where = tx`(${f.state}='all' OR r.state=${f.state})`;
    const [count] =
      await tx`SELECT count(*)::int total FROM customer_privacy_request r WHERE ${where}`;
    const pages = Math.max(1, Math.ceil(count.total / 20)),
      page = Math.min(f.page, pages);
    const items =
      await tx`SELECT r.id,r.customer_id,r.kind,r.state,r.version,r.created_at,j.state job_state,j.stage,j.error_code FROM customer_privacy_request r LEFT JOIN privacy_job j ON j.request_id=r.id WHERE ${where} ORDER BY r.created_at DESC,r.id LIMIT 20 OFFSET ${(page - 1) * 20}`;
    return { ...f, page, pages, total: count.total, items };
  });
}
export async function readPrivacyRequest(db, actor, id) {
  return db.begin(async (tx) => {
    const canWrite = await admin(tx, actor);
    const { customer, request } = await load(tx, id);
    const [job] =
      await tx`SELECT state,stage,attempts,results,error_code,expires_at FROM privacy_job WHERE request_id=${id}`;
    await audit(tx, actor, id, 'privacy_detail_read');
    return {
      request,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        erasedAt: customer.privacy_erased_at,
      },
      inventory: await privacyInventory(tx, customer.id),
      job: jobView(job),
      retained: RETAINED,
      policy: PRIVACY_POLICY,
      canWrite,
    };
  });
}
export async function privacyCommand(db, actor, id, input, env = process.env) {
  const f = parse(
    z
      .object({
        command: z.enum(['review', 'preview', 'queue', 'retry']),
        version: z.number().int().min(1),
        reason: z.string().trim().min(20).max(1000),
        confirmed: z.literal(true),
        authority: z.enum(['self', 'representative']).optional(),
        identityReference: z.string().trim().min(8).max(200).optional(),
        deliveryReference: z.string().trim().min(8).max(200).optional(),
        retentionAccepted: z.boolean().optional(),
        previewToken: z.string().optional(),
      })
      .strict(),
    input,
  );
  return db.begin(async (tx) => {
    await admin(tx, actor, true);
    const { customer, request } = await load(tx, id, true);
    if (request.version !== f.version)
      throw conflict('PRIVACY_CHANGED', 'This request changed. Reload before confirming.');
    if (request.state === 'closed') throw conflict('PRIVACY_CLOSED');
    if (f.command === 'review') {
      if (!f.authority || !f.identityReference || !f.deliveryReference)
        throw unprocessable(
          {},
          'Record identity/authority and verified receipt-delivery references; never paste raw identity documents.',
        );
      const [job] = await tx`SELECT request_id FROM privacy_job WHERE request_id=${id}`;
      if (job) throw conflict('JOB_EXISTS');
      const review = {
        by: actor.id,
        at: new Date().toISOString(),
        authority: f.authority,
        identityReference: f.identityReference,
        deliveryReference: f.deliveryReference,
        reason: f.reason,
        policy: PRIVACY_POLICY,
        retentionAccepted: f.retentionAccepted === true,
      };
      await tx`UPDATE customer_privacy_request SET review=${JSON.stringify(review)}::text::jsonb,state='in_review',version=version+1,updated_at=now() WHERE id=${id}`;
      await audit(
        tx,
        actor,
        id,
        'privacy_authority_reviewed',
        {
          authority: f.authority,
          policy: PRIVACY_POLICY,
        },
        f.reason,
      );
      return { ok: true };
    }
    if (!request.review || request.review.policy !== PRIVACY_POLICY)
      throw conflict(
        'REVIEW_REQUIRED',
        'Complete identity and authority review against the current policy first.',
      );
    if (f.command === 'retry') {
      const [job] =
        await tx`UPDATE privacy_job SET state='queued',error_code=NULL,updated_at=now() WHERE request_id=${id} AND state='failed' RETURNING request_id`;
      if (!job) throw conflict('RETRY_UNAVAILABLE', 'Only a failed job can be retried.');
      await tx`UPDATE customer_privacy_request SET version=version+1,updated_at=now() WHERE id=${id}`;
      await audit(tx, actor, id, 'privacy_job_retried', {}, f.reason);
      return { ok: true };
    }
    if (customer.privacy_erased_at || customer.privacy_erasure_pending)
      throw conflict('ERASURE_ALREADY_STARTED');
    const inventory = await privacyInventory(tx, customer.id);
    if (request.kind === 'deletion') {
      if (!request.review.retentionAccepted)
        throw conflict(
          'RETENTION_REVIEW_REQUIRED',
          'Approve the explicit partial-anonymization and retained-record scope first.',
        );
      if (obligated(inventory))
        throw conflict(
          'ACTIVE_OBLIGATIONS',
          'Resolve active visits, holds, disputes and pending payments/refunds before account closure.',
        );
      const [other] =
        await tx`SELECT j.request_id FROM privacy_job j JOIN customer_privacy_request r ON r.id=j.request_id WHERE r.customer_id=${customer.id} AND j.state IN ('queued','running','failed') LIMIT 1`;
      if (other) throw conflict('OTHER_JOB_ACTIVE');
    }
    if (f.command === 'preview')
      return {
        ok: true,
        previewToken: token(actor, request, customer, inventory, env),
        inventory,
        retained: RETAINED,
        kind: request.kind,
        policy: PRIVACY_POLICY,
      };
    if (f.previewToken !== token(actor, request, customer, inventory, env))
      throw conflict(
        'PRIVACY_PREVIEW_CHANGED',
        'Account or retention scope changed. Preview again before approval.',
      );
    const [exists] = await tx`SELECT request_id FROM privacy_job WHERE request_id=${id}`;
    if (exists) throw conflict('JOB_EXISTS');
    const [profile] =
      await tx`SELECT photo_public_id FROM customer_profile WHERE user_id=${customer.id}`;
    await tx`INSERT INTO privacy_job(request_id,photo_key) VALUES (${id},${request.kind === 'deletion' ? (profile?.photo_public_id ?? null) : null})`;
    if (request.kind === 'deletion') {
      await tx`UPDATE "user" SET account_status='blocked',privacy_erasure_pending=true,lifecycle_version=lifecycle_version+1,updated_at=now() WHERE id=${customer.id}`;
      await tx`UPDATE customer_session SET revoked_at=now() WHERE user_id=${customer.id} AND revoked_at IS NULL`;
      await tx`UPDATE customer_profile SET marketing_consent=false,consent_updated_at=now(),version=version+1,updated_at=now() WHERE user_id=${customer.id}`;
      await tx`UPDATE privacy_job SET artifact_ciphertext=NULL,expires_at=now() WHERE request_id IN (SELECT id FROM customer_privacy_request WHERE customer_id=${customer.id})`;
    }
    await tx`UPDATE customer_privacy_request SET version=version+1,updated_at=now() WHERE id=${id}`;
    await audit(
      tx,
      actor,
      id,
      'privacy_job_approved',
      {
        kind: request.kind,
        policy: PRIVACY_POLICY,
      },
      f.reason,
    );
    return { ok: true };
  });
}

// Explicit projections and ownership joins: never export authentication/provider secrets,
// internal messages, other participants' identifiers, shared KYC or storage keys.
async function exportSnapshot(tx, customer) {
  const id = customer.id,
    limit = 5001;
  const sections = {};
  sections.bookings =
    await tx`SELECT id,reference,state,day,slot,starts_at,ends_at,guests,contact_phone,note,amount_rent,amount_fee,amount_deposit,cancellation_reason FROM booking WHERE customer_id=${id} ORDER BY created_at,id LIMIT ${limit}`;
  sections.orders =
    await tx`SELECT id,reference,state,currency,amount_rent_minor,amount_fee_minor,amount_deposit_minor,collected_minor,created_at FROM booking_order WHERE customer_id=${id} ORDER BY created_at,id LIMIT ${limit}`;
  sections.payments =
    await tx`SELECT p.id,p.environment,p.currency,p.expected_minor,p.state,p.created_at FROM payment_order p JOIN booking_order o ON o.id=p.booking_order_id WHERE o.customer_id=${id} ORDER BY p.created_at,p.id LIMIT ${limit}`;
  sections.transactions =
    await tx`SELECT t.id,t.environment,t.currency,t.kind,t.outcome,t.captured_minor,t.simulated_minor,t.created_at FROM payment_transaction t JOIN payment_attempt a ON a.id=t.attempt_id JOIN payment_order p ON p.id=a.payment_order_id JOIN booking_order o ON o.id=p.booking_order_id WHERE o.customer_id=${id} ORDER BY t.created_at,t.id LIMIT ${limit}`;
  sections.refunds =
    await tx`SELECT r.id,r.reference,r.environment,r.currency,r.state,r.expected_minor,r.actual_minor,r.created_at,r.completed_at FROM refund r JOIN payment_transaction t ON t.id=r.transaction_id JOIN payment_attempt a ON a.id=t.attempt_id JOIN payment_order p ON p.id=a.payment_order_id JOIN booking_order o ON o.id=p.booking_order_id WHERE o.customer_id=${id} ORDER BY r.created_at,r.id LIMIT ${limit}`;
  sections.methods =
    await tx`SELECT provider,environment,display_label,last4,is_active,consented_at,revoked_at FROM customer_payment_method WHERE customer_id=${id} LIMIT ${limit}`;
  sections.favourites =
    await tx`SELECT rentable_id,active,saved_at FROM customer_favourite WHERE customer_id=${id} LIMIT ${limit}`;
  sections.reviews =
    await tx`SELECT id,rating,body,moderation_state,created_at FROM review WHERE author_id=${id} LIMIT ${limit}`;
  sections.support =
    await tx`SELECT id,category,subject,state,created_at FROM support_request WHERE customer_id=${id} LIMIT ${limit}`;
  sections.messages =
    await tx`SELECT m.request_id,m.actor_kind,m.body,m.created_at FROM support_message m JOIN support_request r ON r.id=m.request_id WHERE r.customer_id=${id} AND NOT m.internal ORDER BY m.created_at,m.id LIMIT ${limit}`;
  sections.attachments =
    await tx`SELECT a.id,a.message_id,a.mime_type,a.bytes,a.created_at FROM support_attachment a JOIN support_message m ON m.id=a.message_id JOIN support_request r ON r.id=m.request_id WHERE r.customer_id=${id} AND NOT m.internal LIMIT ${limit}`;
  sections.disputes =
    await tx`SELECT id,kind,state,created_at,resolved_at FROM dispute_case WHERE customer_id=${id} LIMIT ${limit}`;
  sections.disputeMessages =
    await tx`SELECT m.case_id,m.actor_kind,m.body,m.created_at FROM dispute_message m JOIN dispute_case c ON c.id=m.case_id WHERE c.customer_id=${id} AND m.audience IN ('customer','everyone') ORDER BY m.created_at,m.id LIMIT ${limit}`;
  sections.requests =
    await tx`SELECT id,kind,state,created_at,receipt FROM customer_privacy_request WHERE customer_id=${id} LIMIT ${limit}`;
  if (Object.values(sections).some((rows) => rows.length >= limit))
    throw conflict(
      'EXPORT_REVIEW_REQUIRED',
      'This account exceeds the automatic export scope. Arrange a separately reviewed copy.',
    );
  const [profile] =
    await tx`SELECT marketing_consent,consent_updated_at,completed_at FROM customer_profile WHERE user_id=${id}`;
  return {
    format: 'rentra-customer-data-v1',
    generatedAt: new Date().toISOString(),
    account: {
      id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      locale: customer.preferred_locale,
      createdAt: customer.created_at,
    },
    profile,
    ...sections,
    exclusions: [
      'Authentication codes, sessions, payment tokens, internal notes and other participants’ private identifiers are excluded.',
      'File metadata is included; binary files, shared KYC, raw provider events and backups require separate scoped review. Participant free text may require a redacted-copy follow-up.',
    ],
  };
}

export async function processPrivacyJob(db, id, options = {}) {
  const env = options.env ?? process.env;
  try {
    for (let i = 0; i < 5; i++) {
      const done = await db.begin(async (tx) => {
        const { customer, request } = await load(tx, id, true);
        const [job] = await tx`SELECT * FROM privacy_job WHERE request_id=${id} FOR UPDATE`;
        if (!job || ['completed', 'failed'].includes(job.state)) return true;
        // Account/request/job locks serialize workers; every stage is an atomic checkpoint.
        if (options.beforeStage) await options.beforeStage(job.stage);
        let result;
        if (request.kind === 'access') {
          if (customer.privacy_erasure_pending || customer.privacy_erased_at)
            throw conflict('ERASURE_SCOPE_CHANGED');
          if (job.stage === 0) {
            const snapshot = await exportSnapshot(tx, customer),
              bytes = Buffer.from(JSON.stringify(snapshot));
            if (bytes.length > 10 * 1024 * 1024) throw conflict('EXPORT_REVIEW_REQUIRED');
            await tx`UPDATE privacy_job SET artifact_ciphertext=${encrypt(bytes, id, env)},expires_at=clock_timestamp()+interval '24 hours' WHERE request_id=${id}`;
            result = {
              stage: 'snapshot',
              outcome: 'scoped_export_prepared',
              sections: Object.keys(snapshot),
              counts: Object.fromEntries(
                Object.entries(snapshot)
                  .filter(([, v]) => Array.isArray(v))
                  .map(([k, v]) => [k, v.length]),
              ),
            };
          }
        } else {
          if (!customer.privacy_erasure_pending && !(customer.privacy_erased_at && job.stage === 4))
            throw conflict('ERASURE_SCOPE_CHANGED');
          if (job.stage === 0) {
            const inventory = await privacyInventory(tx, customer.id);
            if (obligated(inventory)) throw conflict('ACTIVE_OBLIGATIONS');
            result = {
              stage: 'retention',
              outcome: 'retained_business_evidence',
              inventory,
              retained: RETAINED,
            };
          } else if (job.stage === 1) {
            if (
              job.photo_key &&
              !(await (options.destroyPhoto ?? destroyProfilePhoto)(job.photo_key))
            )
              throw unavailable('PHOTO_REMOVAL_FAILED');
            await tx`UPDATE customer_profile SET photo_public_id=NULL,version=version+1,updated_at=now() WHERE user_id=${customer.id}`;
            await tx`UPDATE privacy_job SET photo_key=NULL WHERE request_id=${id}`;
            result = {
              stage: 'photo',
              outcome: job.photo_key ? 'profile_photo_removed' : 'no_profile_photo',
            };
          } else if (job.stage === 2) {
            const removed =
              await tx`DELETE FROM customer_favourite WHERE customer_id=${customer.id} RETURNING rentable_id`;
            await tx`DELETE FROM customer_favourite_merge WHERE customer_id=${customer.id}`;
            await tx`UPDATE customer_profile SET marketing_consent=false,version=version+1,updated_at=now() WHERE user_id=${customer.id}`;
            const methods =
              await tx`UPDATE customer_payment_method SET is_active=false,is_default=false,revoked_at=coalesce(revoked_at,now()) WHERE customer_id=${customer.id} AND is_active RETURNING id`;
            await tx`UPDATE customer_otp_challenge SET consumed_at=now() WHERE customer_id=${customer.id} AND consumed_at IS NULL`;
            result = {
              stage: 'preferences',
              outcome: 'transient_preferences_removed',
              favourites: removed.length,
              disabledPaymentMethods: methods.length,
              providerErasure: false,
            };
          } else if (job.stage === 3) {
            await tx`UPDATE "user" SET name=NULL,email=NULL,phone=NULL,email_verified_at=NULL,phone_verified_at=NULL,preferred_locale='en',person_id=NULL,privacy_erased_at=now(),privacy_erasure_pending=false,lifecycle_version=lifecycle_version+1,updated_at=now() WHERE id=${customer.id}`;
            result = {
              stage: 'account',
              outcome: 'live_profile_identifiers_removed_account_disabled',
              removedFields: [
                'name',
                'email',
                'phone',
                'verification timestamps',
                'person link',
                'locale preference',
              ],
              retainedIdentifier: 'account UUID',
            };
          }
        }
        const last = request.kind === 'access' ? 1 : 4;
        if (job.stage === last) {
          const receipt = {
            requestId: id,
            policy: request.review.policy,
            kind: request.kind,
            outcome:
              request.kind === 'access' ? 'scoped_export_ready' : 'partial_anonymization_complete',
            completedAt: new Date().toISOString(),
            stages: job.results,
            retained: request.kind === 'deletion' ? RETAINED : [],
            downloadExpiresAt: request.kind === 'access' ? job.expires_at : null,
            fullDeletion: false,
            retentionReviewDueAt:
              request.kind === 'deletion'
                ? new Date(Date.now() + 90 * 86400000).toISOString()
                : null,
            outstanding:
              request.kind === 'deletion'
                ? [
                    'Historical identifying fields and review-body PII disposal',
                    'Shared KYC review',
                    'Provider detachment and local token disposal',
                    'Backup/object-version expiry verification',
                    'Record-specific legal holds and disposal deadlines',
                  ]
                : ['Binary files and excluded classes require separately reviewed copies'],
            limitations:
              request.kind === 'deletion'
                ? 'Live account cleanup is complete. Historical evidence and identifying fields remain; external/retention actions are outstanding. This is not full erasure.'
                : 'Scoped copy with explicit exclusions; not a copy of every stored record.',
          };
          await tx`UPDATE customer_privacy_request SET receipt=${JSON.stringify(receipt)}::text::jsonb,state='closed',version=version+1,updated_at=now() WHERE id=${id}`;
          await tx`UPDATE privacy_job SET state='completed',updated_at=now() WHERE request_id=${id}`;
          await audit(tx, { kind: 'system' }, id, 'privacy_job_completed', {
            outcome: receipt.outcome,
          });
          return true;
        }
        await tx`UPDATE privacy_job SET state='running',stage=stage+1,attempts=attempts+1,results=${JSON.stringify([...job.results, result])}::text::jsonb,updated_at=now() WHERE request_id=${id}`;
        await tx`UPDATE customer_privacy_request SET version=version+1,updated_at=now() WHERE id=${id}`;
        return false;
      });
      if (done) return true;
    }
    return true;
  } catch (error) {
    await db.begin(async (tx) => {
      // Preserve account-first ordering, even on failure, against an operator retry.
      await load(tx, id, true);
      const [job] =
        await tx`UPDATE privacy_job SET state='failed',error_code=${['ACTIVE_OBLIGATIONS', 'PHOTO_REMOVAL_FAILED', 'PRIVACY_KEY_UNAVAILABLE', 'ERASURE_SCOPE_CHANGED', 'EXPORT_REVIEW_REQUIRED'].includes(error.code) ? error.code : 'STAGE_FAILED'},attempts=attempts+1,updated_at=now() WHERE request_id=${id} AND state IN ('queued','running') RETURNING request_id`;
      if (job) {
        await tx`UPDATE customer_privacy_request SET version=version+1,updated_at=now() WHERE id=${id}`;
        await audit(tx, { kind: 'system' }, id, 'privacy_job_failed');
      }
    });
    return false;
  }
}
export async function runPrivacyJobs(db, options = {}) {
  await db`UPDATE privacy_job SET artifact_ciphertext=NULL WHERE artifact_ciphertext IS NOT NULL AND expires_at<=clock_timestamp()`;
  const rows =
    await db`SELECT request_id FROM privacy_job WHERE state IN ('queued','running') ORDER BY updated_at,request_id LIMIT 10`;
  for (const r of rows) await processPrivacyJob(db, r.request_id, options);
  return rows.length;
}
export async function privacyDownload(db, actor, id, receipt = false, env = process.env) {
  if (!uuid.safeParse(id).success) throw notFound();
  return db.begin(async (tx) => {
    if (actor?.kind === 'admin') await admin(tx, actor);
    else if (actor?.kind === 'customer') {
      const customer = await lockCustomerAccount(tx, actor.session, env);
      const [owned] =
        await tx`SELECT id FROM customer_privacy_request WHERE id=${id} AND customer_id=${customer.id}`;
      if (!owned) throw notFound();
      actor = { kind: 'customer', id: customer.id };
    } else throw forbidden();
    const { request } = await load(tx, id, true);
    const [job] =
      await tx`SELECT state,artifact_ciphertext,expires_at,expires_at>clock_timestamp() live FROM privacy_job WHERE request_id=${id} FOR UPDATE`;
    if (!job || job.state !== 'completed' || !request.receipt) throw conflict('ARTIFACT_NOT_READY');
    let bytes;
    if (receipt) bytes = Buffer.from(JSON.stringify(request.receipt, null, 2));
    else {
      if (!job.live || !job.artifact_ciphertext)
        throw conflict(
          'EXPORT_EXPIRED',
          'This copy expired or was revoked. Open a new access request.',
        );
      bytes = decrypt(job.artifact_ciphertext, id, env);
    }
    await audit(
      tx,
      actor,
      id,
      receipt ? 'privacy_receipt_downloaded' : 'privacy_export_downloaded',
    );
    return bytes;
  });
}
