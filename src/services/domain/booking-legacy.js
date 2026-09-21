import { createHash } from 'node:crypto';
import { legacyRupeesToMinor } from './booking-money.js';
import { parseLocalDate } from './booking-dates.js';

export const BACKFILL_VERSION = 'customer-reservations-v1';
const activeStates = new Set(['requested', 'confirmed', 'handed_over', 'returned', 'disputed']);
const moneyColumns = ['amount_rent', 'amount_fee', 'amount_deposit', 'amount_advance_paid'];

/** Only explicit per-ID evidence may classify an old record as seed/test/real. */
export function planLegacyVisit(row, { timeZone, provenanceById = {} } = {}) {
  const issues = [];
  if (row.payment_mode === 'real' || (row.collected_minor != null && Number(row.collected_minor) !== 0)) {
    issues.push('payment_evidence_requires_separate_reconciliation');
  }
  if (timeZone !== 'Asia/Kolkata') issues.push('timezone_requires_verified_mapping');
  try { parseLocalDate(row.day); } catch { issues.push('invalid_local_day'); }
  const converted = {};
  for (const column of moneyColumns) {
    try { converted[column] = legacyRupeesToMinor(row[column]); }
    catch { issues.push(`invalid_${column}`); }
  }
  if (row.units_booked !== 1 || !Number.isInteger(row.guests) || row.guests < 1) issues.push('unsupported_units_or_guests');
  const evidence = provenanceById[row.id];
  if (evidence && (!['seed', 'test', 'real'].includes(evidence.provenance) || !evidence.evidence?.trim())) {
    issues.push('invalid_provenance_evidence');
  }
  const storedProvenance = ['seed', 'test'].includes(row.visit_provenance) ||
    (row.backfill_version && row.visit_provenance === 'real') ? row.visit_provenance : 'legacy_unknown';
  const provenance = evidence?.provenance ?? storedProvenance;
  if (row.backfill_version && evidence && evidence.provenance !== row.visit_provenance) {
    issues.push('provenance_change_requires_review');
  }
  // Timestamps alone cannot prove buffers or the slot definition sold historically.
  const hoursKnown = false;
  const snapshot = {
    source: 'legacy_booking', bookingId: row.id, reference: row.reference,
    rentableId: row.rentable_id, customerId: row.customer_id, localDay: row.day,
    slot: row.slot, guests: row.guests, units: row.units_booked,
    legacyAmountsRupees: Object.fromEntries(moneyColumns.map((key) => [key, row[key]])),
    originalStartsAt: row.starts_at ?? null, originalEndsAt: row.ends_at ?? null,
    historicalListingFactsKnown: false, historicalPolicyKnown: false,
  };
  const requestHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const amounts = {
    amount_rent_minor: converted.amount_rent,
    amount_fee_minor: converted.amount_fee,
    amount_deposit_minor: converted.amount_deposit,
    legacy_advance_reported_minor: converted.amount_advance_paid,
  };
  if (row.backfill_version) {
    if (row.backfill_version !== BACKFILL_VERSION) issues.push('unsupported_backfill_version');
    if (!row.order_id || Object.entries(amounts).some(([key, value]) => Number(row[key]) !== value || row[key] == null)) issues.push('backfill_reconciliation_mismatch');
  } else if (row.order_id || Object.keys(amounts).some((key) => row[key] != null)) {
    issues.push('partial_backfill_requires_review');
  }
  return {
    id: row.id, issues, canBackfill: !issues.length && !row.backfill_version,
    alreadyBackfilled: row.backfill_version === BACKFILL_VERSION,
    unknownHours: !hoursKnown, inventoryRemediationRequired: activeStates.has(row.state),
    settlementUnknown: true, provenance, provenanceEvidence: evidence?.evidence ?? null,
    amounts, snapshot, requestHash, timeZone, hoursKnown,
  };
}
