import 'server-only';
import { z } from 'zod';
import { quoteDigest } from '../booking/quotes.js';
import { payoutSchema, destinationPayoutSchema } from '../schemas/zod/application.js';
import { recentAuthentication, RECENT_AUTH_MINUTES } from '../auth/recent-auth.js';
import {
  STATE_LABELS,
  VERIFICATION_AVAILABLE,
  maskedDestination,
  nameCheck,
  payoutReadiness,
} from '../domain/payout-destinations.js';

/**
 * CP21 versioned payout destinations. Each change appends a version; earlier
 * versions stay as history and pinned payouts keep theirs. The full bank
 * account number is validated and then discarded — only the last four digits
 * are stored. Approved clients need a recent sign-in to submit a change.
 */
export class DestinationError extends Error {
  constructor(code, message = code, { status = 400, fields = null } = {}) {
    super(message);
    this.name = 'DestinationError';
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

const uuid = z.string().uuid();
const instant = (value) => (value ? new Date(value).toISOString() : null);
/** Open obligations: not yet paid or failed. */

function dto(row, viewer) {
  return {
    id: row.id,
    version: row.version,
    method: row.method,
    masked: maskedDestination(row),
    holderName: row.holder_name,
    nameCheck: row.name_check,
    state: row.state,
    stateLabel: STATE_LABELS[row.state],
    source: row.source,
    submittedAt: instant(row.submitted_at),
    decidedAt: instant(row.decided_at),
    failureReason: row.failure_reason,
    verifiedAt: instant(row.verified_at),
    createdAt: instant(row.created_at),
    ...(viewer === 'admin' ? { decidedBy: row.decided_by_name ?? null, pinnedPayouts: row.pinned ?? 0 } : {}),
  };
}

async function versions(tx, clientId) {
  return tx`SELECT d.*,a.name decided_by_name,
      (SELECT count(*)::int FROM payout p WHERE p.destination_id=d.id AND p.status IN ('pending','processing','frozen')) pinned
    FROM payout_destination d LEFT JOIN admin_user a ON a.id=d.decided_by WHERE d.client_id=${clientId} ORDER BY d.version DESC`;
}

function summary(rows, viewer) {
  const history = rows.map((row) => dto(row, viewer));
  const current = history.find((d) => ['submitted', 'verified'].includes(d.state)) ?? null;
  const failed = !current && history.find((d) => d.state === 'failed') ? history.find((d) => d.state === 'failed') : null;
  return {
    current,
    draft: history.find((d) => d.state === 'draft') ?? null,
    latestVersion: rows[0]?.version ?? 0,
    history,
    readiness: payoutReadiness(current ?? failed),
    verificationAvailable: VERIFICATION_AVAILABLE,
  };
}

async function lockClient(tx, clientId) {
  const [client] = await tx`SELECT u.id,u.name,u.account_status,a.kyc_name_on_doc FROM "user" u
    LEFT JOIN client_application a ON a.user_id=u.id WHERE u.id=${clientId} AND u.role='client' FOR UPDATE OF u`;
  if (!client || !['active', 'pending_application'].includes(client.account_status)) {
    throw new DestinationError('CLIENT_UNAVAILABLE', 'Your account cannot change payout details right now.', { status: 403 });
  }
  return client;
}

/** Gate 1 review fingerprints read client_application.updated_at; a new destination moves it. */
async function touchApplication(tx, clientId) {
  await tx`UPDATE client_application SET updated_at=now() WHERE user_id=${clientId}`;
}

async function supersede(tx, clientId, states) {
  // The row CHECK ties "no submitted_at" to the draft state, so a replaced draft
  // records when it was set aside.
  await tx`UPDATE payout_destination SET state='superseded',submitted_at=coalesce(submitted_at,now()),updated_at=now()
    WHERE client_id=${clientId} AND state = ANY(${states}::text[])`;
}

async function audit(tx, actorType, actorId, entityId, action, after, before = null) {
  await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after")
    VALUES(${actorType},${actorId},'payout_destination',${entityId},${action},
    ${before ? JSON.stringify(before) : null}::text::jsonb,${JSON.stringify(after)}::text::jsonb)`;
}

/** Validate the declared details; the full account number never leaves this function. */
function declared(input, confirm = false) {
  const parsed = (confirm ? destinationPayoutSchema : payoutSchema).safeParse({
    method: input.method,
    upiId: input.upiId ?? '',
    accountNumber: input.accountNumber ?? '',
    confirmAccountNumber: input.confirmAccountNumber ?? '',
    ifsc: input.ifsc ?? '',
    holderName: input.holderName,
  });
  if (!parsed.success) {
    const fields = Object.fromEntries(parsed.error.issues.map((i) => [i.path[0] ?? '_', i.message]));
    throw new DestinationError('INVALID_DESTINATION', 'Check the highlighted fields.', { status: 422, fields });
  }
  const d = parsed.data;
  return {
    method: d.method,
    holder_name: d.holderName.trim(),
    account_last4: d.method === 'bank' ? d.accountNumber.slice(-4) : null,
    ifsc: d.method === 'bank' ? d.ifsc : null,
    upi_id: d.method === 'upi' ? d.upiId : null,
  };
}

async function insertVersion(tx, client, d, { state, source, requestKey, hash }) {
  const [{ next }] = await tx`SELECT coalesce(max(version),0)+1 next FROM payout_destination WHERE client_id=${client.id}`;
  const check = nameCheck(client.kyc_name_on_doc ?? client.name, d.holder_name);
  const [row] = await tx`INSERT INTO payout_destination(client_id,version,method,holder_name,account_last4,ifsc,upi_id,name_check,state,source,submitted_at,request_key,request_hash)
    VALUES(${client.id},${next},${d.method},${d.holder_name},${d.account_last4},${d.ifsc},${d.upi_id},${check},${state},${source},
    ${state === 'submitted' ? tx`now()` : null},${requestKey},${hash}) RETURNING *`;
  return row;
}

/* --------------------------------- owner --------------------------------- */

export async function clientDestinationPage(database, actor) {
  if (actor?.kind !== 'owner' || !uuid.safeParse(actor.id).success) throw new DestinationError('CLIENT_UNAVAILABLE', 'Not available', { status: 403 });
  return database.begin(async (tx) => {
    const rows = await versions(tx, actor.id);
    const auth = await recentAuthentication(tx, { kind: 'client', principalId: actor.id, sessionId: actor.sessionId });
    const [client] = await tx`SELECT account_status FROM "user" WHERE id=${actor.id}`;
    return {
      ...summary(rows, 'owner'),
      recentAuth: { ...auth, required: client?.account_status === 'active', minutes: RECENT_AUTH_MINUTES },
    };
  });
}

const changeSchema = z
  .object({ expectedLatest: z.number().int().min(0), mode: z.enum(['preview', 'submit']), requestKey: uuid })
  .passthrough();

export async function saveClientDestination(database, actor, input) {
  if (actor?.kind !== 'owner' || !uuid.safeParse(actor.id).success) throw new DestinationError('CLIENT_UNAVAILABLE', 'Not available', { status: 403 });
  const meta = changeSchema.parse(input);
  const d = declared(input, input.confirmAccountNumber !== undefined);
  const hash = quoteDigest({ ...d, expectedLatest: meta.expectedLatest });
  return database.begin(async (tx) => {
    const client = await lockClient(tx, actor.id);
    const [replay] = await tx`SELECT id,version,state,request_hash FROM payout_destination WHERE client_id=${client.id} AND request_key=${meta.requestKey}`;
    if (replay) {
      if (replay.request_hash !== hash) throw new DestinationError('IDEMPOTENCY_CONFLICT', 'This form was already sent with different details. Reload and try again.', { status: 409 });
      return { replayed: true, state: replay.state, version: replay.version, reauthRequired: replay.state === 'draft' };
    }
    const [{ latest }] = await tx`SELECT coalesce(max(version),0)::int latest FROM payout_destination WHERE client_id=${client.id}`;
    if (latest !== meta.expectedLatest) {
      throw new DestinationError('DESTINATION_CHANGED', 'Your payout details changed in another session. Reload to see the latest version.', { status: 409 });
    }
    const auth = await recentAuthentication(tx, { kind: 'client', principalId: client.id, sessionId: actor.sessionId });
    const needsFresh = client.account_status === 'active' && !auth.fresh;
    const [current] = await tx`SELECT * FROM payout_destination WHERE client_id=${client.id} AND state IN ('submitted','verified')`;
    const [{ pinned }] = current
      ? await tx`SELECT count(*)::int pinned FROM payout p WHERE p.destination_id=${current.id} AND p.status IN ('pending','processing','frozen')`
      : [{ pinned: 0 }];
    if (meta.mode === 'preview') {
      return {
        preview: {
          version: latest + 1,
          masked: maskedDestination(d),
          holderName: d.holder_name,
          nameCheck: nameCheck(client.kyc_name_on_doc ?? client.name, d.holder_name),
          replaces: current ? { version: current.version, masked: maskedDestination(current), state: current.state } : null,
          pinnedPayouts: pinned,
          needsRecentAuth: needsFresh,
          recentAuthMinutes: RECENT_AUTH_MINUTES,
          effect: pinned
            ? `${pinned} scheduled payout(s) stay pinned to version ${current.version}; only new payouts would use version ${latest + 1} after it is verified.`
            : `New payouts would use version ${latest + 1} after it is verified. Nothing is sent until then.`,
        },
      };
    }
    await supersede(tx, client.id, ['draft']);
    if (needsFresh) {
      const draft = await insertVersion(tx, client, d, { state: 'draft', source: 'settings', requestKey: meta.requestKey, hash });
      await audit(tx, 'client', client.id, draft.id, 'payout_destination_drafted', { version: draft.version, masked: maskedDestination(draft) });
      return { state: 'draft', version: draft.version, reauthRequired: true };
    }
    await supersede(tx, client.id, ['submitted', 'verified']);
    const row = await insertVersion(tx, client, d, { state: 'submitted', source: 'settings', requestKey: meta.requestKey, hash });
    await touchApplication(tx, client.id);
    await audit(tx, 'client', client.id, row.id, 'payout_destination_submitted', { version: row.version, masked: maskedDestination(row), nameCheck: row.name_check },
      current ? { version: current.version, masked: maskedDestination(current), state: current.state } : null);
    return { state: 'submitted', version: row.version, reauthRequired: false };
  });
}

const draftSchema = z.object({ draftId: uuid, expectedLatest: z.number().int().min(0) }).strict();

/** Submit a saved draft once the owner has signed in again. Repeats are harmless. */
export async function submitClientDraft(database, actor, input) {
  if (actor?.kind !== 'owner' || !uuid.safeParse(actor.id).success) throw new DestinationError('CLIENT_UNAVAILABLE', 'Not available', { status: 403 });
  const value = draftSchema.parse(input);
  return database.begin(async (tx) => {
    const client = await lockClient(tx, actor.id);
    const [draft] = await tx`SELECT * FROM payout_destination WHERE id=${value.draftId} AND client_id=${client.id}`;
    if (!draft) throw new DestinationError('DESTINATION_NOT_FOUND', 'Not found', { status: 404 });
    if (draft.state === 'submitted') return { replayed: true, state: 'submitted', version: draft.version };
    const [{ latest }] = await tx`SELECT coalesce(max(version),0)::int latest FROM payout_destination WHERE client_id=${client.id}`;
    if (draft.state !== 'draft' || latest !== value.expectedLatest) {
      throw new DestinationError('DESTINATION_CHANGED', 'Your payout details changed in another session. Reload to see the latest version.', { status: 409 });
    }
    const auth = await recentAuthentication(tx, { kind: 'client', principalId: client.id, sessionId: actor.sessionId });
    if (client.account_status === 'active' && !auth.fresh) {
      throw new DestinationError('REAUTH_REQUIRED', `Sign in again to confirm this change. Payout changes need a sign-in within the last ${RECENT_AUTH_MINUTES} minutes.`, { status: 403 });
    }
    const [current] = await tx`SELECT * FROM payout_destination WHERE client_id=${client.id} AND state IN ('submitted','verified')`;
    await supersede(tx, client.id, ['submitted', 'verified']);
    const [row] = await tx`UPDATE payout_destination SET state='submitted',submitted_at=now(),updated_at=now() WHERE id=${draft.id} RETURNING *`;
    await touchApplication(tx, client.id);
    await audit(tx, 'client', client.id, row.id, 'payout_destination_submitted', { version: row.version, masked: maskedDestination(row), nameCheck: row.name_check, fromDraft: true },
      current ? { version: current.version, masked: maskedDestination(current), state: current.state } : null);
    return { replayed: false, state: 'submitted', version: row.version };
  });
}

/** Onboarding (a pending application, reviewed at Gate 1) records a version too. */
export async function recordOnboardingDestination(database, clientId, input) {
  const d = declared(input);
  return database.begin(async (tx) => {
    const client = await lockClient(tx, clientId);
    await supersede(tx, client.id, ['draft', 'submitted', 'verified']);
    const row = await insertVersion(tx, client, d, { state: 'submitted', source: 'onboarding', requestKey: null, hash: null });
    await audit(tx, 'client', client.id, row.id, 'payout_destination_submitted', { version: row.version, masked: maskedDestination(row), source: 'onboarding' });
    return row;
  });
}

/* --------------------------------- admin --------------------------------- */

export async function adminClientDestinations(database, clientId) {
  return summary(await versions(database, clientId), 'admin');
}

const failSchema = z
  .object({ destinationId: uuid, expectedState: z.enum(['submitted', 'verified']), reason: z.string().trim().min(10).max(500), mode: z.enum(['preview', 'apply']), requestKey: uuid })
  .strict();

/**
 * Mark a destination failed: payouts pinned to it cannot be sent and the owner
 * is asked for a new destination. A high-impact change: recent sign-in, a
 * reason and an impact preview. There is deliberately no "mark verified".
 */
export async function failDestination(database, actor, input) {
  if (actor?.kind !== 'admin' || !uuid.safeParse(actor.id).success) throw new DestinationError('OPERATOR_REQUIRED', 'Operator required', { status: 403 });
  const value = failSchema.parse(input);
  return database.begin(async (tx) => {
    const [admin] = await tx`SELECT id FROM admin_user WHERE id=${actor.id} AND is_active=true FOR SHARE`;
    if (!admin) throw new DestinationError('OPERATOR_REQUIRED', 'Operator required', { status: 403 });
    const [previous] = await tx`SELECT after FROM audit_log WHERE entity='payout_destination' AND entity_id=${value.destinationId}
      AND action='payout_destination_failed' AND actor_id=${actor.id} AND after->>'requestKey'=${value.requestKey}`;
    if (previous) return { replayed: true, ...previous.after };
    const [d] = await tx`SELECT * FROM payout_destination WHERE id=${value.destinationId} FOR UPDATE`;
    if (!d) throw new DestinationError('DESTINATION_NOT_FOUND', 'Not found', { status: 404 });
    if (d.state !== value.expectedState) throw new DestinationError('DESTINATION_CHANGED', 'This destination changed. Reload to see its current state.', { status: 409 });
    const [impact] = await tx`SELECT count(*)::int count,coalesce(sum(net_minor)/100,0)::int net FROM payout WHERE destination_id=${d.id} AND status IN ('pending','processing','frozen')`;
    const auth = await recentAuthentication(tx, { kind: 'admin', principalId: actor.id, sessionId: actor.sessionId });
    const preview = {
      version: d.version,
      masked: maskedDestination(d),
      state: d.state,
      pinnedPayouts: impact.count,
      pinnedNetRupees: impact.net,
      needsRecentAuth: !auth.fresh,
      effect: `${impact.count} open payout(s) pinned to version ${d.version} cannot be sent. The owner is asked to submit a new destination; nothing is re-routed or refunded.`,
    };
    if (value.mode === 'preview') return { preview };
    if (!auth.fresh) {
      throw new DestinationError('REAUTH_REQUIRED', `Sign in again to change payout destination states (within the last ${RECENT_AUTH_MINUTES} minutes).`, { status: 403 });
    }
    await tx`UPDATE payout_destination SET state='failed',failure_reason=${value.reason},decided_at=now(),decided_by=${actor.id},updated_at=now() WHERE id=${d.id}`;
    const result = { requestKey: value.requestKey, version: d.version, state: 'failed', pinnedPayouts: impact.count };
    await audit(tx, 'admin', actor.id, d.id, 'payout_destination_failed', { ...result, reason: value.reason }, { state: d.state });
    // The owner's inbox carries the recovery path as required work.
    await tx`SELECT client_update_insert(${d.client_id},${'payout-destination-failed:' + d.id},'account','action','payout_destination_failed',NULL,NULL,
      ${JSON.stringify({ version: d.version })}::text::jsonb,now())`;
    return { replayed: false, ...result };
  });
}
