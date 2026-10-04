import {OWNER_GUIDE_GROUPS,ownerGuideArticles} from './owner-guide.js';
import 'server-only';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { badRequest, conflict, forbidden, notFound, unavailable } from '@/utils/apiError.js';
import { POLICY_VERSION, CURRENT_POLICY_VERSION, policyVersions, faqs, supportContact } from '../domain/help.js';
export const contentKinds = ['terms', 'privacy', 'cancellation', 'help', 'contact', 'owner_help'];
const policyKinds = ['terms', 'privacy', 'cancellation'];
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain = (max) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (v) => !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v),
      'Use plain text without HTML or control characters.',
    );
const optionalText = (max) => z.union([plain(max), z.literal('')]);
const link = z
  .string()
  .refine(
    (v) =>
      v === '' ||
      /^\/(?:help|bookings|support|account\/privacy|policies\/(?:terms|privacy|cancellation))(?:\/[a-f0-9-]+)?$/.test(
        v,
      ),
    'Choose a supported internal help, account, booking or policy link.',
  );
const schemas = {
  help: z
    .object({
      title: plain(120),
      intro: plain(500),
      faqs: z
        .array(
          z
            .object({
              question: plain(200),
              answer: plain(4000),
              href: link,
              link: optionalText(100),
            })
            .strict()
            .refine((v) => !v.href || Boolean(v.link), 'Add link text.'),
        )
        .min(1)
        .max(40),
    })
    .strict(),
  contact: z
    .object({
      title: plain(120),
      email: z.union([z.email().max(160), z.literal('')]),
      whatsapp: z.string().regex(/^(?:[0-9]{10,15})?$/),
      phone: z.string().regex(/^(?:\+?[0-9]{10,15})?$/).optional(),
      hours: optionalText(200),
      timeZone: z.literal('Asia/Kolkata'),
    })
    .strict(),
};
schemas.owner_help = z.object({title:plain(120),intro:plain(500),faqs:z.array(z.object({
 id:z.string().regex(/^[a-z][a-z0-9-]{1,60}$/),group:z.enum(OWNER_GUIDE_GROUPS),question:plain(200),answer:plain(4000),
 href:z.string().regex(/^\/partner(?:\/(?:onboarding\/(?:details|phone|kyc|payout|consent|review)|listings(?:\/new)?|calendar|bookings|earnings|team|reviews|support|settings(?:\/(?:security|notifications|privacy))?))?$/),link:plain(100),
 screenshot:z.enum(['','/help/owner/properties.png','/help/owner/pricing.png']).default('')
}).strict()).min(1).max(40).refine(rows=>new Set(rows.map(r=>r.id)).size===rows.length,'Article IDs must be unique.')}).strict();
const policySchema = z
  .object({
    title: plain(160),
    sections: z
      .array(z.tuple([plain(160), plain(8000)]))
      .min(1)
      .max(30),
  })
  .strict();
