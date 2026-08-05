import type {
  StorageServiceActivityEvent,
  StorageServiceDependencySnapshot,
  StorageServiceListFilter,
  StorageServiceRepository,
  StorageServiceSnapshot,
  StorageServiceStatus,
} from './storage-service.js';
import { StorageServiceError, completeCapabilities } from './storage-service.js';
import type { StorageServiceCapabilities } from './storage-provider-adapter.js';
import type { ClientStorageEnvironment } from './client-storage-configuration.js';
import type { PostgresQueryable } from './runtime-storage-registry-types.js';
import {
  readStorageServiceActivity,
  readStorageServiceDependencies,
  writeStorageServiceActivity,
} from './storage-service-postgres-audit.js';

interface StorageServiceRow extends Record<string, unknown> {
  id: string;
  client_id: string;
  environment: ClientStorageEnvironment;
  service_id: string;
  display_name: string;
  provider_type: string;
  ownership: 'z-s-managed' | 'client-owned';
  managed_secret_reference_id: string | null;
  status: StorageServiceStatus;
  safe_metadata: unknown;
  capability_manifest: unknown;
  last_test_status: 'never' | 'passed' | 'failed';
  last_tested_at: Date | string | null;
  last_diagnostic_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.freeze({ ...(value as Record<string, unknown>) })
    : Object.freeze({});
}

