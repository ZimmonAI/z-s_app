import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const CLIENT_STORAGE_ENVIRONMENTS = ['dev', 'staging', 'prod'] as const;
export type ClientStorageEnvironment = (typeof CLIENT_STORAGE_ENVIRONMENTS)[number];
export const INTEGRATION_TOKEN_SCOPES = [
  'object:write',
  'object:read',
  'object:manage',
] as const;
export type IntegrationTokenScope = (typeof INTEGRATION_TOKEN_SCOPES)[number];
export type ConfigurationVersionState = 'draft' | 'active' | 'superseded';
export type ConfigurationValidationState = 'unvalidated' | 'valid' | 'invalid';

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const SECRET_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_METADATA_PROHIBITED_KEY =
  /(credential|secret|password|token|endpoint|access.?key|private.?key|connection.?string|signed.?url)/i;

export class ClientStorageConfigurationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = 'ClientStorageConfigurationError';
    this.status = status;
    this.code = code;
  }
}

export interface ProviderConnectionInput {
  readonly connectionId: string;
  readonly displayLabel: string;
  readonly providerType: 'minio' | 'r2' | 's3-compatible';
  readonly secretReferenceId: string;
  readonly safeMetadata?: Readonly<Record<string, unknown>>;
}

export interface ConfigurationVaultInput {
  readonly vaultId: string;
  readonly providerConnectionId: string;
  readonly displayLabel: string;
  readonly purpose: 'originals' | 'hot-copy' | 'derivatives' | 'archive' | 'custom';
  readonly bucketLabel: string;
  readonly prefixTemplate: string;
  readonly retention:
    | Readonly<{ mode: 'permanent' }>
    | Readonly<{ mode: 'delete-after-days'; deleteAfterDays: number }>;
}

export interface ConfigurationRouteTargetInput {
  readonly role: 'primary' | 'replica';
  readonly vaultId: string;
}

export interface ConfigurationRouteInput {
  readonly routeId: string;
  readonly assetClass: 'image' | 'video' | 'document';
  readonly targets: readonly ConfigurationRouteTargetInput[];
  readonly imagePresetId?: string;
}

export interface ConfigurationImagePresetInput {
  readonly presetId: string;
  readonly targetVaultId: string;
  readonly widths: readonly number[];
  readonly outputFormat: 'webp' | 'avif' | 'jpeg' | 'png';
  readonly quality: number;
  readonly fit: 'inside' | 'cover' | 'contain' | 'fill';
}

export interface ConfigurationDraftDocument {
  readonly providerConnections: readonly ProviderConnectionInput[];
  readonly vaults: readonly ConfigurationVaultInput[];
  readonly routes: readonly ConfigurationRouteInput[];
  readonly imagePresets: readonly ConfigurationImagePresetInput[];
}

export interface CreateConfigurationDraftInput extends ConfigurationDraftDocument {
  readonly environment: ClientStorageEnvironment;
}

export interface ProviderConnectionSnapshot extends ProviderConnectionInput {
  readonly id: string;
  readonly environment: ClientStorageEnvironment;
  readonly status: 'active' | 'disabled';
}

