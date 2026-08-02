import { randomUUID } from 'node:crypto';
import {
  assertConfigurationDraftInput,
  ClientStorageConfigurationError,
  digestIntegrationToken,
  issueIntegrationTokenValue,
  normalizeIntegrationTokenScopes,
  validateConfigurationDraft,
  type ClientStorageConfigurationStore,
  type ClientStorageEnvironment,
  type ClientStorageOverview,
  type ConfigurationDraftDocument,
  type ConfigurationImagePresetInput,
  type ConfigurationRouteInput,
  type ConfigurationVaultInput,
  type ConfigurationVersionSnapshot,
  type CreateConfigurationDraftInput,
  type IntegrationTokenAuthenticationResult,
  type IntegrationTokenCreationResult,
  type IntegrationTokenMetadata,
  type IntegrationTokenScope,
  type ProviderConnectionInput,
} from './client-storage-configuration.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryable,
} from './runtime-storage-registry-types.js';

interface ClientRow extends Record<string, unknown> {
  id: string;
  status: string;
}

interface VersionRow extends Record<string, unknown> {
  id: string;
  environment: ClientStorageEnvironment;
  version_number: number;
  state: 'draft' | 'active' | 'superseded';
  validation_state: 'unvalidated' | 'valid' | 'invalid';
  safe_validation_errors: unknown;
  cloned_from_configuration_version_id: string | null;
  activated_at: Date | string | null;
  superseded_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ProviderConnectionRow extends Record<string, unknown> {
  id: string;
  connection_id: string;
  display_label: string;
  provider_type: ProviderConnectionInput['providerType'];
  secret_reference_id: string;
  safe_metadata: unknown;
}

interface VaultRow extends Record<string, unknown> {
  id: string;
  vault_id: string;
  provider_connection_id: string;
  display_label: string;
  purpose: ConfigurationVaultInput['purpose'];
  bucket_label: string;
  prefix_template: string;
  retention_mode: 'permanent' | 'delete-after-days';
  delete_after_days: number | null;
}

interface ImagePresetRow extends Record<string, unknown> {
  id: string;
  preset_id: string;
  target_vault_id: string;
  resize_widths: unknown;
  output_format: ConfigurationImagePresetInput['outputFormat'];
  quality: number;
  fit_mode: ConfigurationImagePresetInput['fit'];
}

interface RouteRow extends Record<string, unknown> {
  id: string;
  route_id: string;
  asset_class: ConfigurationRouteInput['assetClass'];
  image_preset_id: string | null;
}

interface RouteTargetRow extends Record<string, unknown> {
  configuration_route_id: string;
  vault_id: string;
  target_role: 'primary' | 'replica';
  target_order: number;
}

interface TokenRow extends Record<string, unknown> {
  id: string;
  token_id: string;
  environment: ClientStorageEnvironment;
  display_label: string;
  scopes: IntegrationTokenScope[];
  status: 'active' | 'revoked' | 'expired';
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  rotated_from_token_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TokenAuthenticationRow extends Record<string, unknown> {
  client_id: string;
  client_status: string;
  token_id: string;
  environment: ClientStorageEnvironment;
  scopes: IntegrationTokenScope[];
  token_status: 'active' | 'revoked' | 'expired';
  expires_at: Date | string | null;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : Object.freeze({});
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? Object.freeze(value.filter((item): item is string => typeof item === 'string'))
    : Object.freeze([]);
}

function numberArray(value: unknown): readonly number[] {
  return Array.isArray(value)
    ? Object.freeze(value.filter((item): item is number => typeof item === 'number'))
    : Object.freeze([]);
}

function tokenMetadata(row: Readonly<TokenRow>, now: Date): Readonly<IntegrationTokenMetadata> {
  const expiresAt = row.expires_at === null ? undefined : iso(row.expires_at);
  const expired = expiresAt !== undefined && new Date(expiresAt).getTime() <= now.getTime();
  return Object.freeze({
    id: row.id,
    tokenId: row.token_id,
    environment: row.environment,
    displayLabel: row.display_label,
    scopes: Object.freeze([...row.scopes]),
    status: row.status === 'active' && expired ? 'expired' : row.status,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(row.revoked_at === null ? {} : { revokedAt: iso(row.revoked_at) }),
    ...(row.rotated_from_token_id === null
      ? {}
      : { rotatedFromTokenId: row.rotated_from_token_id }),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

async function withTransaction<T>(
  pool: PostgresPoolLike,
  operation: (client: PostgresClientLike) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function requireClient(
  queryable: PostgresQueryable,
  clientId: string,
  lock = false,
): Promise<string> {
  const result = await queryable.query<ClientRow>(`
SELECT id, status
FROM public.storage_control_clients
WHERE client_id = $1
${lock ? 'FOR UPDATE' : ''}
`, [clientId]);
  const row = result.rows[0];
  if (row === undefined) throw new ClientStorageConfigurationError(404, 'client-storage-not-found');
  if (row.status !== 'active') throw new ClientStorageConfigurationError(403, 'client-disabled');
  return row.id;
}

async function writeAudit(
  queryable: PostgresQueryable,
  input: Readonly<{
    clientInternalId: string;
    environment: ClientStorageEnvironment;
    eventType: string;
    actorReference: string;
    configurationVersionId?: string;
    integrationTokenId?: string;
    safeSummary?: Readonly<Record<string, unknown>>;
  }>,
): Promise<void> {
  await queryable.query(`
INSERT INTO public.storage_control_configuration_audit_events (
  id,
  storage_control_client_id,
  environment,
  configuration_version_id,
  integration_token_id,
  event_type,
  actor_kind,
  actor_reference,
  safe_summary
) VALUES ($1, $2, $3, $4, $5, $6, 'client-browser', $7, $8::jsonb)
`, [
    randomUUID(),
    input.clientInternalId,
    input.environment,
    input.configurationVersionId ?? null,
    input.integrationTokenId ?? null,
    input.eventType,
    input.actorReference,
    JSON.stringify(input.safeSummary ?? {}),
  ]);
}

async function upsertProviderConnections(
  queryable: PostgresQueryable,
  clientInternalId: string,
  environment: ClientStorageEnvironment,
  connections: readonly ProviderConnectionInput[],
  now: Date,
): Promise<ReadonlyMap<string, string>> {
  const identifiers = new Map<string, string>();
  for (const connection of connections) {
    const id = randomUUID();
    const result = await queryable.query<{ id: string }>(`
INSERT INTO public.storage_control_provider_connections (
  id,
  storage_control_client_id,
  environment,
  connection_id,
  display_label,
  provider_type,
  secret_reference_id,
  safe_metadata,
  status,
  created_at,
  updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'active', $9, $9)
ON CONFLICT (storage_control_client_id, environment, connection_id)
DO UPDATE SET
  display_label = EXCLUDED.display_label,
  provider_type = EXCLUDED.provider_type,
  secret_reference_id = EXCLUDED.secret_reference_id,
  safe_metadata = EXCLUDED.safe_metadata,
  status = 'active',
  updated_at = EXCLUDED.updated_at
RETURNING id
`, [
      id,
      clientInternalId,
      environment,
      connection.connectionId,
      connection.displayLabel,
      connection.providerType,
      connection.secretReferenceId,
      JSON.stringify(connection.safeMetadata ?? {}),
      now,
    ]);
    const row = result.rows[0];
    if (row === undefined) throw new ClientStorageConfigurationError(500, 'provider-connection-write-failed');
    identifiers.set(connection.connectionId, row.id);
  }
  return identifiers;
}

async function insertDocument(
  queryable: PostgresQueryable,
  input: Readonly<{
    clientInternalId: string;
    versionId: string;
    environment: ClientStorageEnvironment;
    document: Readonly<ConfigurationDraftDocument>;
    now: Date;
  }>,
): Promise<void> {
  const connectionIds = await upsertProviderConnections(
    queryable,
    input.clientInternalId,
    input.environment,
    input.document.providerConnections,
    input.now,
  );
  const vaultIds = new Map<string, string>();
  for (const vault of input.document.vaults) {
    const providerConnectionId = connectionIds.get(vault.providerConnectionId);
    if (providerConnectionId === undefined) {
      throw new ClientStorageConfigurationError(400, 'unknown-provider-connection');
    }
    const id = randomUUID();
    vaultIds.set(vault.vaultId, id);
    await queryable.query(`
INSERT INTO public.storage_control_configuration_vaults (
  id,
  storage_control_client_id,
  configuration_version_id,
  vault_id,
  provider_connection_id,
  display_label,
  purpose,
  bucket_label,
  prefix_template,
  retention_mode,
  delete_after_days,
  created_at,
  updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
`, [
      id,
      input.clientInternalId,
      input.versionId,
      vault.vaultId,
      providerConnectionId,
      vault.displayLabel,
      vault.purpose,
      vault.bucketLabel,
      vault.prefixTemplate,
      vault.retention.mode,
      vault.retention.mode === 'delete-after-days' ? vault.retention.deleteAfterDays : null,
      input.now,
    ]);
  }

  const presetIds = new Map<string, string>();
  for (const preset of input.document.imagePresets) {
    const targetVaultId = vaultIds.get(preset.targetVaultId);
    if (targetVaultId === undefined) {
      throw new ClientStorageConfigurationError(400, 'unknown-image-preset-vault');
    }
    const id = randomUUID();
    presetIds.set(preset.presetId, id);
    await queryable.query(`
INSERT INTO public.storage_control_configuration_image_presets (
  id,
  storage_control_client_id,
  configuration_version_id,
  preset_id,
  target_vault_id,
  resize_widths,
  output_format,
  quality,
  fit_mode,
  created_at,
  updated_at
) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $10)
`, [
      id,
      input.clientInternalId,
      input.versionId,
      preset.presetId,
      targetVaultId,
      JSON.stringify(preset.widths),
      preset.outputFormat,
      preset.quality,
      preset.fit,
      input.now,
    ]);
  }

  for (const route of input.document.routes) {
    const routeId = randomUUID();
    const imagePresetId = route.imagePresetId === undefined
      ? null
      : presetIds.get(route.imagePresetId);
    if (route.imagePresetId !== undefined && imagePresetId === undefined) {
      throw new ClientStorageConfigurationError(400, 'unknown-route-image-preset');
    }
    await queryable.query(`
INSERT INTO public.storage_control_configuration_routes (
  id,
  storage_control_client_id,
  configuration_version_id,
  route_id,
  asset_class,
  image_preset_id,
  created_at,
  updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
`, [
      routeId,
      input.clientInternalId,
      input.versionId,
      route.routeId,
      route.assetClass,
      imagePresetId ?? null,
      input.now,
    ]);
    const primary = route.targets.find((target) => target.role === 'primary');
    const replicas = route.targets.filter((target) => target.role === 'replica');
    const orderedTargets = [
      ...(primary === undefined ? [] : [{ ...primary, order: 0 }]),
      ...replicas.map((target, index) => ({ ...target, order: index + 1 })),
    ];
    for (const target of orderedTargets) {
      const vaultId = vaultIds.get(target.vaultId);
      if (vaultId === undefined) throw new ClientStorageConfigurationError(400, 'unknown-route-vault');
      await queryable.query(`
INSERT INTO public.storage_control_configuration_route_targets (
  id,
  storage_control_client_id,
  configuration_version_id,
  configuration_route_id,
  vault_id,
  target_role,
  target_order,
  created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
`, [
        randomUUID(),
        input.clientInternalId,
        input.versionId,
        routeId,
        vaultId,
        target.role,
        target.order,
        input.now,
      ]);
    }
  }
}

async function loadVersion(
  queryable: PostgresQueryable,
  clientId: string,
  environment: ClientStorageEnvironment,
  versionId: string,
): Promise<Readonly<ConfigurationVersionSnapshot>> {
  const versionResult = await queryable.query<VersionRow>(`
SELECT
  versions.id,
  versions.environment,
  versions.version_number,
  versions.state,
  versions.validation_state,
  versions.safe_validation_errors,
  versions.cloned_from_configuration_version_id,
  versions.activated_at,
  versions.superseded_at,
  versions.created_at,
  versions.updated_at
FROM public.storage_control_configuration_versions AS versions
JOIN public.storage_control_clients AS clients
  ON clients.id = versions.storage_control_client_id
WHERE clients.client_id = $1
  AND versions.environment = $2
  AND versions.id = $3
LIMIT 1
`, [clientId, environment, versionId]);
  const version = versionResult.rows[0];
  if (version === undefined) {
    throw new ClientStorageConfigurationError(404, 'configuration-version-not-found');
  }

  const [connectionResult, vaultResult, presetResult, routeResult, targetResult] = await Promise.all([
    queryable.query<ProviderConnectionRow>(`
SELECT DISTINCT
  connections.id,
  connections.connection_id,
  connections.display_label,
  connections.provider_type,
  connections.secret_reference_id,
  connections.safe_metadata
FROM public.storage_control_provider_connections AS connections
JOIN public.storage_control_configuration_vaults AS vaults
  ON vaults.provider_connection_id = connections.id
WHERE vaults.configuration_version_id = $1
ORDER BY connections.connection_id
`, [versionId]),
    queryable.query<VaultRow>(`
SELECT
  id,
  vault_id,
  provider_connection_id,
  display_label,
  purpose,
  bucket_label,
  prefix_template,
  retention_mode,
  delete_after_days
FROM public.storage_control_configuration_vaults
WHERE configuration_version_id = $1
ORDER BY vault_id
`, [versionId]),
    queryable.query<ImagePresetRow>(`
SELECT
  id,
  preset_id,
  target_vault_id,
  resize_widths,
  output_format,
  quality,
  fit_mode
FROM public.storage_control_configuration_image_presets
WHERE configuration_version_id = $1
ORDER BY preset_id
`, [versionId]),
    queryable.query<RouteRow>(`
SELECT id, route_id, asset_class, image_preset_id
FROM public.storage_control_configuration_routes
WHERE configuration_version_id = $1
ORDER BY asset_class
`, [versionId]),
    queryable.query<RouteTargetRow>(`
SELECT configuration_route_id, vault_id, target_role, target_order
FROM public.storage_control_configuration_route_targets
WHERE configuration_version_id = $1
ORDER BY configuration_route_id, target_order
`, [versionId]),
  ]);

  const connectionsById = new Map(connectionResult.rows.map((row) => [row.id, row]));
  const vaultsById = new Map(vaultResult.rows.map((row) => [row.id, row]));
  const presetsById = new Map(presetResult.rows.map((row) => [row.id, row]));
  const providerConnections: ProviderConnectionInput[] = connectionResult.rows.map((row) => ({
    connectionId: row.connection_id,
    displayLabel: row.display_label,
    providerType: row.provider_type,
    secretReferenceId: row.secret_reference_id,
    safeMetadata: record(row.safe_metadata),
  }));
  const vaults: ConfigurationVaultInput[] = vaultResult.rows.map((row) => {
    const connection = connectionsById.get(row.provider_connection_id);
    if (connection === undefined) throw new ClientStorageConfigurationError(500, 'configuration-reference-invalid');
    return {
      vaultId: row.vault_id,
      providerConnectionId: connection.connection_id,
      displayLabel: row.display_label,
      purpose: row.purpose,
      bucketLabel: row.bucket_label,
      prefixTemplate: row.prefix_template,
      retention: row.retention_mode === 'permanent'
        ? { mode: 'permanent' as const }
        : { mode: 'delete-after-days' as const, deleteAfterDays: row.delete_after_days ?? 0 },
    };
  });
  const imagePresets: ConfigurationImagePresetInput[] = presetResult.rows.map((row) => {
    const targetVault = vaultsById.get(row.target_vault_id);
    if (targetVault === undefined) throw new ClientStorageConfigurationError(500, 'configuration-reference-invalid');
    return {
      presetId: row.preset_id,
      targetVaultId: targetVault.vault_id,
      widths: numberArray(row.resize_widths),
      outputFormat: row.output_format,
      quality: row.quality,
      fit: row.fit_mode,
    };
  });
  const routes: ConfigurationRouteInput[] = routeResult.rows.map((row) => {
    const targets = targetResult.rows
      .filter((target) => target.configuration_route_id === row.id)
      .map((target) => {
        const vault = vaultsById.get(target.vault_id);
        if (vault === undefined) throw new ClientStorageConfigurationError(500, 'configuration-reference-invalid');
        return Object.freeze({ role: target.target_role, vaultId: vault.vault_id });
      });
    const preset = row.image_preset_id === null ? undefined : presetsById.get(row.image_preset_id);
    return {
      routeId: row.route_id,
      assetClass: row.asset_class,
      targets: Object.freeze(targets),
      ...(preset === undefined ? {} : { imagePresetId: preset.preset_id }),
    };
  });

  return Object.freeze({
    id: version.id,
    environment: version.environment,
    versionNumber: version.version_number,
    state: version.state,
    validationState: version.validation_state,
    validationErrors: stringArray(version.safe_validation_errors),
    ...(version.cloned_from_configuration_version_id === null
      ? {}
      : { clonedFromVersionId: version.cloned_from_configuration_version_id }),
    ...(version.activated_at === null ? {} : { activatedAt: iso(version.activated_at) }),
    ...(version.superseded_at === null ? {} : { supersededAt: iso(version.superseded_at) }),
    createdAt: iso(version.created_at),
    updatedAt: iso(version.updated_at),
    providerConnections: Object.freeze(providerConnections),
    vaults: Object.freeze(vaults),
    routes: Object.freeze(routes),
    imagePresets: Object.freeze(imagePresets),
  });
}

export class PostgresClientStorageConfigurationStore
implements ClientStorageConfigurationStore {
  readonly configured = true;
  readonly #pool: PostgresPoolLike & PostgresQueryable;

  constructor(pool: PostgresPoolLike & PostgresQueryable) {
    this.#pool = pool;
  }

  async overview(
    clientId: string,
    environment: ClientStorageEnvironment,
  ): Promise<Readonly<ClientStorageOverview>> {
    const clientInternalId = await requireClient(this.#pool, clientId);
    const [versions, connections, tokens] = await Promise.all([
      this.#pool.query<VersionRow>(`
SELECT id, environment, version_number, state, validation_state, safe_validation_errors,
       cloned_from_configuration_version_id, activated_at, superseded_at, created_at, updated_at
FROM public.storage_control_configuration_versions
WHERE storage_control_client_id = $1 AND environment = $2
ORDER BY version_number DESC
`, [clientInternalId, environment]),
      this.#pool.query<{ count: string }>(`
SELECT count(*)::text AS count
FROM public.storage_control_provider_connections
WHERE storage_control_client_id = $1 AND environment = $2
`, [clientInternalId, environment]),
      this.#pool.query<{ count: string }>(`
SELECT count(*)::text AS count
FROM public.storage_control_integration_tokens
WHERE storage_control_client_id = $1 AND environment = $2
`, [clientInternalId, environment]),
    ]);
    const active = versions.rows.find((row) => row.state === 'active');
    return Object.freeze({
      environment,
      ...(active === undefined
        ? {}
        : {
          activeVersion: Object.freeze({
            id: active.id,
            versionNumber: active.version_number,
            state: active.state,
            ...(active.activated_at === null ? {} : { activatedAt: iso(active.activated_at) }),
          }),
        }),
      draftVersions: Object.freeze(
        versions.rows
          .filter((row) => row.state === 'draft')
          .map((row) => Object.freeze({
            id: row.id,
            versionNumber: row.version_number,
            state: row.state,
            validationState: row.validation_state,
            updatedAt: iso(row.updated_at),
          })),
      ),
      providerConnectionCount: Number(connections.rows[0]?.count ?? 0),
      integrationTokenCount: Number(tokens.rows[0]?.count ?? 0),
    });
  }

  async createDraft(
    clientId: string,
    input: Readonly<CreateConfigurationDraftInput>,
    now = new Date(),
    clonedFromVersionId?: string,
  ): Promise<Readonly<ConfigurationVersionSnapshot>> {
    assertConfigurationDraftInput(input);
    const validationErrors = validateConfigurationDraft(input);
    const versionId = randomUUID();
    await withTransaction(this.#pool, async (client) => {
      const clientInternalId = await requireClient(client, clientId, true);
      if (clonedFromVersionId !== undefined) {
        const source = await client.query<{ id: string }>(`
SELECT id
FROM public.storage_control_configuration_versions
WHERE id = $1 AND storage_control_client_id = $2 AND environment = $3
`, [clonedFromVersionId, clientInternalId, input.environment]);
        if (source.rows[0] === undefined) {
          throw new ClientStorageConfigurationError(404, 'configuration-version-not-found');
        }
      }
      const next = await client.query<{ version_number: number }>(`
SELECT COALESCE(MAX(version_number), 0)::integer + 1 AS version_number
FROM public.storage_control_configuration_versions
WHERE storage_control_client_id = $1 AND environment = $2
`, [clientInternalId, input.environment]);
      const versionNumber = next.rows[0]?.version_number ?? 1;
      await client.query(`
INSERT INTO public.storage_control_configuration_versions (
  id,
  storage_control_client_id,
  environment,
  version_number,
  state,
  validation_state,
  safe_validation_errors,
  cloned_from_configuration_version_id,
  created_at,
  updated_at
) VALUES ($1, $2, $3, $4, 'draft', $5, $6::jsonb, $7, $8, $8)
`, [
        versionId,
        clientInternalId,
        input.environment,
        versionNumber,
        validationErrors.length === 0 ? 'valid' : 'invalid',
        JSON.stringify(validationErrors),
        clonedFromVersionId ?? null,
        now,
      ]);
      await insertDocument(client, {
        clientInternalId,
        versionId,
        environment: input.environment,
        document: input,
        now,
      });
      await writeAudit(client, {
        clientInternalId,
        environment: input.environment,
        eventType: clonedFromVersionId === undefined
          ? 'configuration-draft-created'
          : 'configuration-version-cloned',
        actorReference: clientId,
        configurationVersionId: versionId,
        safeSummary: { versionNumber, validationState: validationErrors.length === 0 ? 'valid' : 'invalid' },
      });
    });
    return loadVersion(this.#pool, clientId, input.environment, versionId);
  }

  async readVersion(
    clientId: string,
    environment: ClientStorageEnvironment,
    versionId: string,
  ): Promise<Readonly<ConfigurationVersionSnapshot>> {
    await requireClient(this.#pool, clientId);
    return loadVersion(this.#pool, clientId, environment, versionId);
  }

  async replaceDraft(
    clientId: string,
    environment: ClientStorageEnvironment,
    versionId: string,
    input: Readonly<ConfigurationDraftDocument>,
    now = new Date(),
  ): Promise<Readonly<ConfigurationVersionSnapshot>> {
    assertConfigurationDraftInput(input);
    const validationErrors = validateConfigurationDraft(input);
    await withTransaction(this.#pool, async (client) => {
      const clientInternalId = await requireClient(client, clientId, true);
      const version = await client.query<{ state: string }>(`
SELECT state
FROM public.storage_control_configuration_versions
WHERE id = $1 AND storage_control_client_id = $2 AND environment = $3
FOR UPDATE
`, [versionId, clientInternalId, environment]);
      const row = version.rows[0];
      if (row === undefined) throw new ClientStorageConfigurationError(404, 'configuration-version-not-found');
      if (row.state !== 'draft') {
        throw new ClientStorageConfigurationError(409, 'configuration-version-immutable');
      }
      await client.query(
        'DELETE FROM public.storage_control_configuration_route_targets WHERE configuration_version_id = $1',
        [versionId],
      );
      await client.query(
        'DELETE FROM public.storage_control_configuration_routes WHERE configuration_version_id = $1',
        [versionId],
      );
      await client.query(
        'DELETE FROM public.storage_control_configuration_image_presets WHERE configuration_version_id = $1',
        [versionId],
      );
      await client.query(
        'DELETE FROM public.storage_control_configuration_vaults WHERE configuration_version_id = $1',
        [versionId],
      );
      await insertDocument(client, {
        clientInternalId,
        versionId,
        environment,
        document: input,
        now,
      });
      await client.query(`
UPDATE public.storage_control_configuration_versions
SET validation_state = $4,
    safe_validation_errors = $5::jsonb,
    updated_at = $6
WHERE id = $1 AND storage_control_client_id = $2 AND environment = $3
`, [
        versionId,
        clientInternalId,
        environment,
        validationErrors.length === 0 ? 'valid' : 'invalid',
        JSON.stringify(validationErrors),
        now,
      ]);
      await writeAudit(client, {
        clientInternalId,
        environment,
        eventType: 'configuration-draft-replaced',
        actorReference: clientId,
        configurationVersionId: versionId,
        safeSummary: { validationState: validationErrors.length === 0 ? 'valid' : 'invalid' },
      });
    });
    return loadVersion(this.#pool, clientId, environment, versionId);
  }

  async deleteDraft(
    clientId: string,
    environment: ClientStorageEnvironment,
    versionId: string,
  ): Promise<void> {
    await withTransaction(this.#pool, async (client) => {
      const clientInternalId = await requireClient(client, clientId, true);
      const version = await client.query<{ state: string; version_number: number }>(`
SELECT state, version_number
FROM public.storage_control_configuration_versions
WHERE id = $1 AND storage_control_client_id = $2 AND environment = $3
FOR UPDATE
`, [versionId, clientInternalId, environment]);
      const row = version.rows[0];
      if (row === undefined) throw new ClientStorageConfigurationError(404, 'configuration-version-not-found');
      if (row.state !== 'draft') {
        throw new ClientStorageConfigurationError(409, 'configuration-version-immutable');
      }
      await client.query(
        'DELETE FROM public.storage_control_configuration_versions WHERE id = $1',
        [versionId],
      );
      await writeAudit(client, {
        clientInternalId,
        environment,
        eventType: 'configuration-draft-deleted',
        actorReference: clientId,
        safeSummary: { versionId, versionNumber: row.version_number },
      });
    });
  }

  async activateDraft(
    clientId: string,
    environment: ClientStorageEnvironment,
    versionId: string,
    now = new Date(),
  ): Promise<Readonly<ConfigurationVersionSnapshot>> {
    await withTransaction(this.#pool, async (client) => {
      const clientInternalId = await requireClient(client, clientId, true);
      await client.query(`
LOCK TABLE
  public.storage_control_configuration_vaults,
  public.storage_control_configuration_image_presets,
  public.storage_control_configuration_routes,
  public.storage_control_configuration_route_targets
IN SHARE ROW EXCLUSIVE MODE
`);
      const version = await client.query<{ state: string }>(`
SELECT state
FROM public.storage_control_configuration_versions
WHERE id = $1 AND storage_control_client_id = $2 AND environment = $3
FOR UPDATE
`, [versionId, clientInternalId, environment]);
      const row = version.rows[0];
      if (row === undefined) throw new ClientStorageConfigurationError(404, 'configuration-version-not-found');
      if (row.state !== 'draft') {
        throw new ClientStorageConfigurationError(409, 'configuration-version-immutable');
      }
      const snapshot = await loadVersion(client, clientId, environment, versionId);
      const validationErrors = validateConfigurationDraft(snapshot);
      if (validationErrors.length > 0) {
        await client.query(`
UPDATE public.storage_control_configuration_versions
SET validation_state = 'invalid', safe_validation_errors = $4::jsonb, updated_at = $5
WHERE id = $1 AND storage_control_client_id = $2 AND environment = $3
`, [versionId, clientInternalId, environment, JSON.stringify(validationErrors), now]);
        throw new ClientStorageConfigurationError(409, 'configuration-version-invalid');
      }
      await client.query(`
UPDATE public.storage_control_configuration_versions
SET state = 'superseded', superseded_at = $3, updated_at = $3
WHERE storage_control_client_id = $1 AND environment = $2 AND state = 'active'
`, [clientInternalId, environment, now]);
      await client.query(`
UPDATE public.storage_control_configuration_versions
SET state = 'active', validation_state = 'valid', safe_validation_errors = '[]'::jsonb,
    activated_at = $4, updated_at = $4
WHERE id = $1 AND storage_control_client_id = $2 AND environment = $3
`, [versionId, clientInternalId, environment, now]);
      await writeAudit(client, {
        clientInternalId,
        environment,
        eventType: 'configuration-version-activated',
        actorReference: clientId,
        configurationVersionId: versionId,
        safeSummary: { versionNumber: snapshot.versionNumber },
      });
    });
    return loadVersion(this.#pool, clientId, environment, versionId);
  }

  async cloneVersion(
    clientId: string,
    environment: ClientStorageEnvironment,
    versionId: string,
    now = new Date(),
  ): Promise<Readonly<ConfigurationVersionSnapshot>> {
    const source = await this.readVersion(clientId, environment, versionId);
    return this.createDraft(clientId, {
      environment,
      providerConnections: source.providerConnections,
      vaults: source.vaults,
      routes: source.routes,
      imagePresets: source.imagePresets,
    }, now, source.id);
  }

  async listIntegrationTokens(
    clientId: string,
    environment: ClientStorageEnvironment,
    now = new Date(),
  ): Promise<readonly Readonly<IntegrationTokenMetadata>[]> {
    const clientInternalId = await requireClient(this.#pool, clientId);
    const result = await this.#pool.query<TokenRow>(`
SELECT
  tokens.id,
  tokens.token_id,
  tokens.environment,
  tokens.display_label,
  tokens.scopes,
  tokens.status,
  tokens.expires_at,
  tokens.revoked_at,
  rotated.token_id AS rotated_from_token_id,
  tokens.created_at,
  tokens.updated_at
FROM public.storage_control_integration_tokens AS tokens
LEFT JOIN public.storage_control_integration_tokens AS rotated
  ON rotated.id = tokens.rotated_from_integration_token_id
WHERE tokens.storage_control_client_id = $1 AND tokens.environment = $2
ORDER BY tokens.created_at DESC
`, [clientInternalId, environment]);
    return Object.freeze(result.rows.map((row) => tokenMetadata(row, now)));
  }

  async createIntegrationToken(
    clientId: string,
    input: Readonly<{
      environment: ClientStorageEnvironment;
      tokenId: string;
      displayLabel: string;
      scopes: readonly IntegrationTokenScope[];
      expiresAt?: Date;
    }>,
    now = new Date(),
  ): Promise<Readonly<IntegrationTokenCreationResult>> {
    const scopes = normalizeIntegrationTokenScopes(input.scopes);
    if (input.expiresAt !== undefined && input.expiresAt.getTime() <= now.getTime()) {
      throw new ClientStorageConfigurationError(400, 'invalid-integration-token-expiry');
    }
    const rawToken = issueIntegrationTokenValue();
    const integrationTokenId = randomUUID();
    let metadata: Readonly<IntegrationTokenMetadata> | undefined;
    await withTransaction(this.#pool, async (client) => {
      const clientInternalId = await requireClient(client, clientId, true);
      const result = await client.query<TokenRow>(`
INSERT INTO public.storage_control_integration_tokens (
  id,
  storage_control_client_id,
  environment,
  token_id,
  display_label,
  token_digest,
  scopes,
  status,
  expires_at,
  created_at,
  updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], 'active', $8, $9, $9)
RETURNING id, token_id, environment, display_label, scopes, status, expires_at, revoked_at,
          NULL::text AS rotated_from_token_id, created_at, updated_at
`, [
        integrationTokenId,
        clientInternalId,
        input.environment,
        input.tokenId,
        input.displayLabel,
        digestIntegrationToken(rawToken),
        scopes,
        input.expiresAt ?? null,
        now,
      ]);
      const row = result.rows[0];
      if (row === undefined) throw new ClientStorageConfigurationError(500, 'integration-token-write-failed');
      metadata = tokenMetadata(row, now);
      await writeAudit(client, {
        clientInternalId,
        environment: input.environment,
        eventType: 'integration-token-created',
        actorReference: clientId,
        integrationTokenId,
        safeSummary: { tokenId: input.tokenId, scopes },
      });
    });
    if (metadata === undefined) throw new ClientStorageConfigurationError(500, 'integration-token-write-failed');
    return Object.freeze({ token: rawToken, metadata });
  }

  async rotateIntegrationToken(
    clientId: string,
    environment: ClientStorageEnvironment,
    tokenId: string,
    now = new Date(),
  ): Promise<Readonly<IntegrationTokenCreationResult>> {
    const rawToken = issueIntegrationTokenValue();
    let metadata: Readonly<IntegrationTokenMetadata> | undefined;
    await withTransaction(this.#pool, async (client) => {
      const clientInternalId = await requireClient(client, clientId, true);
      const current = await client.query<TokenRow>(`
SELECT id, token_id, environment, display_label, scopes, status, expires_at, revoked_at,
       NULL::text AS rotated_from_token_id, created_at, updated_at
FROM public.storage_control_integration_tokens
WHERE storage_control_client_id = $1 AND environment = $2 AND token_id = $3
FOR UPDATE
`, [clientInternalId, environment, tokenId]);
      const row = current.rows[0];
      if (row === undefined) throw new ClientStorageConfigurationError(404, 'integration-token-not-found');
      if (tokenMetadata(row, now).status !== 'active') {
        throw new ClientStorageConfigurationError(409, 'integration-token-not-active');
      }
      await client.query(`
UPDATE public.storage_control_integration_tokens
SET status = 'revoked', revoked_at = $2, updated_at = $2
WHERE id = $1
`, [row.id, now]);
      const newId = randomUUID();
      const newTokenId = `${tokenId}-r-${randomUUID().slice(0, 8)}`;
      const inserted = await client.query<TokenRow>(`
INSERT INTO public.storage_control_integration_tokens (
  id,
  storage_control_client_id,
  environment,
  token_id,
  display_label,
  token_digest,
  scopes,
  status,
  expires_at,
  rotated_from_integration_token_id,
  created_at,
  updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], 'active', $8, $9, $10, $10)
RETURNING id, token_id, environment, display_label, scopes, status, expires_at, revoked_at,
          $11::text AS rotated_from_token_id, created_at, updated_at
`, [
        newId,
        clientInternalId,
        environment,
        newTokenId,
        row.display_label,
        digestIntegrationToken(rawToken),
        row.scopes,
        row.expires_at,
        row.id,
        now,
        tokenId,
      ]);
      const newRow = inserted.rows[0];
      if (newRow === undefined) throw new ClientStorageConfigurationError(500, 'integration-token-write-failed');
      metadata = tokenMetadata(newRow, now);
      await writeAudit(client, {
        clientInternalId,
        environment,
        eventType: 'integration-token-rotated',
        actorReference: clientId,
        integrationTokenId: newId,
        safeSummary: { previousTokenId: tokenId, tokenId: newTokenId, scopes: row.scopes },
      });
    });
    if (metadata === undefined) throw new ClientStorageConfigurationError(500, 'integration-token-write-failed');
    return Object.freeze({ token: rawToken, metadata });
  }

  async revokeIntegrationToken(
    clientId: string,
    environment: ClientStorageEnvironment,
    tokenId: string,
    now = new Date(),
  ): Promise<Readonly<IntegrationTokenMetadata>> {
    let metadata: Readonly<IntegrationTokenMetadata> | undefined;
    await withTransaction(this.#pool, async (client) => {
      const clientInternalId = await requireClient(client, clientId, true);
      const result = await client.query<TokenRow>(`
UPDATE public.storage_control_integration_tokens
SET status = 'revoked', revoked_at = COALESCE(revoked_at, $4), updated_at = $4
WHERE storage_control_client_id = $1 AND environment = $2 AND token_id = $3
RETURNING id, token_id, environment, display_label, scopes, status, expires_at, revoked_at,
          NULL::text AS rotated_from_token_id, created_at, updated_at
`, [clientInternalId, environment, tokenId, now]);
      const row = result.rows[0];
      if (row === undefined) throw new ClientStorageConfigurationError(404, 'integration-token-not-found');
      metadata = tokenMetadata(row, now);
      await writeAudit(client, {
        clientInternalId,
        environment,
        eventType: 'integration-token-revoked',
        actorReference: clientId,
        integrationTokenId: row.id,
        safeSummary: { tokenId },
      });
    });
    if (metadata === undefined) throw new ClientStorageConfigurationError(500, 'integration-token-write-failed');
    return metadata;
  }

  async authenticateIntegrationToken(
    token: string,
    requiredScope: IntegrationTokenScope,
    now = new Date(),
  ): Promise<Readonly<IntegrationTokenAuthenticationResult>> {
    const result = await this.#pool.query<TokenAuthenticationRow>(`
SELECT
  clients.client_id,
  clients.status AS client_status,
  tokens.token_id,
  tokens.environment,
  tokens.scopes,
  tokens.status AS token_status,
  tokens.expires_at
FROM public.storage_control_integration_tokens AS tokens
JOIN public.storage_control_clients AS clients
  ON clients.id = tokens.storage_control_client_id
WHERE tokens.token_digest = $1
LIMIT 1
`, [digestIntegrationToken(token)]);
    const row = result.rows[0];
    if (row === undefined || row.client_status !== 'active') return Object.freeze({ kind: 'invalid' });
    if (row.token_status === 'revoked') return Object.freeze({ kind: 'revoked' });
    if (
      row.token_status === 'expired' ||
      (row.expires_at !== null && new Date(row.expires_at).getTime() <= now.getTime())
    ) {
      return Object.freeze({ kind: 'expired' });
    }
    if (!row.scopes.includes(requiredScope)) return Object.freeze({ kind: 'scope-denied' });
    return Object.freeze({
      kind: 'authenticated',
      clientId: row.client_id,
      environment: row.environment,
      tokenId: row.token_id,
      scopes: Object.freeze([...row.scopes]),
    });
  }
}