function snapshot(row: Readonly<StorageServiceRow>): Readonly<StorageServiceSnapshot> {
  return Object.freeze({
    id: row.id,
    serviceId: row.service_id,
    clientId: row.client_id,
    environment: row.environment,
    displayName: row.display_name,
    providerType: row.provider_type,
    ownership: row.ownership,
    ...(row.managed_secret_reference_id === null
      ? {}
      : { managedSecretReferenceId: row.managed_secret_reference_id }),
    status: row.status,
    safeMetadata: record(row.safe_metadata),
    capabilities: completeCapabilities(record(row.capability_manifest) as
      Partial<StorageServiceCapabilities>),
    lastTestStatus: row.last_test_status,
    ...(row.last_tested_at === null
      ? {}
      : { lastTestedAt: new Date(row.last_tested_at).toISOString() }),
    ...(row.last_diagnostic_code === null
      ? {}
      : { lastDiagnosticCode: row.last_diagnostic_code }),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

const SELECT_SERVICE = `
SELECT
  services.id,
  clients.client_id,
  services.environment,
  services.service_id,
  services.display_name,
  services.provider_type,
  services.ownership,
  services.managed_secret_reference_id,
  services.status,
  services.safe_metadata,
  services.capability_manifest,
  services.last_test_status,
  services.last_tested_at,
  services.last_diagnostic_code,
  services.created_at,
  services.updated_at
FROM public.storage_control_storage_services AS services
JOIN public.storage_control_clients AS clients
  ON clients.id = services.storage_control_client_id
`;

export class PostgresStorageServiceRepository implements StorageServiceRepository {
  readonly configured = true;
  readonly #queryable: PostgresQueryable;

  constructor(queryable: PostgresQueryable) {
    this.#queryable = queryable;
  }

  async create(
    input: Readonly<{
      id: string;
      serviceId: string;
      clientId: string;
      environment: ClientStorageEnvironment;
      displayName: string;
      providerType: string;
      ownership: 'z-s-managed' | 'client-owned';
      safeMetadata: Readonly<Record<string, unknown>>;
      capabilities: StorageServiceCapabilities;
    }>,
    now: Date,
  ): Promise<Readonly<StorageServiceSnapshot>> {
    const result = await this.#queryable.query<StorageServiceRow>(`
INSERT INTO public.storage_control_storage_services (
  id,
  storage_control_client_id,
  environment,
  service_id,
  display_name,
  provider_type,
  ownership,
  managed_secret_reference_id,
  status,
  safe_metadata,
  capability_manifest,
  last_test_status,
  created_at,
  updated_at
)
SELECT
  $1,
  clients.id,
  $3,
  $4,
  $5,
  $6,
  $7,
  NULL,
  'awaiting-secret',
  $8::jsonb,
  $9::jsonb,
  'never',
  $10,
  $10
FROM public.storage_control_clients AS clients
WHERE clients.client_id = $2 AND clients.status = 'active'
RETURNING
  id,
  $2::text AS client_id,
  environment,
  service_id,
  display_name,
  provider_type,
  ownership,
  managed_secret_reference_id,
  status,
  safe_metadata,
  capability_manifest,
  last_test_status,
  last_tested_at,
  last_diagnostic_code,
  created_at,
  updated_at
`, [
      input.id,
      input.clientId,
      input.environment,
      input.serviceId,
      input.displayName,
      input.providerType,
      input.ownership,
      JSON.stringify(input.safeMetadata),
      JSON.stringify(input.capabilities),
      now,
    ]);
    const row = result.rows[0];
    if (row === undefined) throw new StorageServiceError(404, 'client-storage-not-found');
    await this.recordActivity(
      input.clientId,
      input.environment,
      input.serviceId,
      'storage-service-created',
      { ownership: input.ownership, providerType: input.providerType },
      now,
    );
    return snapshot(row);
  }

  async list(
    clientId: string,
    filter: Readonly<StorageServiceListFilter>,
  ): Promise<readonly Readonly<StorageServiceSnapshot>[]> {
    const result = await this.#queryable.query<StorageServiceRow>(`${SELECT_SERVICE}
WHERE clients.client_id = $1
  AND ($2::text IS NULL OR services.environment = $2)
  AND ($3::text IS NULL OR services.provider_type = $3)
  AND ($4::text IS NULL OR services.ownership = $4)
  AND ($5::text IS NULL OR services.status = $5)
ORDER BY services.environment, services.display_name, services.service_id
`, [
      clientId,
      filter.environment ?? null,
      filter.providerType ?? null,
      filter.ownership ?? null,
      filter.status ?? null,
    ]);
    return Object.freeze(result.rows.map(snapshot));
  }

  async read(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
  ): Promise<Readonly<StorageServiceSnapshot>> {
    const result = await this.#queryable.query<StorageServiceRow>(`${SELECT_SERVICE}
WHERE clients.client_id = $1
  AND services.environment = $2
  AND services.service_id = $3
LIMIT 1
`, [clientId, environment, serviceId]);
    const row = result.rows[0];
    if (row === undefined) throw new StorageServiceError(404, 'storage-service-not-found');
    return snapshot(row);
  }

  async readByInternalId(internalId: string): Promise<Readonly<StorageServiceSnapshot>> {
    const result = await this.#queryable.query<StorageServiceRow>(`${SELECT_SERVICE}
WHERE services.id = $1
LIMIT 1
`, [internalId]);
    const row = result.rows[0];
    if (row === undefined) throw new StorageServiceError(404, 'storage-service-not-found');
    return snapshot(row);
  }

  async activeSecretId(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
  ): Promise<string | undefined> {
    const result = await this.#queryable.query<{ active_provider_secret_id: string | null }>(`
SELECT services.active_provider_secret_id
FROM public.storage_control_storage_services AS services
JOIN public.storage_control_clients AS clients
  ON clients.id = services.storage_control_client_id
WHERE clients.client_id = $1
  AND services.environment = $2
  AND services.service_id = $3
LIMIT 1
`, [clientId, environment, serviceId]);
    const row = result.rows[0];
    if (row === undefined) throw new StorageServiceError(404, 'storage-service-not-found');
    return row.active_provider_secret_id ?? undefined;
  }

  async bindSecret(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
    secretId: string,
    now: Date,
  ): Promise<void> {
    const result = await this.#queryable.query(`
UPDATE public.storage_control_storage_services AS services
SET active_provider_secret_id = $4,
    status = 'testing',
    updated_at = $5
FROM public.storage_control_clients AS clients
WHERE clients.id = services.storage_control_client_id
  AND clients.client_id = $1
  AND services.environment = $2
  AND services.service_id = $3
RETURNING services.id
`, [clientId, environment, serviceId, secretId, now]);
    if (result.rows[0] === undefined) throw new StorageServiceError(404, 'storage-service-not-found');
  }

  async recordTest(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
    result: Readonly<{
      connected: boolean;
      capabilities: StorageServiceCapabilities;
      diagnosticCode: string | null;
      testedAt: string;
    }>,
    now: Date,
  ): Promise<Readonly<StorageServiceSnapshot>> {
    const updated = await this.#queryable.query<StorageServiceRow>(`
UPDATE public.storage_control_storage_services AS services
SET status = CASE WHEN $4 THEN 'ready' ELSE 'failed' END,
    capability_manifest = $5::jsonb,
    last_test_status = CASE WHEN $4 THEN 'passed' ELSE 'failed' END,
    last_tested_at = $6,
    last_diagnostic_code = $7,
    updated_at = $8
FROM public.storage_control_clients AS clients
WHERE clients.id = services.storage_control_client_id
  AND clients.client_id = $1
  AND services.environment = $2
  AND services.service_id = $3
RETURNING
  services.id,
  clients.client_id,
  services.environment,
  services.service_id,
  services.display_name,
  services.provider_type,
  services.ownership,
  services.managed_secret_reference_id,
  services.status,
  services.safe_metadata,
  services.capability_manifest,
  services.last_test_status,
  services.last_tested_at,
  services.last_diagnostic_code,
  services.created_at,
  services.updated_at
`, [
      clientId,
      environment,
      serviceId,
      result.connected,
      JSON.stringify(result.capabilities),
      new Date(result.testedAt),
      result.diagnosticCode,
      now,
    ]);
    const row = updated.rows[0];
    if (row === undefined) throw new StorageServiceError(404, 'storage-service-not-found');
    return snapshot(row);
  }

  async setStatus(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
    status: 'disabled' | 'archived',
    now: Date,
  ): Promise<Readonly<StorageServiceSnapshot>> {
    const result = await this.#queryable.query<StorageServiceRow>(`
UPDATE public.storage_control_storage_services AS services
SET status = $4,
    disabled_at = CASE WHEN $4 = 'disabled' THEN $5 ELSE NULL END,
    archived_at = CASE WHEN $4 = 'archived' THEN $5 ELSE NULL END,
    updated_at = $5
FROM public.storage_control_clients AS clients
WHERE clients.id = services.storage_control_client_id
  AND clients.client_id = $1
  AND services.environment = $2
  AND services.service_id = $3
RETURNING
  services.id,
  clients.client_id,
  services.environment,
  services.service_id,
  services.display_name,
  services.provider_type,
  services.ownership,
  services.managed_secret_reference_id,
  services.status,
  services.safe_metadata,
  services.capability_manifest,
  services.last_test_status,
  services.last_tested_at,
  services.last_diagnostic_code,
  services.created_at,
  services.updated_at
`, [clientId, environment, serviceId, status, now]);
    const row = result.rows[0];
    if (row === undefined) throw new StorageServiceError(404, 'storage-service-not-found');
    await this.recordActivity(clientId, environment, serviceId, `storage-service-${status}`, {}, now);
    return snapshot(row);
  }

  dependencies(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
  ): Promise<Readonly<StorageServiceDependencySnapshot>> {
    return readStorageServiceDependencies(this.#queryable, clientId, environment, serviceId);
  }

  activity(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
  ): Promise<readonly Readonly<StorageServiceActivityEvent>[]> {
    return readStorageServiceActivity(this.#queryable, clientId, environment, serviceId);
  }

  recordActivity(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
    eventType: string,
    safeSummary: Readonly<Record<string, unknown>>,
    now: Date,
  ): Promise<void> {
    return writeStorageServiceActivity(
      this.#queryable,
      clientId,
      environment,
      serviceId,
      eventType,
      safeSummary,
      now,
    );
  }

}
