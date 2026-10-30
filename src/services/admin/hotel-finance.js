import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { conflict, forbidden, notFound, unprocessable } from '@/utils/apiError.js';
import { applyBasisPoints } from '../domain/booking-money.js';

/**
 * Hotel commission rules and tax slabs for administrators (hotel plan, Phase 4).
 * Finance permissions (`admin.payments.read|write`). Writes are two-step like the
 * catalogue: a preview returns a hash the save must echo, a reason is required,
 * and every change is audited. Rules and slabs are never edited in place: a rule
 * is ended and a new one added, so payouts can always be explained afterwards.
 */
const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date (YYYY-MM-DD).');
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = (error) => {
  const out = {};
  for (const issue of error.issues) (out[issue.path.join('.') || '_'] ??= []).push(issue.message);
  return out;
};
const dayKey = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);
const todayIst = (tx) => tx`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS today`.then(([r]) => r.today);
/** Example night used in previews: ₹3,000 room night. */
const EXAMPLE_MINOR = 300000;

async function authorize(tx, actor, write = false) {
  if (actor?.kind !== 'admin' || !uuid.safeParse(actor.id).success) throw forbidden();
  const [row] = await tx`SELECT permissions FROM admin_user WHERE id=${actor.id} AND is_active FOR SHARE`;
  const allowed = (action) => row && (row.permissions == null || row.permissions.includes(`admin.payments.${action}`));
  if (!allowed(write ? 'write' : 'read')) throw forbidden();
  return Boolean(allowed('write'));
}