export interface ConfigurationVersionSnapshot extends ConfigurationDraftDocument {
  readonly id: string;
  readonly environment: ClientStorageEnvironment;
  readonly versionNumber: number;
  readonly state: ConfigurationVersionState;
  readonly validationState: ConfigurationValidationState;
  readonly validationErrors: readonly string[];
  readonly clonedFromVersionId?: string;
  readonly activatedAt?: string;
  readonly supersededAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ClientStorageOverview {
  readonly environment: ClientStorageEnvironment;
  readonly activeVersion?: Readonly<Pick<
    ConfigurationVersionSnapshot,
    'id' | 'versionNumber' | 'state' | 'activatedAt'
  >>;
  readonly draftVersions: readonly Readonly<Pick<
    ConfigurationVersionSnapshot,
    'id' | 'versionNumber' | 'state' | 'validationState' | 'updatedAt'
  >>[];
  readonly providerConnectionCount: number;
  readonly integrationTokenCount: number;
}

export interface IntegrationTokenMetadata {
  readonly id: string;
  readonly tokenId: string;
  readonly environment: ClientStorageEnvironment;
  readonly displayLabel: string;
  readonly scopes: readonly IntegrationTokenScope[];
  readonly status: 'active' | 'revoked' | 'expired';
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly rotatedFromTokenId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IntegrationTokenCreationResult {
  readonly token: string;
  readonly metadata: Readonly<IntegrationTokenMetadata>;
}

export type IntegrationTokenAuthenticationResult =
  | Readonly<{
    kind: 'authenticated';
    clientId: string;
    environment: ClientStorageEnvironment;
    tokenId: string;
    scopes: readonly IntegrationTokenScope[];
  }>
  | Readonly<{ kind: 'invalid' | 'expired' | 'revoked' | 'scope-denied' | 'not-configured' }>;

export interface ClientStorageConfigurationStore {
  readonly configured: boolean;
  overview(
    clientId: string,
    environment: ClientStorageEnvironment,
  ): Promise<Readonly<ClientStorageOverview>>;
  createDraft(
    clientId: string,
    input: Readonly<CreateConfigurationDraftInput>,
    now?: Date,
    clonedFromVersionId?: string,
  ): Promise<Readonly<ConfigurationVersionSnapshot>>;
  readVersion(
    clientId: string,
    environment: ClientStorageEnvironment,
    versionId: string,
  ): Promise<Readonly<ConfigurationVersionSnapshot>>;
  replaceDraft(
    clientId: string,
    environment: ClientStorageEnvironment,
    versionId: string,
    input: Readonly<ConfigurationDraftDocument>,
    now?: Date,
  ): Promise<Readonly<ConfigurationVersionSnapshot>>;
  deleteDraft(
    clientId: string,
    environment: ClientStorageEnvironment,
    versionId: string,
  ): Promise<void>;
  activateDraft(
    clientId: string,
    environment: ClientStorageEnvironment,
    versionId: string,
    now?: Date,
  ): Promise<Readonly<ConfigurationVersionSnapshot>>;
  cloneVersion(
    clientId: string,
    environment: ClientStorageEnvironment,
    versionId: string,
    now?: Date,
  ): Promise<Readonly<ConfigurationVersionSnapshot>>;
  listIntegrationTokens(
    clientId: string,
    environment: ClientStorageEnvironment,
    now?: Date,
  ): Promise<readonly Readonly<IntegrationTokenMetadata>[]>;
  createIntegrationToken(
    clientId: string,
    input: Readonly<{
      environment: ClientStorageEnvironment;
      tokenId: string;
      displayLabel: string;
      scopes: readonly IntegrationTokenScope[];
      expiresAt?: Date;
    }>,
    now?: Date,
  ): Promise<Readonly<IntegrationTokenCreationResult>>;
  rotateIntegrationToken(
    clientId: string,
    environment: ClientStorageEnvironment,
    tokenId: string,
    now?: Date,
  ): Promise<Readonly<IntegrationTokenCreationResult>>;
  revokeIntegrationToken(
    clientId: string,
    environment: ClientStorageEnvironment,
    tokenId: string,
    now?: Date,
  ): Promise<Readonly<IntegrationTokenMetadata>>;
  authenticateIntegrationToken(
    token: string,
    requiredScope: IntegrationTokenScope,
    now?: Date,
  ): Promise<Readonly<IntegrationTokenAuthenticationResult>>;
}

interface StoredVersion {
  clientId: string;
  snapshot: ConfigurationVersionSnapshot;
}

interface StoredIntegrationToken {
  clientId: string;
  digest: string;
  metadata: IntegrationTokenMetadata;
}

function iso(date: Date): string {
  return date.toISOString();
}

function assertIdentifier(value: string, code: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) throw new ClientStorageConfigurationError(400, code);
}

function assertLabel(value: string, code: string): void {
  if (value.trim().length < 1 || value.length > 160) {
    throw new ClientStorageConfigurationError(400, code);
  }
}

function assertSafeMetadata(value: unknown, path = 'safeMetadata'): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClientStorageConfigurationError(400, 'invalid-safe-metadata');
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 4096) {
    throw new ClientStorageConfigurationError(400, 'safe-metadata-too-large');
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SAFE_METADATA_PROHIBITED_KEY.test(key)) {
      throw new ClientStorageConfigurationError(400, 'unsafe-metadata-key');
    }
    if (nested !== null && typeof nested === 'object') {
      if (Array.isArray(nested)) {
        for (const item of nested) {
          if (item !== null && typeof item === 'object') assertSafeMetadata(item, `${path}.${key}`);
        }
      } else {
        assertSafeMetadata(nested, `${path}.${key}`);
      }
    }
  }
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export function validateConfigurationDraft(
  input: Readonly<ConfigurationDraftDocument>,
): readonly string[] {
  const errors: string[] = [];
  const connectionIds = input.providerConnections.map((connection) => connection.connectionId);
  const vaultIds = input.vaults.map((vault) => vault.vaultId);
  const presetIds = input.imagePresets.map((preset) => preset.presetId);
  const routeIds = input.routes.map((route) => route.routeId);

  if (!unique(connectionIds)) errors.push('duplicate-provider-connection-id');
  if (!unique(vaultIds)) errors.push('duplicate-vault-id');
  if (!unique(presetIds)) errors.push('duplicate-image-preset-id');
  if (!unique(routeIds)) errors.push('duplicate-route-id');
  if (!unique(input.routes.map((route) => route.assetClass))) errors.push('duplicate-asset-class-route');

  for (const connection of input.providerConnections) {
    if (!IDENTIFIER_PATTERN.test(connection.connectionId)) errors.push('invalid-provider-connection-id');
    if (connection.displayLabel.trim().length < 1 || connection.displayLabel.length > 160) {
      errors.push('invalid-provider-connection-label');
    }
    if (!SECRET_REFERENCE_PATTERN.test(connection.secretReferenceId)) {
      errors.push('invalid-secret-reference-id');
    }
    try {
      assertSafeMetadata(connection.safeMetadata ?? {});
    } catch (error) {
      errors.push(error instanceof ClientStorageConfigurationError ? error.code : 'invalid-safe-metadata');
    }
  }

  const connectionSet = new Set(connectionIds);
  const vaultSet = new Set(vaultIds);
  const presetSet = new Set(presetIds);
  for (const vault of input.vaults) {
    if (!IDENTIFIER_PATTERN.test(vault.vaultId)) errors.push('invalid-vault-id');
    if (!connectionSet.has(vault.providerConnectionId)) errors.push('unknown-provider-connection');
    if (vault.displayLabel.trim().length < 1 || vault.displayLabel.length > 160) {
      errors.push('invalid-vault-label');
    }
    if (
      vault.bucketLabel.length < 1 ||
      vault.bucketLabel.length > 255 ||
      vault.bucketLabel !== vault.bucketLabel.toLowerCase() ||
      /\s/.test(vault.bucketLabel)
    ) {
      errors.push('invalid-bucket-label');
    }
    if (
      !vault.prefixTemplate.endsWith('/*') ||
      vault.prefixTemplate.startsWith('/') ||
      vault.prefixTemplate.includes('..') ||
      vault.prefixTemplate.includes('\\')
    ) {
      errors.push('invalid-prefix-template');
    }
    if (
      vault.retention.mode === 'delete-after-days' &&
      (!Number.isSafeInteger(vault.retention.deleteAfterDays) ||
        vault.retention.deleteAfterDays < 1 ||
        vault.retention.deleteAfterDays > 36500)
    ) {
      errors.push('invalid-delete-after-days');
    }
  }

  for (const preset of input.imagePresets) {
    if (!IDENTIFIER_PATTERN.test(preset.presetId)) errors.push('invalid-image-preset-id');
    if (!vaultSet.has(preset.targetVaultId)) errors.push('unknown-image-preset-vault');
    if (
      preset.widths.length < 1 ||
      preset.widths.length > 8 ||
      !unique(preset.widths.map(String)) ||
      preset.widths.some((width) => !Number.isSafeInteger(width) || width < 16 || width > 16384)
    ) {
      errors.push('invalid-image-preset-widths');
    }
    if (!Number.isSafeInteger(preset.quality) || preset.quality < 1 || preset.quality > 100) {
      errors.push('invalid-image-preset-quality');
    }
  }

  for (const route of input.routes) {
    if (!IDENTIFIER_PATTERN.test(route.routeId)) errors.push('invalid-route-id');
    const primaryTargets = route.targets.filter((target) => target.role === 'primary');
    const replicaTargets = route.targets.filter((target) => target.role === 'replica');
    if (primaryTargets.length !== 1) errors.push('route-primary-required');
    if (route.targets.length > 33) errors.push('too-many-route-targets');
    if (!unique(route.targets.map((target) => target.vaultId))) errors.push('duplicate-route-vault');
    if (route.targets.some((target) => !vaultSet.has(target.vaultId))) {
      errors.push('unknown-route-vault');
    }
    if (replicaTargets.length > 32) errors.push('too-many-route-replicas');
    if (route.assetClass !== 'image' && route.imagePresetId !== undefined) {
      errors.push('image-preset-on-non-image-route');
    }
    if (route.imagePresetId !== undefined && !presetSet.has(route.imagePresetId)) {
      errors.push('unknown-route-image-preset');
    }
  }

  return Object.freeze([...new Set(errors)]);
}

