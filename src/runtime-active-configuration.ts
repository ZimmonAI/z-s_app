import { createHash } from 'node:crypto';
import type { ClientStorageEnvironment } from './client-storage-configuration.js';
import type { SafeDiagnosticCategory } from './runtime-contract.js';
import type { ProviderCredentialResolver } from './runtime-s3-provider.js';
import type { PostgresQueryable } from './runtime-storage-registry-types.js';

export type RuntimeAssetClass = 'image' | 'video' | 'document';
export type ConfiguredTargetRole = 'primary' | 'replica';
export type ConfiguredProviderType = 'minio' | 'r2' | 's3-compatible';

export interface ActiveConfigurationResolverInput {
  clientId: string;
  environment: ClientStorageEnvironment;
  assetClass: RuntimeAssetClass;
}

export interface ResolvedConfigurationTarget {
  configurationRouteTargetId: string;
  configurationVaultId: string;
  providerConnectionId: string;
  role: ConfiguredTargetRole;
  order: number;
  providerType: ConfiguredProviderType;
  bucketLabel: string;
  prefixTemplate: string;
  secretReferenceId: string;
  vaultId: string;
  connectionId: string;
}

export interface ResolvedActiveConfiguration {
  storageControlClientId: string;
  clientId: string;
  configurationVersionId: string;
  versionNumber: number;
  environment: ClientStorageEnvironment;
  configurationRouteId: string;
  routeId: string;
  assetClass: RuntimeAssetClass;
  configurationFingerprint: string;
  targets: readonly Readonly<ResolvedConfigurationTarget>[];
}

interface ActiveConfigurationRow extends Record<string, unknown> {
  storage_control_client_id: string;
  client_id: string;
  configuration_version_id: string;
  version_number: number;
  environment: ClientStorageEnvironment;
  configuration_route_id: string;
  route_id: string;
  asset_class: RuntimeAssetClass;
  configuration_route_target_id: string;
  target_role: ConfiguredTargetRole;
  target_order: number;
  configuration_vault_id: string;
  vault_id: string;
  bucket_label: string;
  prefix_template: string;
  provider_connection_id: string;
  connection_id: string;
  provider_type: ConfiguredProviderType;
  secret_reference_id: string;
}

interface RouteReadinessRow extends Record<string, unknown> {
  active_configuration_count: string | number;
  route_count: string | number;
  route_target_count: string | number;
  active_connection_target_count: string | number;
}

export class ActiveConfigurationError extends Error {
  readonly category: SafeDiagnosticCategory;
  readonly code: string;
  readonly status: 409 | 503;
  readonly retryable: boolean;

