import { randomUUID } from 'node:crypto';
import type { ClientStorageEnvironment } from './client-storage-configuration.js';
import type {
  StorageServiceActivityEvent,
  StorageServiceDependencySnapshot,
} from './storage-service.js';
import { StorageServiceError } from './storage-service.js';
import type { PostgresQueryable } from './runtime-storage-registry-types.js';

interface DependencyRow extends Record<string, unknown> {
  draft_configuration_count: string | number;
  active_configuration_count: string | number;
  vault_count: string | number;
  route_count: string | number;
  object_copy_count: string | number;
  derivative_output_count: string | number;
}

interface ActivityRow extends Record<string, unknown> {
  id: string;
  event_type: string;
  safe_summary: unknown;
  created_at: Date | string;
}

function integer(value: string | number): number {
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : 0;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.freeze({ ...(value as Record<string, unknown>) })
    : Object.freeze({});
}

export async function readStorageServiceDependencies(
  queryable: PostgresQueryable,
  clientId: string,
  environment: ClientStorageEnvironment,
  serviceId: string,
): Promise<Readonly<StorageServiceDependencySnapshot>> {
  const result = await queryable.query<DependencyRow>(`
WITH selected AS (
  SELECT services.id
  FROM public.storage_control_storage_services AS services
  JOIN public.storage_control_clients AS clients
    ON clients.id = services.storage_control_client_id
  WHERE clients.client_id = $1
    AND services.environment = $2
    AND services.service_id = $3
), connections AS (
  SELECT connections.id
  FROM public.storage_control_provider_connections AS connections
  JOIN selected ON selected.id = connections.storage_service_id
), versions AS (
  SELECT DISTINCT versions.id, versions.state
  FROM public.storage_control_configuration_versions AS versions
  JOIN public.storage_control_configuration_vaults AS vaults
    ON vaults.configuration_version_id = versions.id
  JOIN connections ON connections.id = vaults.provider_connection_id
), vaults AS (
  SELECT vaults.id
  FROM public.storage_control_configuration_vaults AS vaults
  JOIN connections ON connections.id = vaults.provider_connection_id
), routes AS (
  SELECT DISTINCT targets.configuration_route_id
  FROM public.storage_control_configuration_route_targets AS targets
  JOIN vaults ON vaults.id = targets.vault_id
)
SELECT
  (SELECT count(*) FROM versions WHERE state = 'draft') AS draft_configuration_count,
  (SELECT count(*) FROM versions WHERE state = 'active') AS active_configuration_count,
  (SELECT count(*) FROM vaults) AS vault_count,
  (SELECT count(*) FROM routes) AS route_count,
  (SELECT count(*) FROM public.storage_object_copies AS copies
    JOIN connections ON connections.id = copies.provider_connection_id) AS object_copy_count,
  (SELECT count(DISTINCT outputs.image_derivative_output_id)
   FROM public.storage_image_derivative_outputs AS outputs
   JOIN public.storage_object_copies AS copies
     ON copies.storage_object_id = outputs.output_storage_object_id
   JOIN connections ON connections.id = copies.provider_connection_id) AS derivative_output_count
`, [clientId, environment, serviceId]);
  const row = result.rows[0];
  if (row === undefined) throw new StorageServiceError(404, 'storage-service-not-found');
  return Object.freeze({
    draftConfigurationCount: integer(row.draft_configuration_count),
    activeConfigurationCount: integer(row.active_configuration_count),
    vaultCount: integer(row.vault_count),
    routeCount: integer(row.route_count),
    objectCopyCount: integer(row.object_copy_count),
    derivativeOutputCount: integer(row.derivative_output_count),
  });
}

export async function readStorageServiceActivity(
  queryable: PostgresQueryable,
  clientId: string,
  environment: ClientStorageEnvironment,
  serviceId: string,
): Promise<readonly Readonly<StorageServiceActivityEvent>[]> {
  const result = await queryable.query<ActivityRow>(`
SELECT events.id, events.event_type, events.safe_summary, events.created_at
FROM public.storage_control_storage_service_events AS events
JOIN public.storage_control_storage_services AS services
  ON services.id = events.storage_service_id
JOIN public.storage_control_clients AS clients
  ON clients.id = events.storage_control_client_id
WHERE clients.client_id = $1
  AND events.environment = $2
  AND services.service_id = $3
ORDER BY events.created_at DESC, events.id DESC
LIMIT 100
`, [clientId, environment, serviceId]);
  return Object.freeze(result.rows.map((row) => Object.freeze({
    id: row.id,
    eventType: row.event_type,
    safeSummary: record(row.safe_summary),
    createdAt: new Date(row.created_at).toISOString(),
  })));
}

export async function writeStorageServiceActivity(
  queryable: PostgresQueryable,
  clientId: string,
  environment: ClientStorageEnvironment,
  serviceId: string,
  eventType: string,
  safeSummary: Readonly<Record<string, unknown>>,
  now: Date,
): Promise<void> {
  await queryable.query(`
INSERT INTO public.storage_control_storage_service_events (
  id,
  storage_control_client_id,
  environment,
  storage_service_id,
  event_type,
  actor_kind,
  actor_reference,
  safe_summary,
  created_at
)
SELECT
  $1,
  clients.id,
  $3,
  services.id,
  $5,
  'client-browser',
  $2,
  $6::jsonb,
  $7
FROM public.storage_control_clients AS clients
JOIN public.storage_control_storage_services AS services
  ON services.storage_control_client_id = clients.id
 AND services.environment = $3
 AND services.service_id = $4
WHERE clients.client_id = $2
`, [randomUUID(), clientId, environment, serviceId, eventType, JSON.stringify(safeSummary), now]);
}