export function assertConfigurationDraftInput(input: Readonly<ConfigurationDraftDocument>): void {
  if (
    !Array.isArray(input.providerConnections) ||
    !Array.isArray(input.vaults) ||
    !Array.isArray(input.routes) ||
    !Array.isArray(input.imagePresets)
  ) {
    throw new ClientStorageConfigurationError(400, 'invalid-configuration-document');
  }
  for (const connection of input.providerConnections) {
    assertIdentifier(connection.connectionId, 'invalid-provider-connection-id');
    assertLabel(connection.displayLabel, 'invalid-provider-connection-label');
    if (!SECRET_REFERENCE_PATTERN.test(connection.secretReferenceId)) {
      throw new ClientStorageConfigurationError(400, 'invalid-secret-reference-id');
    }
    assertSafeMetadata(connection.safeMetadata ?? {});
  }
}

export function normalizeIntegrationTokenScopes(
  scopes: readonly IntegrationTokenScope[],
): readonly IntegrationTokenScope[] {
  if (scopes.length < 1 || scopes.length > INTEGRATION_TOKEN_SCOPES.length) {
    throw new ClientStorageConfigurationError(400, 'invalid-integration-token-scopes');
  }
  const allowed = new Set<string>(INTEGRATION_TOKEN_SCOPES);
  const normalized = [...new Set(scopes)];
  if (normalized.some((scope) => !allowed.has(scope))) {
    throw new ClientStorageConfigurationError(400, 'invalid-integration-token-scopes');
  }
  return Object.freeze(normalized);
}