  constructor(
    category: SafeDiagnosticCategory,
    code: string,
    status: 409 | 503,
    retryable = status === 503,
  ) {
    super(code);
    this.name = 'ActiveConfigurationError';
    this.category = category;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const ACTIVE_CONFIGURATION_QUERY = `
SELECT
  clients.id AS storage_control_client_id,
  clients.client_id,
  versions.id AS configuration_version_id,
  versions.version_number,
  versions.environment,
  routes.id AS configuration_route_id,
  routes.route_id,
  routes.asset_class,
  targets.id AS configuration_route_target_id,
  targets.target_role,
  targets.target_order,
  vaults.id AS configuration_vault_id,
  vaults.vault_id,
  vaults.bucket_label,
  vaults.prefix_template,
  connections.id AS provider_connection_id,
  connections.connection_id,
  connections.provider_type,
  connections.secret_reference_id
FROM public.storage_control_clients AS clients
JOIN public.storage_control_configuration_versions AS versions
  ON versions.storage_control_client_id = clients.id
JOIN public.storage_control_configuration_routes AS routes
  ON routes.storage_control_client_id = clients.id
 AND routes.configuration_version_id = versions.id
JOIN public.storage_control_configuration_route_targets AS targets
  ON targets.storage_control_client_id = clients.id
 AND targets.configuration_version_id = versions.id
 AND targets.configuration_route_id = routes.id
JOIN public.storage_control_configuration_vaults AS vaults
  ON vaults.storage_control_client_id = clients.id
 AND vaults.configuration_version_id = versions.id
 AND vaults.id = targets.vault_id
JOIN public.storage_control_provider_connections AS connections
  ON connections.storage_control_client_id = clients.id
 AND connections.environment = versions.environment
 AND connections.id = vaults.provider_connection_id
WHERE clients.client_id = $1
  AND clients.status = 'active'
  AND versions.environment = $2
  AND versions.state = 'active'
  AND versions.validation_state = 'valid'
  AND routes.asset_class = $3
  AND connections.status = 'active'
ORDER BY
  CASE targets.target_role WHEN 'primary' THEN 0 ELSE 1 END,
  targets.target_order,
  targets.id;
`;

const ROUTE_READINESS_QUERY = `
SELECT
  COUNT(DISTINCT versions.id) FILTER (
    WHERE clients.status = 'active'
      AND versions.state = 'active'
      AND versions.validation_state = 'valid'
  ) AS active_configuration_count,
  COUNT(DISTINCT routes.id) FILTER (
    WHERE clients.status = 'active'
      AND versions.state = 'active'
      AND versions.validation_state = 'valid'
      AND routes.asset_class = $3
  ) AS route_count,
  COUNT(DISTINCT targets.id) FILTER (
    WHERE clients.status = 'active'
      AND versions.state = 'active'
      AND versions.validation_state = 'valid'
      AND routes.asset_class = $3
  ) AS route_target_count,
  COUNT(DISTINCT targets.id) FILTER (
    WHERE clients.status = 'active'
      AND versions.state = 'active'
      AND versions.validation_state = 'valid'
      AND routes.asset_class = $3
      AND connections.status = 'active'
  ) AS active_connection_target_count
FROM public.storage_control_clients AS clients
LEFT JOIN public.storage_control_configuration_versions AS versions
  ON versions.storage_control_client_id = clients.id
 AND versions.environment = $2
LEFT JOIN public.storage_control_configuration_routes AS routes
  ON routes.storage_control_client_id = clients.id
 AND routes.configuration_version_id = versions.id
LEFT JOIN public.storage_control_configuration_route_targets AS targets
  ON targets.storage_control_client_id = clients.id
 AND targets.configuration_version_id = versions.id
 AND targets.configuration_route_id = routes.id
LEFT JOIN public.storage_control_configuration_vaults AS vaults
  ON vaults.storage_control_client_id = clients.id
 AND vaults.configuration_version_id = versions.id
 AND vaults.id = targets.vault_id
LEFT JOIN public.storage_control_provider_connections AS connections
  ON connections.storage_control_client_id = clients.id
 AND connections.environment = versions.environment
 AND connections.id = vaults.provider_connection_id
WHERE clients.client_id = $1;
`;

function integer(value: string | number): number {
  const result = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : 0;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

export function stableConfigurationFingerprint(
  input: Readonly<{
    configurationVersionId: string;
    versionNumber: number;
    environment: ClientStorageEnvironment;
    routeId: string;
    assetClass: RuntimeAssetClass;
    targets: readonly Readonly<ResolvedConfigurationTarget>[];
  }>,
): string {
  const authority = {
    configurationVersionId: input.configurationVersionId,
    versionNumber: input.versionNumber,
    environment: input.environment,
    routeId: input.routeId,
    assetClass: input.assetClass,
    targets: input.targets.map((target) => ({
      configurationRouteTargetId: target.configurationRouteTargetId,
      role: target.role,
      order: target.order,
      configurationVaultId: target.configurationVaultId,
      vaultId: target.vaultId,
      bucketLabel: target.bucketLabel,
      prefixTemplate: target.prefixTemplate,
      providerConnectionId: target.providerConnectionId,
      connectionId: target.connectionId,
      providerType: target.providerType,
      secretReferenceId: target.secretReferenceId,
    })),
  };
  return createHash('sha256').update(JSON.stringify(stableValue(authority)), 'utf8').digest('hex');
}

export function deriveRuntimeAssetClass(mediaType: string): RuntimeAssetClass {
  const normalized = mediaType.trim().toLowerCase();
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  return 'document';
}

function assertSharedAuthority(rows: readonly ActiveConfigurationRow[]): void {
  const first = rows[0];
  if (first === undefined) return;
  for (const row of rows) {
    if (
      row.storage_control_client_id !== first.storage_control_client_id ||
      row.client_id !== first.client_id ||
      row.configuration_version_id !== first.configuration_version_id ||
      row.version_number !== first.version_number ||
      row.environment !== first.environment ||
      row.configuration_route_id !== first.configuration_route_id ||
      row.route_id !== first.route_id ||
      row.asset_class !== first.asset_class
    ) {
      throw new ActiveConfigurationError(
        'dependency-unavailable',
        'active-configuration-not-ready',
        503,
      );
    }
  }
}

function normalizeTargets(rows: readonly ActiveConfigurationRow[]): readonly Readonly<ResolvedConfigurationTarget>[] {
  const primaryRows = rows.filter((row) => row.target_role === 'primary');
  if (primaryRows.length !== 1 || primaryRows[0]?.target_order !== 0) {
    throw new ActiveConfigurationError(
      'dependency-unavailable',
      'configuration-primary-target-not-ready',
      503,
    );
  }
  const replicaOrders = new Set<number>();
  for (const row of rows) {
    if (row.target_role !== 'primary' && row.target_role !== 'replica') {
      throw new ActiveConfigurationError(
        'dependency-unavailable',
        'active-configuration-not-ready',
        503,
      );
    }
    if (row.target_role === 'replica') {
      if (!Number.isSafeInteger(row.target_order) || row.target_order <= 0 || replicaOrders.has(row.target_order)) {
        throw new ActiveConfigurationError(
          'dependency-unavailable',
          'active-configuration-not-ready',
          503,
        );
      }
      replicaOrders.add(row.target_order);
    }
  }
  return Object.freeze(rows.map((row) => Object.freeze({
    configurationRouteTargetId: row.configuration_route_target_id,
    configurationVaultId: row.configuration_vault_id,
    providerConnectionId: row.provider_connection_id,
    role: row.target_role,
    order: row.target_order,
    providerType: row.provider_type,
    bucketLabel: row.bucket_label,
    prefixTemplate: row.prefix_template,
    secretReferenceId: row.secret_reference_id,
    vaultId: row.vault_id,
    connectionId: row.connection_id,
  })));
}

export class PostgresActiveConfigurationResolver {
  readonly #queryable: PostgresQueryable;
  readonly #credentialResolver: ProviderCredentialResolver;

  constructor(input: Readonly<{
    queryable: PostgresQueryable;
    credentialResolver: ProviderCredentialResolver;
  }>) {
    this.#queryable = input.queryable;
    this.#credentialResolver = input.credentialResolver;
  }

  async resolve(
    input: Readonly<ActiveConfigurationResolverInput>,
  ): Promise<Readonly<ResolvedActiveConfiguration>> {
    let rows: readonly ActiveConfigurationRow[];
    try {
      rows = (await this.#queryable.query<ActiveConfigurationRow>(ACTIVE_CONFIGURATION_QUERY, [
        input.clientId,
        input.environment,
        input.assetClass,
      ])).rows;
    } catch {
      throw new ActiveConfigurationError(
        'dependency-unavailable',
        'active-configuration-not-ready',
        503,
      );
    }

    const readiness = await this.#readiness(input);
    if (readiness.activeConfigurationCount === 0) {
      throw new ActiveConfigurationError(
        'dependency-unavailable',
        'active-configuration-not-ready',
        503,
      );
    }
    if (readiness.routeCount === 0) {
      throw new ActiveConfigurationError('not-ready', 'configuration-route-not-found', 409, false);
    }
    if (
      readiness.routeTargetCount === 0 ||
      readiness.activeConnectionTargetCount !== readiness.routeTargetCount ||
      rows.length !== readiness.routeTargetCount
    ) {
      throw new ActiveConfigurationError(
        'dependency-unavailable',
        'configuration-provider-connection-not-ready',
        503,
      );
    }

    assertSharedAuthority(rows);
    const targets = normalizeTargets(rows);
    for (const target of targets) {
      try {
        await this.#credentialResolver.resolve(target.secretReferenceId);
      } catch {
        throw new ActiveConfigurationError(
          'dependency-unavailable',
          'provider-credential-binding-unavailable',
          503,
        );
      }
    }
    const first = rows[0];
    if (first === undefined) {
      throw new ActiveConfigurationError(
        'dependency-unavailable',
        'configuration-primary-target-not-ready',
        503,
      );
    }
    const configurationFingerprint = stableConfigurationFingerprint({
      configurationVersionId: first.configuration_version_id,
      versionNumber: first.version_number,
      environment: first.environment,
      routeId: first.route_id,
      assetClass: first.asset_class,
      targets,
    });
    return Object.freeze({
      storageControlClientId: first.storage_control_client_id,
      clientId: first.client_id,
      configurationVersionId: first.configuration_version_id,
      versionNumber: first.version_number,
      environment: first.environment,
      configurationRouteId: first.configuration_route_id,
      routeId: first.route_id,
      assetClass: first.asset_class,
      configurationFingerprint,
      targets,
    });
  }

  async #readiness(input: Readonly<ActiveConfigurationResolverInput>): Promise<Readonly<{
    activeConfigurationCount: number;
    routeCount: number;
    routeTargetCount: number;
    activeConnectionTargetCount: number;
  }>> {
    let row: RouteReadinessRow | undefined;
    try {
      row = (await this.#queryable.query<RouteReadinessRow>(ROUTE_READINESS_QUERY, [
        input.clientId,
        input.environment,
        input.assetClass,
      ])).rows[0];
    } catch {
      throw new ActiveConfigurationError(
        'dependency-unavailable',
        'active-configuration-not-ready',
        503,
      );
    }
    return Object.freeze({
      activeConfigurationCount: integer(row?.active_configuration_count ?? 0),
      routeCount: integer(row?.route_count ?? 0),
      routeTargetCount: integer(row?.route_target_count ?? 0),
      activeConnectionTargetCount: integer(row?.active_connection_target_count ?? 0),
    });
  }
}
