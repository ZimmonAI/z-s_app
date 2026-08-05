import type {
  ProviderSecretContext,
  ProviderSecretEnvelopeRepository,
  StoredProviderSecretEnvelope,
} from './provider-secret-store.js';
import { ProviderSecretStoreError } from './provider-secret-store.js';
import type { PostgresQueryable } from './runtime-storage-registry-types.js';

interface ProviderSecretRow extends Record<string, unknown> {
  id: string;
  key_version: number;
  algorithm: 'aes-256-gcm';
  nonce: Buffer;
  ciphertext: Buffer;
  authentication_tag: Buffer;
  created_at: Date | string;
  revoked_at: Date | string | null;
}

export class PostgresProviderSecretEnvelopeRepository
implements ProviderSecretEnvelopeRepository {
  readonly configured = true;
  readonly #queryable: PostgresQueryable;

  constructor(queryable: PostgresQueryable) {
    this.#queryable = queryable;
  }

  async insert(
    context: Readonly<ProviderSecretContext>,
    envelope: Readonly<StoredProviderSecretEnvelope>,
  ): Promise<void> {
    const result = await this.#queryable.query(`
INSERT INTO public.storage_control_provider_secrets (
  id,
  storage_control_client_id,
  environment,
  storage_service_id,
  provider_type,
  key_version,
  algorithm,
  nonce,
  ciphertext,
  authentication_tag,
  state,
  created_at
)
SELECT
  $1,
  clients.id,
  $3,
  services.id,
  $5,
  $6,
  $7,
  $8,
  $9,
  $10,
  'active',
  $11
FROM public.storage_control_clients AS clients
JOIN public.storage_control_storage_services AS services
  ON services.storage_control_client_id = clients.id
 AND services.environment = $3
 AND services.service_id = $4
WHERE clients.client_id = $2
  AND clients.status = 'active'
RETURNING id
`, [
      envelope.id,
      context.clientId,
      context.environment,
      context.serviceId,
      context.providerType,
      envelope.keyVersion,
      envelope.algorithm,
      Buffer.from(envelope.nonce),
      Buffer.from(envelope.ciphertext),
      Buffer.from(envelope.authenticationTag),
      new Date(envelope.createdAt),
    ]);
    if (result.rows[0] === undefined) {
      throw new ProviderSecretStoreError(404, 'storage-service-not-found');
    }
  }

  async read(
    context: Readonly<ProviderSecretContext>,
    secretId: string,
  ): Promise<Readonly<StoredProviderSecretEnvelope>> {
    const result = await this.#queryable.query<ProviderSecretRow>(`
SELECT
  secrets.id,
  secrets.key_version,
  secrets.algorithm,
  secrets.nonce,
  secrets.ciphertext,
  secrets.authentication_tag,
  secrets.created_at,
  secrets.revoked_at
FROM public.storage_control_provider_secrets AS secrets
JOIN public.storage_control_clients AS clients
  ON clients.id = secrets.storage_control_client_id
JOIN public.storage_control_storage_services AS services
  ON services.id = secrets.storage_service_id
WHERE secrets.id = $1
  AND clients.client_id = $2
  AND secrets.environment = $3
  AND services.service_id = $4
  AND secrets.provider_type = $5
LIMIT 1
`, [
      secretId,
      context.clientId,
      context.environment,
      context.serviceId,
      context.providerType,
    ]);
    const row = result.rows[0];
    if (row === undefined) throw new ProviderSecretStoreError(404, 'provider-secret-not-found');
    return Object.freeze({
      id: row.id,
      keyVersion: row.key_version,
      algorithm: row.algorithm,
      nonce: Uint8Array.from(row.nonce),
      ciphertext: Uint8Array.from(row.ciphertext),
      authenticationTag: Uint8Array.from(row.authentication_tag),
      createdAt: new Date(row.created_at).toISOString(),
      ...(row.revoked_at === null
        ? {}
        : { revokedAt: new Date(row.revoked_at).toISOString() }),
    });
  }

  async revoke(
    context: Readonly<ProviderSecretContext>,
    secretId: string,
    replacedBySecretId: string | undefined,
    now: Date,
  ): Promise<void> {
    const result = await this.#queryable.query(`
UPDATE public.storage_control_provider_secrets AS secrets
SET state = 'revoked',
    revoked_at = $6,
    replaced_by_secret_id = $7
FROM public.storage_control_clients AS clients,
     public.storage_control_storage_services AS services
WHERE secrets.id = $1
  AND clients.id = secrets.storage_control_client_id
  AND services.id = secrets.storage_service_id
  AND clients.client_id = $2
  AND secrets.environment = $3
  AND services.service_id = $4
  AND secrets.provider_type = $5
  AND secrets.state = 'active'
RETURNING secrets.id
`, [
      secretId,
      context.clientId,
      context.environment,
      context.serviceId,
      context.providerType,
      now,
      replacedBySecretId ?? null,
    ]);
    if (result.rows[0] === undefined) {
      throw new ProviderSecretStoreError(404, 'provider-secret-not-found');
    }
  }
}