export function issueIntegrationTokenValue(): string {
  return `zs_it_${randomBytes(32).toString('base64url')}`;
}

export function digestIntegrationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function cloneDocument(input: Readonly<ConfigurationDraftDocument>): ConfigurationDraftDocument {
  return structuredClone({
    providerConnections: input.providerConnections,
    vaults: input.vaults,
    routes: input.routes,
    imagePresets: input.imagePresets,
  }) as ConfigurationDraftDocument;
}

function publicTokenMetadata(
  metadata: Readonly<IntegrationTokenMetadata>,
  now: Date,
): Readonly<IntegrationTokenMetadata> {
  if (
    metadata.status === 'active' &&
    metadata.expiresAt !== undefined &&
    new Date(metadata.expiresAt).getTime() <= now.getTime()
  ) {
    return Object.freeze({ ...metadata, status: 'expired' });
  }
  return Object.freeze({ ...metadata, scopes: Object.freeze([...metadata.scopes]) });
}

export class InMemoryClientStorageConfigurationStore
implements ClientStorageConfigurationStore {
  readonly configured = true;
  readonly #versions = new Map<string, StoredVersion>();
  readonly #tokens = new Map<string, StoredIntegrationToken>();
  readonly #clients = new Set<string>();

  registerClient(clientId: string): void {
    assertIdentifier(clientId, 'invalid-client-id');
    this.#clients.add(clientId);
  }

  #assertClient(clientId: string): void {
    if (!this.#clients.has(clientId)) {
      throw new ClientStorageConfigurationError(404, 'client-storage-not-found');
    }
  }

  #version(clientId: string, environment: ClientStorageEnvironment, versionId: string): StoredVersion {
    const version = this.#versions.get(versionId);
    if (
      version === undefined ||
      version.clientId !== clientId ||
      version.snapshot.environment !== environment
    ) {
      throw new ClientStorageConfigurationError(404, 'configuration-version-not-found');
    }
    return version;
  }

  async overview(
    clientId: string,
    environment: ClientStorageEnvironment,
  ): Promise<Readonly<ClientStorageOverview>> {
    this.#assertClient(clientId);
    const versions = [...this.#versions.values()]
      .filter((entry) => entry.clientId === clientId && entry.snapshot.environment === environment)
      .map((entry) => entry.snapshot);
    const active = versions.find((version) => version.state === 'active');
    const providerConnections = new Set(
      versions.flatMap((version) => version.providerConnections.map((connection) => connection.connectionId)),
    );
    const tokenCount = [...this.#tokens.values()].filter(
      (entry) => entry.clientId === clientId && entry.metadata.environment === environment,
    ).length;
    return Object.freeze({
      environment,
      ...(active === undefined
        ? {}
        : {
          activeVersion: Object.freeze({
            id: active.id,
            versionNumber: active.versionNumber,
            state: active.state,
            ...(active.activatedAt === undefined ? {} : { activatedAt: active.activatedAt }),
          }),
        }),
      draftVersions: Object.freeze(
        versions
          .filter((version) => version.state === 'draft')
          .sort((left, right) => right.versionNumber - left.versionNumber)
          .map((version) => Object.freeze({
            id: version.id,
            versionNumber: version.versionNumber,
            state: version.state,
            validationState: version.validationState,
            updatedAt: version.updatedAt,
          })),
      ),
      providerConnectionCount: providerConnections.size,
      integrationTokenCount: tokenCount,
    });
  }

  async createDraft(
    clientId: string,
    input: Readonly<CreateConfigurationDraftInput>,
    now = new Date(),
    clonedFromVersionId?: string,
  ): Promise<Readonly<ConfigurationVersionSnapshot>> {
    this.#assertClient(clientId);
    assertConfigurationDraftInput(input);
    const validationErrors = validateConfigurationDraft(input);
    const versionNumber = Math.max(
      0,
      ...[...this.#versions.values()]
        .filter((entry) => entry.clientId === clientId && entry.snapshot.environment === input.environment)
        .map((entry) => entry.snapshot.versionNumber),
    ) + 1;
    const timestamp = iso(now);
    const document = cloneDocument(input);
    const snapshot: ConfigurationVersionSnapshot = Object.freeze({
      id: randomUUID(),
      environment: input.environment,
      versionNumber,
      state: 'draft',
      validationState: validationErrors.length === 0 ? 'valid' : 'invalid',
      validationErrors,
      ...(clonedFromVersionId === undefined ? {} : { clonedFromVersionId }),
      createdAt: timestamp,
      updatedAt: timestamp,
      ...document,
    });
    this.#versions.set(snapshot.id, { clientId, snapshot });
    return snapshot;
  }

  async readVersion(
    clientId: string,
    environment: ClientStorageEnvironment,
    versionId: string,
  ): Promise<Readonly<ConfigurationVersionSnapshot>> {
    this.#assertClient(clientId);
    return this.#version(clientId, environment, versionId).snapshot;
  }

  async replaceDraft(
    clientId: string,
    environment: ClientStorageEnvironment,
    versionId: string,
    input: Readonly<ConfigurationDraftDocument>,
    now = new Date(),
  ): Promise<Readonly<ConfigurationVersionSnapshot>> {
    this.#assertClient(clientId);
    assertConfigurationDraftInput(input);
    const entry = this.#version(clientId, environment, versionId);
    if (entry.snapshot.state !== 'draft') {
      throw new ClientStorageConfigurationError(409, 'configuration-version-immutable');
    }
    const validationErrors = validateConfigurationDraft(input);
    const document = cloneDocument(input);
    const snapshot: ConfigurationVersionSnapshot = Object.freeze({
      ...entry.snapshot,
      ...document,
      validationState: validationErrors.length === 0 ? 'valid' : 'invalid',
      validationErrors,
      updatedAt: iso(now),
    });
    this.#versions.set(versionId, { clientId, snapshot });
    return snapshot;
  }

  async deleteDraft(
    clientId: string,
    environment: ClientStorageEnvironment,
    versionId: string,
  ): Promise<void> {
    this.#assertClient(clientId);
    const entry = this.#version(clientId, environment, versionId);
    if (entry.snapshot.state !== 'draft') {
      throw new ClientStorageConfigurationError(409, 'configuration-version-immutable');
    }
    this.#versions.delete(versionId);
  }

  async activateDraft(
    clientId: string,
    environment: ClientStorageEnvironment,
    versionId: string,
    now = new Date(),
  ): Promise<Readonly<ConfigurationVersionSnapshot>> {
    this.#assertClient(clientId);
    const entry = this.#version(clientId, environment, versionId);
    if (entry.snapshot.state !== 'draft') {
      throw new ClientStorageConfigurationError(409, 'configuration-version-immutable');
    }
    const validationErrors = validateConfigurationDraft(entry.snapshot);
    if (validationErrors.length > 0) {
      throw new ClientStorageConfigurationError(409, 'configuration-version-invalid');
    }
    const timestamp = iso(now);
    const activeEntry = [...this.#versions.values()].find(
      (candidate) =>
        candidate.clientId === clientId &&
        candidate.snapshot.environment === environment &&
        candidate.snapshot.state === 'active',
    );
    if (activeEntry !== undefined) {
      activeEntry.snapshot = Object.freeze({
        ...activeEntry.snapshot,
        state: 'superseded',
        supersededAt: timestamp,
        updatedAt: timestamp,
      });
    }
    entry.snapshot = Object.freeze({
      ...entry.snapshot,
      state: 'active',
      validationState: 'valid',
      validationErrors: Object.freeze([]),
      activatedAt: timestamp,
      updatedAt: timestamp,
    });
    return entry.snapshot;
  }

  async cloneVersion(
    clientId: string,
    environment: ClientStorageEnvironment,
    versionId: string,
    now = new Date(),
  ): Promise<Readonly<ConfigurationVersionSnapshot>> {
    this.#assertClient(clientId);
    const source = this.#version(clientId, environment, versionId).snapshot;
    return this.createDraft(clientId, {
      environment,
      ...cloneDocument(source),
    }, now, source.id);
  }

  async listIntegrationTokens(
    clientId: string,
    environment: ClientStorageEnvironment,
    now = new Date(),
  ): Promise<readonly Readonly<IntegrationTokenMetadata>[]> {
    this.#assertClient(clientId);
    return Object.freeze(
      [...this.#tokens.values()]
        .filter((entry) => entry.clientId === clientId && entry.metadata.environment === environment)
        .map((entry) => publicTokenMetadata(entry.metadata, now))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    );
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
    this.#assertClient(clientId);
    assertIdentifier(input.tokenId, 'invalid-integration-token-id');
    assertLabel(input.displayLabel, 'invalid-integration-token-label');
    const scopes = normalizeIntegrationTokenScopes(input.scopes);
    if (input.expiresAt !== undefined && input.expiresAt.getTime() <= now.getTime()) {
      throw new ClientStorageConfigurationError(400, 'invalid-integration-token-expiry');
    }
    if (
      [...this.#tokens.values()].some(
        (entry) =>
          entry.clientId === clientId &&
          entry.metadata.environment === input.environment &&
          entry.metadata.tokenId === input.tokenId,
      )
    ) {
      throw new ClientStorageConfigurationError(409, 'integration-token-id-conflict');
    }
    const rawToken = issueIntegrationTokenValue();
    const timestamp = iso(now);
    const metadata: IntegrationTokenMetadata = Object.freeze({
      id: randomUUID(),
      tokenId: input.tokenId,
      environment: input.environment,
      displayLabel: input.displayLabel,
      scopes,
      status: 'active',
      ...(input.expiresAt === undefined ? {} : { expiresAt: iso(input.expiresAt) }),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.#tokens.set(metadata.id, {
      clientId,
      digest: digestIntegrationToken(rawToken),
      metadata,
    });
    return Object.freeze({ token: rawToken, metadata });
  }

  async rotateIntegrationToken(
    clientId: string,
    environment: ClientStorageEnvironment,
    tokenId: string,
    now = new Date(),
  ): Promise<Readonly<IntegrationTokenCreationResult>> {
    this.#assertClient(clientId);
    const current = [...this.#tokens.values()].find(
      (entry) =>
        entry.clientId === clientId &&
        entry.metadata.environment === environment &&
        entry.metadata.tokenId === tokenId,
    );
    if (current === undefined) {
      throw new ClientStorageConfigurationError(404, 'integration-token-not-found');
    }
    if (publicTokenMetadata(current.metadata, now).status !== 'active') {
      throw new ClientStorageConfigurationError(409, 'integration-token-not-active');
    }
    const timestamp = iso(now);
    current.metadata = Object.freeze({
      ...current.metadata,
      status: 'revoked',
      revokedAt: timestamp,
      updatedAt: timestamp,
    });
    const rawToken = issueIntegrationTokenValue();
    const metadata: IntegrationTokenMetadata = Object.freeze({
      id: randomUUID(),
      tokenId: `${tokenId}-r-${randomUUID().slice(0, 8)}`,
      environment,
      displayLabel: current.metadata.displayLabel,
      scopes: current.metadata.scopes,
      status: 'active',
      ...(current.metadata.expiresAt === undefined ? {} : { expiresAt: current.metadata.expiresAt }),
      rotatedFromTokenId: tokenId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.#tokens.set(metadata.id, {
      clientId,
      digest: digestIntegrationToken(rawToken),
      metadata,
    });
    return Object.freeze({ token: rawToken, metadata });
  }

  async revokeIntegrationToken(
    clientId: string,
    environment: ClientStorageEnvironment,
    tokenId: string,
    now = new Date(),
  ): Promise<Readonly<IntegrationTokenMetadata>> {
    this.#assertClient(clientId);
    const current = [...this.#tokens.values()].find(
      (entry) =>
        entry.clientId === clientId &&
        entry.metadata.environment === environment &&
        entry.metadata.tokenId === tokenId,
    );
    if (current === undefined) {
      throw new ClientStorageConfigurationError(404, 'integration-token-not-found');
    }
    if (current.metadata.status === 'revoked') return current.metadata;
    const timestamp = iso(now);
    current.metadata = Object.freeze({
      ...current.metadata,
      status: 'revoked',
      revokedAt: timestamp,
      updatedAt: timestamp,
    });
    return current.metadata;
  }

  async authenticateIntegrationToken(
    token: string,
    requiredScope: IntegrationTokenScope,
    now = new Date(),
  ): Promise<Readonly<IntegrationTokenAuthenticationResult>> {
    const digest = digestIntegrationToken(token);
    const current = [...this.#tokens.values()].find((entry) => entry.digest === digest);
    if (current === undefined) return Object.freeze({ kind: 'invalid' });
    const metadata = publicTokenMetadata(current.metadata, now);
    if (metadata.status === 'expired') return Object.freeze({ kind: 'expired' });
    if (metadata.status === 'revoked') return Object.freeze({ kind: 'revoked' });
    if (!metadata.scopes.includes(requiredScope)) return Object.freeze({ kind: 'scope-denied' });
    return Object.freeze({
      kind: 'authenticated',
      clientId: current.clientId,
      environment: metadata.environment,
      tokenId: metadata.tokenId,
      scopes: metadata.scopes,
    });
  }
}

export function createUnavailableClientStorageConfigurationStore(): ClientStorageConfigurationStore {
  const unavailable = async (): Promise<never> => {
    throw new ClientStorageConfigurationError(503, 'client-storage-configuration-not-configured');
  };
  return Object.freeze({
    configured: false,
    overview: unavailable,
    createDraft: unavailable,
    readVersion: unavailable,
    replaceDraft: unavailable,
    deleteDraft: unavailable,
    activateDraft: unavailable,
    cloneVersion: unavailable,
    listIntegrationTokens: unavailable,
    createIntegrationToken: unavailable,
    rotateIntegrationToken: unavailable,
    revokeIntegrationToken: unavailable,
    async authenticateIntegrationToken(): Promise<Readonly<IntegrationTokenAuthenticationResult>> {
      return Object.freeze({ kind: 'not-configured' });
    },
  });
}