const parse = (schema, value) => {
  const r = schema.safeParse(value);
  if (!r.success)
    throw badRequest(
      'INVALID_CONTENT',
      r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  return r.data;
};
const validKind = (kind) => {
  if (!contentKinds.includes(kind)) throw notFound();
  return kind;
};
export function validateContent(kind, body) {
  validKind(kind);
  return parse(schemas[kind] || policySchema, body);
}
const versionSchema = z.union([z.enum(Object.keys(policyVersions)), z.string().regex(/^[a-f0-9]{32}$/)]);
function builtin(kind, version = POLICY_VERSION, env = process.env) {
  let body;
  if (policyKinds.includes(kind)) body = policyVersions[version]?.[kind];
  else if (version === POLICY_VERSION)
    body =
      kind === 'owner_help' ? {title:'Owner guide',intro:'Practical steps for getting verified and running your property.',faqs:ownerGuideArticles} : kind === 'help'
        ? {
            title: 'Help and support',
            intro: 'Practical answers for planning, booking and visiting.',
            faqs: faqs.map((f) => ({ ...f, href: f.href || '', link: f.link || '' })),
          }
        : {
            title: 'Contact Rentra',
            ...Object.fromEntries(
              Object.entries(supportContact(env)).map(([k, v]) => [k, v || '']),
            ),
            timeZone: 'Asia/Kolkata',
          };
  if (!body) throw notFound();
  return {
    kind,
    version,
    body,
    contentHash: digest(body),
    effectiveAt: version + 'T00:00:00.000Z',
    source: 'builtin',
  };
}
const publication = (row) => ({
  kind: row.kind,
  version: row.version,
  body: row.body,
  contentHash: row.content_hash,
  effectiveAt: new Date(row.effective_at).toISOString(),
  source: row.is_baseline ? 'baseline' : 'published',
});
export async function publicContent(database, kind, version = null, env = process.env) {
  validKind(kind);
  if (version && !versionSchema.safeParse(version).success) throw notFound();
  const [row] = version
    ? await database`SELECT * FROM content_publication WHERE kind=${kind} AND version=${version}`
    : await database`SELECT * FROM content_publication WHERE kind=${kind} AND effective_at<=clock_timestamp() ORDER BY effective_at DESC,id DESC LIMIT 1`;
  if (row) return publication(row);
  return builtin(kind, version || (policyKinds.includes(kind) ? CURRENT_POLICY_VERSION : POLICY_VERSION), env);
}
/** Serialize new acceptance against publication; callers retain this shared lock until commit. */
export async function currentPolicyReferences(tx) {
  await tx`SELECT pg_advisory_xact_lock_shared(73425,1)`;
  const references = {};
  for (const kind of policyKinds) {
    const p = await publicContent(tx, kind);
    references[kind] = {
      version: p.version,
      hash: p.contentHash,
      href: `/policies/${kind}/${p.version}`,
    };
  }
  return references;
}
async function authorize(tx, actor, write = false) {
  if (actor?.kind !== 'admin' || !z.string().uuid().safeParse(actor.id).success) throw forbidden();
  const [a] =
    await tx`SELECT permissions FROM admin_user WHERE id=${actor.id} AND is_active FOR SHARE`;
  const allowed = (action) =>
    a && (a.permissions == null || a.permissions.includes('admin.content.' + action));
  if (!allowed(write ? 'write' : 'read')) throw forbidden();
  return Boolean(allowed('write'));
}
export async function listContent(database, actor) {
  return database.begin(async (tx) => {
    const canWrite = await authorize(tx, actor),
      items = [];
    for (const kind of contentKinds) {
      const live = await publicContent(tx, kind),
        [draft] = await tx`SELECT version,state,updated_at FROM content_draft WHERE kind=${kind}`;
      items.push({
        kind,
        title: live.body.title,
        currentVersion: live.version,
        effectiveAt: live.effectiveAt,
        draft: draft || null,
      });
    }
    return { items, canWrite };
  });
}
export async function readContent(database, actor, kind, query = {}) {
  validKind(kind);
  const { historyPage } = parse(
    z.object({ historyPage: z.coerce.number().int().min(1).max(100000).default(1) }).strict(),
    query,
  );
  return database.begin(async (tx) => {
    const canWrite = await authorize(tx, actor),
      live = await publicContent(tx, kind);
    const [draft] = await tx`SELECT * FROM content_draft WHERE kind=${kind}`;
    if (draft) {
      const [audit] =
        await tx`SELECT "after"->>'reason' reason FROM audit_log WHERE entity='public_content' AND entity_id=${kind} ORDER BY at DESC,id DESC LIMIT 1`;
      draft.reason = audit?.reason || '';
    }
    const history =
      await tx`SELECT version,effective_at,reason,based_on_version FROM content_publication WHERE kind=${kind} ORDER BY effective_at DESC,id DESC LIMIT 25 OFFSET ${(historyPage - 1) * 25}`;
    const [{ total }] =
      await tx`SELECT count(*)::int total FROM content_publication WHERE kind=${kind}`;
    const publishedVersions =
      await tx`SELECT version FROM content_publication WHERE kind=${kind} AND version IN ('2026-09-20','2026-09-21','2026-10-04')`;
    const legacy = (policyKinds.includes(kind) ? Object.keys(policyVersions) : [POLICY_VERSION])
      .reverse()
      .map((version) => ({
        version,
        effective_at: version + 'T00:00:00.000Z',
        reason: 'Original published content',
        builtin: true,
      }));
    return {
      kind,
      canWrite,
      live,
      draft: draft || { version: 0, state: 'draft', body: live.body },
      historyPage,
      historyPages: Math.max(1, Math.ceil(total / 25)),
      history: [
        ...history,
        ...(historyPage === Math.max(1, Math.ceil(total / 25))
          ? legacy.filter((item) => !publishedVersions.some((h) => h.version === item.version))
          : []),
      ],
    };
  });
}
export async function contentCommand(database, actor, kind, input) {
  validKind(kind);
  const v = parse(
    z
      .object({
        command: z.enum(['save', 'restore', 'review', 'preview', 'publish']),
        version: z.number().int().min(0),
        body: z.unknown().optional(),
        sourceVersion: versionSchema.optional(),
        reason: plain(1000).refine((s) => s.length >= 10, 'Use at least 10 characters.'),
        confirmed: z.boolean().optional(),
        previewHash: z.string().length(64).optional(),
      })
      .strict(),
    input,
  );
  return database.begin(async (tx) => {
    await authorize(tx, actor, true);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'content:' + kind},0))`;
    const [draft] = await tx`SELECT * FROM content_draft WHERE kind=${kind} FOR UPDATE`;
    if (kind === 'contact' && !draft && ['save', 'restore'].includes(v.command)) {
      const baseline = builtin('contact');
      await tx`INSERT INTO content_publication(kind,version,body,content_hash,published_by,is_baseline,reason,effective_at) VALUES ('contact',${POLICY_VERSION},${JSON.stringify(baseline.body)}::text::jsonb,${baseline.contentHash},${actor.id},true,'Preserved configured contact baseline before first editorial draft',clock_timestamp()) ON CONFLICT(kind,version) DO NOTHING`;
    }

    if ((draft?.version || 0) !== v.version)
      throw conflict('STALE_CONTENT', 'The draft changed. Reload and review the latest version.');
    let result, after;
    if (['save', 'restore'].includes(v.command)) {
      if (v.command === 'restore' && !v.sourceVersion)
        throw badRequest('INVALID_CONTENT', 'Choose a historical version.');
      const restored =
        v.command === 'restore' ? await publicContent(tx, kind, v.sourceVersion) : null;
      const body = validateContent(kind, restored?.body ?? v.body);
      const [saved] =
        await tx`INSERT INTO content_draft(kind,version,body,state,updated_by,based_on_version) VALUES (${kind},${v.version + 1},${JSON.stringify(body)}::text::jsonb,'draft',${actor.id},${restored?.version ?? null}) ON CONFLICT(kind) DO UPDATE SET version=EXCLUDED.version,body=EXCLUDED.body,state='draft',updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp(),reviewed_by=NULL,reviewed_at=NULL,based_on_version=EXCLUDED.based_on_version RETURNING version`;
      result = { ok: true, version: saved.version };
      after = {
        body,
        state: 'draft',
        version: saved.version,
        sourceVersion: restored?.version ?? null,
      };
    } else {
      if (!draft || draft.state === 'published')
        throw conflict('DRAFT_REQUIRED', 'Save a new draft before review or publication.');
      validateContent(kind, draft.body);
      if (v.command === 'review') {
        if (!v.confirmed)
          throw badRequest(
            'REVIEW_REQUIRED',
            'Confirm review of the content and any contact channels.',
          );
        await tx`UPDATE content_draft SET state='reviewed',version=version+1,reviewed_by=${actor.id},reviewed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE kind=${kind}`;
        result = { ok: true, version: draft.version + 1 };
        after = { state: 'reviewed', version: draft.version + 1 };
      } else {
        if (draft.state !== 'reviewed')
          throw conflict('REVIEW_REQUIRED', 'Review this exact draft before publication.');
        if (v.command === 'publish') await tx`SELECT pg_advisory_xact_lock(73425,1)`;
        const current = await publicContent(tx, kind);
        if (!process.env.SESSION_SECRET)
          throw unavailable('PUBLICATION_UNAVAILABLE', 'Publication signing is not configured.');
        const previewHash = createHmac('sha256', process.env.SESSION_SECRET)
          .update(
            JSON.stringify({
              kind,
              version: draft.version,
              body: draft.body,
              reviewedBy: draft.reviewed_by,
              current: current.version,
              actor: actor.id,
              reason: v.reason,
            }),
          )
          .digest('hex');
        if (v.command === 'preview')
          return {
            preview: true,
            previewHash,
            body: draft.body,
            currentVersion: current.version,
            notice:
              'Publication takes effect immediately. Accepted booking records and historical URLs stay unchanged. New quotes use the new policy version; unaccepted older quotes must be refreshed. This copy does not change prices, refund rules or payment capabilities.',
          };
        if (!v.confirmed || v.previewHash !== previewHash)
          throw conflict('STALE_PREVIEW', 'Preview this exact publication and confirm it.');
        const id = randomUUID(),
          version = id.replaceAll('-', '');
        const [saved] =
          await tx`INSERT INTO content_publication(id,kind,version,body,content_hash,published_by,reviewed_by,reason,based_on_version,effective_at) VALUES (${id},${kind},${version},${JSON.stringify(draft.body)}::text::jsonb,${digest(draft.body)},${actor.id},${draft.reviewed_by},${v.reason},${draft.based_on_version},clock_timestamp()) RETURNING effective_at`;
        await tx`UPDATE content_draft SET state='published',version=version+1,updated_at=clock_timestamp() WHERE kind=${kind}`;
        result = {
          ok: true,
          published: true,
          version,
          effectiveAt: new Date(saved.effective_at).toISOString(),
        };
        after = {
          publication: version,
          hash: digest(draft.body),
          reviewedBy: draft.reviewed_by,
          sourceVersion: draft.based_on_version,
        };
      }
    }
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after") VALUES ('admin',${actor.id},'public_content',${kind},${'content.' + v.command},${JSON.stringify(draft ? { version: draft.version, state: draft.state } : null)}::text::jsonb,${JSON.stringify({ ...after, reason: v.reason })}::text::jsonb)`;
    return result;
  });
}
