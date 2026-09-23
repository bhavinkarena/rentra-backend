import { sql } from '../config/database.js';
import {
  getPaymentConfiguration,
  setPaymentGatewayConfiguration,
} from '../services/payments/gateway-settings.js';

// Explicit operator command; never run during server startup or database seeding.
const actorId = process.argv[2];
if (!actorId) throw new Error('Usage: npm run payments:enable-test -- <active-admin-id>');
try {
  const current = await getPaymentConfiguration(sql);
  if (
    current.enabled &&
    current.provider === 'razorpay' &&
    current.environment === 'test' &&
    current.credentialsReady
  ) {
    console.log('Razorpay Test is already enabled.');
  } else {
    const result = await setPaymentGatewayConfiguration(sql, {
      actorId,
      expectedVersion: current.version,
      provider: 'razorpay',
      environment: 'test',
      enabled: true,
      collectionPurpose: current.collectionPurpose,
    });
    console.log(
      `Razorpay Test enabled at configuration version ${result.version}. No live payments enabled.`,
    );
  }
} catch (error) {
  console.error('Could not enable Razorpay Test:', error.code ?? 'CONFIGURATION_FAILED');
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