const audit = (tx, actor, entityId, action, after, reason) =>
  tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"after",reason)
    VALUES ('admin',${actor.id},'hotel.finance',${entityId},${action},${JSON.stringify(after)}::text::jsonb,${reason})`;

/* ------------------------------------------------------------------ commission */

const ruleState = (row, today) => (dayKey(row.valid_from) > today ? 'scheduled' : row.valid_to && dayKey(row.valid_to) < today ? 'ended' : 'active');

export async function listCommissionRules(database, actor) {
  return database.begin(async (tx) => {
    const canWrite = await authorize(tx, actor);
    const today = await todayIst(tx);
    const rows = await tx`SELECT cr.*, c.name AS city_name, r.title AS hotel_title, a.email AS created_by_email,
        (SELECT count(*)::int FROM rentable h JOIN category hc ON hc.id=h.category_id
          WHERE hc.vertical_code='hotel' AND h.rental_unit::text='night' AND h.status IN ('live','paused','pending_review','pending_verification')
            AND (cr.rentable_id IS NULL OR h.id=cr.rentable_id) AND (cr.city_id IS NULL OR h.city_id=cr.city_id)) AS hotels
      FROM commission_rule cr LEFT JOIN city c ON c.id=cr.city_id LEFT JOIN rentable r ON r.id=cr.rentable_id
      LEFT JOIN admin_user a ON a.id=cr.created_by
      WHERE cr.vertical_code='hotel' ORDER BY cr.valid_from DESC, cr.created_at DESC`;
    const [cities, hotels] = await Promise.all([
      tx`SELECT id, name FROM city WHERE is_active ORDER BY name`,
      tx`SELECT r.id, r.title, c.name AS city FROM rentable r JOIN category k ON k.id=r.category_id LEFT JOIN city c ON c.id=r.city_id
        WHERE k.vertical_code='hotel' AND r.rental_unit::text='night' AND r.status<>'draft' ORDER BY r.title LIMIT 500`,
    ]);
    return {
      canWrite,
      today,
      items: rows.map((row) => ({
        id: row.id, scope: row.rentable_id ? 'property' : row.city_id ? 'city' : 'vertical',
        target: row.hotel_title ?? row.city_name ?? 'All hotels', rateBps: row.rate_bps, tier: row.tier,
        validFrom: dayKey(row.valid_from), validTo: dayKey(row.valid_to), reason: row.reason, hotels: row.hotels,
        createdBy: row.created_by_email, createdAt: row.created_at, state: ruleState(row, today),
      })),
      cities,
      hotels,
    };
  });
}

const percent = z.coerce.number().min(0, 'Use 0–30%').max(30, 'Use 0–30%').refine((v) => Number.isInteger(Math.round(v * 100)) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, 'Use at most two decimals');
const createRule = z.object({
  action: z.literal('create'),
  scope: z.enum(['vertical', 'city', 'property']),
  cityId: uuid.optional().or(z.literal('')),
  rentableId: uuid.optional().or(z.literal('')),
  ratePercent: percent,
  tier: z.enum(['standard', 'founding', 'preferred', 'chain']),
  validFrom: date,
  validTo: date.optional().or(z.literal('')),
  reason: z.string().trim().min(10, 'Say why, in at least 10 characters.').max(500),
  preview: z.preprocess((v) => v === true || v === 'true' || v === '1' || v === 'on', z.boolean()).default(false),
  previewHash: z.string().length(64).optional(),
}).superRefine((value, ctx) => {
  if (value.scope === 'city' && !value.cityId) ctx.addIssue({ code: 'custom', path: ['cityId'], message: 'Choose a city.' });
  if (value.scope === 'property' && !value.rentableId) ctx.addIssue({ code: 'custom', path: ['rentableId'], message: 'Choose a hotel.' });
  if (value.validTo && value.validTo < value.validFrom) ctx.addIssue({ code: 'custom', path: ['validTo'], message: 'The end is before the start.' });
});
const endRule = z.object({
  action: z.literal('end'),
  id: uuid,
  validTo: date,
  reason: z.string().trim().min(10, 'Say why, in at least 10 characters.').max(500),
  preview: z.preprocess((v) => v === true || v === 'true' || v === '1' || v === 'on', z.boolean()).default(false),
  previewHash: z.string().length(64).optional(),
});

/** Create (from a date, never in the past) or end a rule. Bookings already made keep the rule they were made under. */
export async function commissionCommand(database, actor, input) {
  const parsed = z.discriminatedUnion('action', [createRule, endRule]).safeParse(input);
  if (!parsed.success) throw unprocessable(fields(parsed.error));
  const value = parsed.data;
  // Story 2.2: hotel commission is replaced by the guest-paid service fee. Existing rules stay
  // as history for stays booked under them and may still be ended; no new rule may start.
  if (value.action !== 'end')
    throw conflict('COMMISSION_RETIRED', 'Hotel commission is replaced by the Rentra service fee. Set fees under Finance → Service fee.');
  return database.begin(async (tx) => {
    await authorize(tx, actor, true);
    const today = await todayIst(tx);
    if (value.action === 'end') {
      const [rule] = await tx`SELECT * FROM commission_rule WHERE id=${value.id} AND vertical_code='hotel' FOR UPDATE`;
      if (!rule) throw notFound();
      if (value.validTo < today) throw unprocessable({ validTo: ['A rule cannot end in the past.'] });
      if (value.validTo < dayKey(rule.valid_from)) throw unprocessable({ validTo: ['The end is before the rule starts.'] });
      const summary = { action: 'end', id: rule.id, before: dayKey(rule.valid_to), after: value.validTo, reason: value.reason };
      const previewHash = hash(summary);
      if (value.preview) return { preview: true, previewHash, effect: `The rule stops applying after ${value.validTo}. Bookings already made keep it.` };
      if (value.previewHash !== previewHash) throw conflict('STALE_PREVIEW', 'Preview again before saving.');
      await tx`UPDATE commission_rule SET valid_to=${value.validTo} WHERE id=${rule.id}`;
      await audit(tx, actor, rule.id, 'commission.end', summary, value.reason);
      return { ok: true, id: rule.id };
    }
    if (value.validFrom < today) throw unprocessable({ validFrom: ['A rule cannot start in the past.'] });
    const cityId = value.scope === 'city' ? value.cityId : null;
    const rentableId = value.scope === 'property' ? value.rentableId : null;
    let scopeCity = cityId;
    if (rentableId) {
      const [hotel] = await tx`SELECT r.id, r.city_id FROM rentable r JOIN category c ON c.id=r.category_id WHERE r.id=${rentableId} AND c.vertical_code='hotel' AND r.rental_unit::text='night'`;
      if (!hotel) throw unprocessable({ rentableId: ['Choose a hotel.'] });
      scopeCity = hotel.city_id;
    }
    if (cityId && !(await tx`SELECT 1 FROM city WHERE id=${cityId}`).length) throw unprocessable({ cityId: ['Choose a city.'] });
    const rateBps = Math.round(value.ratePercent * 100);
    // What the most specific rule would be on the start date without this one, for the preview.
    const [replaced] = rentableId || cityId
      ? await tx`SELECT cr.rate_bps, cr.rentable_id, cr.city_id FROM commission_rule cr WHERE cr.vertical_code='hotel'
          AND ${value.validFrom}::date BETWEEN cr.valid_from AND COALESCE(cr.valid_to,'infinity'::date)
          AND (cr.rentable_id = ${rentableId} OR (cr.rentable_id IS NULL AND (cr.city_id = ${scopeCity} OR cr.city_id IS NULL)))
          ORDER BY (cr.rentable_id IS NOT NULL) DESC, (cr.city_id IS NOT NULL) DESC LIMIT 1`
      : await tx`SELECT rate_bps FROM commission_rule WHERE vertical_code='hotel' AND rentable_id IS NULL AND city_id IS NULL
          AND ${value.validFrom}::date BETWEEN valid_from AND COALESCE(valid_to,'infinity'::date) LIMIT 1`;
    const commissionMinor = applyBasisPoints(EXAMPLE_MINOR, rateBps);
    const summary = { action: 'create', scope: value.scope, cityId, rentableId, rateBps, tier: value.tier, validFrom: value.validFrom, validTo: value.validTo || null, reason: value.reason };
    const previewHash = hash(summary);
    const effect = `${replaced ? `Replaces ${replaced.rate_bps / 100}% for this scope from ${value.validFrom}. ` : ''}On a ₹3,000 room night the hotel pays ₹${commissionMinor / 100} commission + ₹${applyBasisPoints(commissionMinor, 1800) / 100} GST. Bookings made before ${value.validFrom} keep their rate.`;
    if (value.preview) return { preview: true, previewHash, effect, replacedBps: replaced?.rate_bps ?? null };
    if (value.previewHash !== previewHash) throw conflict('STALE_PREVIEW', 'The rule or its impact changed. Preview again before saving.');
    try {
      const [rule] = await tx`INSERT INTO commission_rule(vertical_code,city_id,rentable_id,rate_bps,tier,valid_from,valid_to,reason,created_by)
        VALUES ('hotel',${cityId},${rentableId},${rateBps},${value.tier},${value.validFrom},${value.validTo || null},${value.reason},${actor.id}) RETURNING id`;
      await audit(tx, actor, rule.id, 'commission.create', summary, value.reason);
      return { ok: true, id: rule.id };
    } catch (error) {
      if (error.code === '23P01') throw conflict('RULE_OVERLAP', 'Another rule already covers these dates for the same hotels. End that rule first.');
      throw error;
    }
  });
}

/* ------------------------------------------------------------------ tax slabs */

export async function listTaxSlabs(database, actor) {
  return database.begin(async (tx) => {
    const canWrite = await authorize(tx, actor);
    const today = await todayIst(tx);
    const rows = await tx`SELECT * FROM tax_slab WHERE vertical_code='hotel' ORDER BY effective_from DESC, min_rate_minor`;
    return {
      canWrite,
      today,
      items: rows.map((row) => ({
        id: row.id, fromMinor: Number(row.min_rate_minor), toMinor: row.max_rate_minor == null ? null : Number(row.max_rate_minor),
        taxBps: row.tax_bps, effectiveFrom: dayKey(row.effective_from), effectiveTo: dayKey(row.effective_to), note: row.note,
        state: ruleState({ valid_from: row.effective_from, valid_to: row.effective_to }, today),
      })),
    };
  });
}

const replaceSlabs = z.object({
  effectiveFrom: date,
  // Bands in order: each up to a tariff in whole rupees (inclusive); the last has no upper limit.
  bands: z.array(z.object({
    upTo: z.union([z.literal(''), z.null(), z.coerce.number().int().min(1).max(10_000_000)]).transform((v) => (v === '' ? null : v)),
    taxPercent: z.coerce.number().min(0).max(28),
  })).min(1).max(6),
  reason: z.string().trim().min(10, 'Say why, in at least 10 characters (e.g. the notification number).').max(500),
  preview: z.preprocess((v) => v === true || v === 'true' || v === '1' || v === 'on', z.boolean()).default(false),
  previewHash: z.string().length(64).optional(),
}).superRefine((value, ctx) => {
  value.bands.forEach((band, index) => {
    const last = index === value.bands.length - 1;
    if (last !== (band.upTo == null)) ctx.addIssue({ code: 'custom', path: ['bands', index, 'upTo'], message: last ? 'The last band has no upper limit.' : 'Give an upper limit.' });
    if (index > 0 && band.upTo != null && value.bands[index - 1].upTo != null && band.upTo <= value.bands[index - 1].upTo) {
      ctx.addIssue({ code: 'custom', path: ['bands', index, 'upTo'], message: 'Limits must go up.' });
    }
  });
});

/**
 * Replace every hotel slab from a date: today's slabs end the day before, the new
 * bands start that day. Quotes already given and bookings already made keep their tax.
 */
export async function replaceTaxSlabs(database, actor, input) {
  // Forms send the bands as one JSON field.
  let bands = input?.bands;
  if (typeof bands === 'string') {
    try { bands = JSON.parse(bands); } catch { throw unprocessable({ bands: ['Send the bands as JSON.'] }); }
  }
  const parsed = replaceSlabs.safeParse({ ...input, bands });
  if (!parsed.success) throw unprocessable(fields(parsed.error));
  const value = parsed.data;
  return database.begin(async (tx) => {
    await authorize(tx, actor, true);
    const today = await todayIst(tx);
    if (value.effectiveFrom <= today) throw unprocessable({ effectiveFrom: ['Start from tomorrow or later, so no live quote changes under a guest.'] });
    await tx`LOCK TABLE tax_slab IN SHARE ROW EXCLUSIVE MODE`;
    if ((await tx`SELECT 1 FROM tax_slab WHERE vertical_code='hotel' AND effective_from >= ${value.effectiveFrom}`).length) {
      throw conflict('SLABS_SCHEDULED', 'Slabs are already scheduled from this date or later.');
    }
    const rows = value.bands.map((band, index) => ({
      min_rate_minor: index === 0 ? 0 : value.bands[index - 1].upTo * 100 + 1,
      max_rate_minor: band.upTo == null ? null : band.upTo * 100,
      tax_bps: Math.round(band.taxPercent * 100),
    }));
    const examples = [200000, 750000, 750100, 1200000].map((rate) => {
      const band = rows.find((r) => rate >= r.min_rate_minor && (r.max_rate_minor == null || rate <= r.max_rate_minor));
      return `₹${(rate / 100).toLocaleString('en-IN')}: ${band.tax_bps / 100}%`;
    });
    const summary = { effectiveFrom: value.effectiveFrom, rows, reason: value.reason };
    const previewHash = hash(summary);
    if (value.preview) return { preview: true, previewHash, effect: `From ${value.effectiveFrom}, per room per night — ${examples.join(' · ')}.` };
    if (value.previewHash !== previewHash) throw conflict('STALE_PREVIEW', 'Preview again before saving.');
    await tx`UPDATE tax_slab SET effective_to = ${value.effectiveFrom}::date - 1
      WHERE vertical_code='hotel' AND (effective_to IS NULL OR effective_to >= ${value.effectiveFrom})`;
    for (const row of rows) {
      await tx`INSERT INTO tax_slab(vertical_code,min_rate_minor,max_rate_minor,tax_bps,effective_from,note)
        VALUES ('hotel',${row.min_rate_minor},${row.max_rate_minor},${row.tax_bps},${value.effectiveFrom},${value.reason})`;
    }
    await audit(tx, actor, null, 'tax_slabs.replace', summary, value.reason);
    return { ok: true };
  });
}
