import 'server-only';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { withListingInventory } from './inventory.js';
import { pricingSchema, termsSchema } from '../schemas/zod/listing.js';
import { conflict, notFound, unprocessable } from '../../utils/apiError.js';

const signature = (value) =>
  createHmac('sha256', process.env.SESSION_SECRET).update(JSON.stringify(value)).digest('hex');
export async function changePropertyPolicy(database, ownerId, id, command, input) {
  z.string().uuid().parse(id);
  z.enum(['pricing', 'terms']).parse(command);
  const schema = command === 'pricing' ? pricingSchema : termsSchema;
  const parsed = schema.safeParse(input.values);
  if (!parsed.success) throw unprocessable(parsed.error.flatten().fieldErrors);
  const value = parsed.data;
  if (command === 'pricing' && value.extraHourCharge)
    throw unprocessable({ extraHourCharge: ['Extra-hour billing is not supported.'] });
  return withListingInventory(database, id, async (tx, listing) => {
    const [owner] =
      await tx`SELECT id FROM "user" WHERE id=${ownerId} AND role='client' AND account_status='active' FOR SHARE`;
    if (!owner || listing.client_id !== ownerId) throw notFound();
    if (
      !Number.isInteger(input.expectedVersion) ||
      input.expectedVersion !== listing.content_version
    )
      throw conflict(
        'LISTING_CHANGED',
        'The property changed. Reload the latest version and preview again.',
      );
    const rates =
      await tx`SELECT slot,weekday,weekend FROM rentable_price WHERE rentable_id=${id} ORDER BY slot`;
    const before =
      command === 'pricing'
        ? { rates, extraGuestCharge: listing.extra_guest_charge }
        : { depositAmount: listing.deposit_amount, cancellationTier: listing.cancellation_tier };
    const token = signature([
      ownerId,
      id,
      command,
      listing.content_version,
      listing.booking_config_version,
      before,
      value,
    ]);
    if (input.preview)
      return {
        preview: {
          token,
          before,
          after: value,
          effective:
            'Immediately after confirmation, for new quotes only. Accepted bookings keep their original terms.',
        },
      };
    if (input.previewToken !== token)
      throw conflict('PREVIEW_REQUIRED', 'Preview these exact values before saving.');
    if (command === 'pricing') {
      await tx`DELETE FROM rentable_price WHERE rentable_id=${id}`;
      for (const slot of ['day', 'night', 'full_day'])
        if (value[`${slot}_weekday`] > 0 || value[`${slot}_weekend`] > 0)
          await tx`INSERT INTO rentable_price(rentable_id,slot,weekday,weekend) VALUES (${id},${slot},${value[`${slot}_weekday`]},${value[`${slot}_weekend`]})`;
      const config = listing.booking_config;
      if (config?.slots)
        for (const schedule of Object.values(config.slots))
          if (schedule.enabled)
            schedule.extraGuestChargeMinor = (value.extraGuestCharge || 0) * 100;
      await tx`UPDATE rentable SET extra_guest_charge=${value.extraGuestCharge || 0},booking_config=${JSON.stringify(config)}::text::jsonb,booking_config_version=booking_config_version+1,updated_at=now() WHERE id=${id}`;
    } else {
      await tx`UPDATE rentable SET deposit_amount=${value.depositAmount},cancellation_tier=${value.cancellationTier},booking_config_version=booking_config_version+1,updated_at=now() WHERE id=${id}`;
    }
    const [after] =
      await tx`SELECT content_version,booking_config_version FROM rentable WHERE id=${id}`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after") VALUES ('client',${ownerId},'rentable',${id},${'property_' + command + '_changed'},${JSON.stringify(before)}::text::jsonb,${JSON.stringify({ values: value, contentVersion: after.content_version, effectiveVersion: after.booking_config_version, effective: 'immediate' })}::text::jsonb)`;
    return {
      ok: true,
      contentVersion: after.content_version,
      effectiveVersion: after.booking_config_version,
    };
  });
}
export async function propertyPolicyHistory(database, ownerId, id) {
  const rows =
    await database`SELECT a.action,a.at,a."after" FROM audit_log a JOIN rentable r ON r.id::text=a.entity_id WHERE r.id=${id} AND r.client_id=${ownerId} AND a.entity='rentable' AND a.action IN ('property_pricing_changed','property_terms_changed','booking_configuration_changed','booking_price_override_changed') ORDER BY a.at DESC,a.id DESC LIMIT 30`;
  return rows.map((r) => ({
    action: r.action,
    at: r.at,
    values: r.after?.values || r.after,
    effectiveVersion: r.after?.effectiveVersion || null,
  }));
}
