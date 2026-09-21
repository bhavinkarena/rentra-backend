'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/services/auth/admin';
import { sql } from '@/services/db';
import { setPaymentGatewayConfiguration } from '@/services/payments/gateway-settings';
import { PaymentConfigurationError } from '@/services/payments/provider-registry';

export async function savePaymentGatewaySettings(_previous, formData) {
  const admin = await requireAdmin();
  const rawEnabled = formData.get('enabled');
  try {
    await setPaymentGatewayConfiguration(sql, {
      actorId: admin.id,
      expectedVersion: Number(formData.get('expectedVersion')),
      provider: formData.get('provider'),
      environment: formData.get('environment'),
      enabled: rawEnabled === 'true' ? true : rawEnabled === 'false' ? false : undefined,
      collectionPurpose: formData.get('collectionPurpose'),
    });
  } catch (error) {
    return {
      error: error instanceof PaymentConfigurationError
        ? error.message
        : 'Payment settings could not be saved. Please try again.',
    };
  }
  revalidatePath('/admin/payments');
  return { ok: true };
}
