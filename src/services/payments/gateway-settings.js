import 'server-only';
import { z } from 'zod';
import { paymentCredentialStatus } from './provider-credentials.js';
import { PaymentConfigurationError, registeredPaymentProvider } from './provider-registry.js';

const changeSchema = z.object({
  actorId: z.string().uuid(),
  expectedVersion: z.number().int().min(0).max(2_147_483_646),
  provider: z.string().min(1).max(32),
  environment: z.literal('test'),
  enabled: z.boolean(),
  collectionPurpose: z.enum(['full', 'advance']),
}).strict();

function snapshot(row) {
  return Object.freeze(row ? {
    version: row.version,
    provider: row.provider,
    environment: row.environment,
    mode: 'real', // Existing financial schema uses real+test for sandbox gateway facts.
    enabled: row.enabled,
    collectionPurpose: row.collection_purpose,
  } : {
    version: 0, provider: null, environment: null, mode: null,
    enabled: false, collectionPurpose: 'full',
  });
}

async function latestConfiguration(database) {
  const [row] = await database`
    SELECT version, provider, environment, enabled, collection_purpose
    FROM payment_gateway_config ORDER BY version DESC LIMIT 1`;
  return snapshot(row);
}

/** No credential, account secret or unregistered adapter is exposed by this DTO. */
export async function getPaymentConfiguration(database, variables = process.env) {
  const current = await latestConfiguration(database);
  const status = current.provider
    ? paymentCredentialStatus(current.provider, current.environment, variables)
    : { ready: false, reason: 'No payment gateway has been selected.' };
  return { ...current, credentialsReady: status.ready, credentialStatus: status.reason };
}

/** Caller supplies the authenticated admin id, never one read from form input. */
export async function requireActivePaymentAdmin(database, actorId) {
  if (!z.string().uuid().safeParse(actorId).success) {
    throw new PaymentConfigurationError('ADMIN_REQUIRED', 'An active admin account is required.');
  }
  const [active] = await database`SELECT id FROM admin_user WHERE id=${actorId} AND is_active=true FOR SHARE`;
  if (!active) throw new PaymentConfigurationError('ADMIN_REQUIRED', 'An active admin account is required.');
}

/**
 * Database-injected internal DAL. The separate admin session is checked by the
 * Server Action; this transaction rechecks the active account under a row lock.
 * Every change appends a revision and its audit event, or neither is committed.
 */
export async function setPaymentGatewayConfiguration(database, input, variables = process.env) {
  const parsed = changeSchema.safeParse(input);
  if (!parsed.success) throw new PaymentConfigurationError('INVALID_GATEWAY_CHANGE', 'The payment settings are invalid. Reload and try again.');
  const change = parsed.data;
  registeredPaymentProvider(change.provider, change.environment);

  return database.begin(async (transaction) => {
    await requireActivePaymentAdmin(transaction, change.actorId);
    // Serialize even the first change, when there is no config row to lock yet.
    await transaction`SELECT pg_advisory_xact_lock(73420, 1)`;
    const before = await latestConfiguration(transaction);
    if (before.version !== change.expectedVersion) {
      throw new PaymentConfigurationError('GATEWAY_VERSION_CONFLICT', 'Payment settings changed in another session. Reload before saving.');
    }
    if (change.enabled) {
      const credentials = paymentCredentialStatus(change.provider, change.environment, variables);
      if (!credentials.ready) throw new PaymentConfigurationError('GATEWAY_CREDENTIALS_MISSING', credentials.reason);
    }
    const [row] = await transaction`
      INSERT INTO payment_gateway_config
        (version, provider, environment, enabled, collection_purpose, changed_by)
      VALUES (${before.version + 1}, ${change.provider}, ${change.environment}, ${change.enabled},
        ${change.collectionPurpose}, ${change.actorId})
      RETURNING version, provider, environment, enabled, collection_purpose`;
    const after = snapshot(row);
    await transaction`
      INSERT INTO audit_log (actor_type, actor_id, entity, entity_id, action, "before", "after")
      VALUES ('admin', ${change.actorId}, 'payment_gateway_config', ${String(after.version)},
        'payment_gateway_changed', ${JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb)`;
    return after;
  });
}

/**
 * Pin this revision in a quote; recheck it before a later NEW attempt. This is a
 * configuration gate only: Part 11 execution separately checks identity and inventory.
 */
export async function requireNewPaymentConfiguration(database, { expectedVersion } = {}, variables = process.env) {
  const config = await getPaymentConfiguration(database, variables);
  if (!config.enabled) throw new PaymentConfigurationError('PAYMENTS_DISABLED', 'New payment attempts are paused.');
  if (expectedVersion !== undefined && expectedVersion !== config.version) {
    throw new PaymentConfigurationError('GATEWAY_VERSION_CONFLICT', 'Payment settings changed. Request a new quote.');
  }
  if (!config.credentialsReady) throw new PaymentConfigurationError('GATEWAY_CREDENTIALS_MISSING', config.credentialStatus);
  return Object.freeze({
    version: config.version, provider: config.provider, environment: config.environment,
    mode: config.mode, collectionPurpose: config.collectionPurpose, enabled: true,
  });
}

/**
 * Existing intents retain their original scope when new attempts are disabled.
 * Callers must separately authorize ownership and verify provider evidence.
 */
export async function resolvePinnedPaymentConfiguration(database, pinned) {
  if (!Number.isSafeInteger(pinned?.version) || pinned.version < 1) {
    throw new PaymentConfigurationError('INVALID_GATEWAY_SNAPSHOT', 'The payment configuration reference is invalid.');
  }
  const [row] = await database`
    SELECT version, provider, environment, enabled, collection_purpose
    FROM payment_gateway_config WHERE version=${pinned.version}`;
  const config = snapshot(row);
  if (!row || !config.enabled || ['provider', 'environment', 'mode', 'collectionPurpose'].some((key) => pinned[key] !== config[key])) {
    throw new PaymentConfigurationError('INVALID_GATEWAY_SNAPSHOT', 'The payment configuration reference does not match.');
  }
  registeredPaymentProvider(config.provider, config.environment);
  return config;
}
