import 'server-only';
import { readFileSync } from 'node:fs';
import { authorize, resolvePayoutMode } from './payout-modes.js';
import { initiationDisabled } from './initiation-switch.js';

// Story 2.21: gate definitions live in code and are read-only. Every gate needs external evidence
// that no endpoint can record, so each one is 'blocked' until a code change with that evidence lands.
const DOCS = 'Rentra-Doc/_bmad-output/implementation-artifacts';
const NEON_RECORDED = '0075';

function latestLocalMigration() {
  try {
    const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
    return journal.entries.at(-1).tag.slice(0, 4);
  } catch {
    return null;
  }
}

export function pendingMigrations(latest) {
  const next = String(Number(NEON_RECORDED) + 1).padStart(4, '0');
  return latest ? `apply ${next}-${latest}` : `apply ${next} onward; latest migration unknown in this build`;
}

function gates() {
  const latest = latestLocalMigration();
  return [
    { id: 'funding', name: 'Funding source and exposure limit', owner: 'Founder / finance',
      blocker: 'No funded source, exposure limit, exposure monitor or breach action is evidenced. The proposed INR 40,000 is a proposal, not funded, not adequacy proof.',
      evidence: [`${DOCS}/epic-2-acceptance-evidence.md`] },
    { id: 'specialist-terms', name: 'Specialist owner terms, accounting and tax', owner: 'Legal / accounting specialist',
      blocker: 'Owner terms, accounting treatment and tax review have no signed specialist evidence.', evidence: [] },
    { id: 'provider-live', name: 'Provider Live keys and hosted signed Test evidence', owner: 'Engineering lead',
      blocker: 'No Live keys are provisioned and hosted signed Test evidence (webhooks, refunds, repayments) is not recorded.',
      evidence: [`${DOCS}/epic-2-acceptance-evidence.md`] },
    { id: 'staffing', name: 'Staffing and support', owner: 'Operations lead',
      blocker: 'No staffed finance support rota or escalation owner is evidenced.', evidence: [] },
    { id: 'dispute-caps', name: 'Dispute caps', owner: 'Finance operator',
      blocker: 'Local dispute cap tests pass; the cap values and hosted evidence are not approved for Live money.',
      evidence: [`${DOCS}/epic-2-acceptance-evidence.md`] },
    { id: 'migrations', name: 'Pending Neon migrations', owner: 'Engineering lead',
      blocker: `Neon last recorded at ${NEON_RECORDED} (from HANDOFF); ${pendingMigrations(latest)}.`,
      evidence: ['Rentra-Doc/HANDOFF.md'] },
    { id: 'alerts', name: 'Worker, delivery, unknown-outcome and exposure alerts', owner: 'Operations lead',
      blocker: 'Alerts are not wired to a staffed paging channel; worker health below is a local fact only.', evidence: [] },
  ].map((gate) => ({ ...gate, status: 'blocked' }));
}

export async function readReleaseGates(database, actor, env = process.env) {
  return database.begin(async (tx) => {
    await authorize(tx, actor);
    const [config] = await tx`SELECT environment,enabled FROM payment_gateway_config ORDER BY version DESC LIMIT 1`;
    const [{ funded }] = await tx`SELECT count(*)::int funded FROM payout WHERE funding_allocation_id IS NOT NULL`;
    const [counts] = await tx`SELECT
      (SELECT count(*)::int FROM refund WHERE state::text IN ('unknown','needs_review')) refunds,
      (SELECT count(*)::int FROM payout_transfer_fixture WHERE state::text IN ('unknown','needs_review')) payouts,
      (SELECT count(*)::int FROM owner_repayment WHERE state::text IN ('unknown','needs_review')) repayments`;
    const health = await tx`SELECT service,healthy,checked_at AS "checkedAt",last_success_at AS "lastSuccessAt" FROM service_health ORDER BY service`;
    const list = gates();
    const ready = list.every((g) => g.status === 'passed');
    return {
      overall: ready ? 'ready' : 'not_ready',
      overallLabel: ready ? 'Ready for Live money' : 'Not ready for Live money',
      proposal: { amountMinor: '4000000', currency: 'INR', label: 'Proposal, not funded, not adequacy proof' },
      gates: list,
      facts: {
        gatewayEnvironment: config?.environment ?? null,
        gatewayEnabled: Boolean(config?.enabled),
        fundingAllocations: funded,
        payoutMode: (await resolvePayoutMode(tx)).globalMode,
        unresolvedOutcomes: counts,
        workerHealth: health,
        initiationDisabled: initiationDisabled(env),
      },
    };
  });
}
