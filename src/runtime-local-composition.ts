import { timingSafeEqual } from 'node:crypto';
import {
  Pool,
  type PoolClient,
  type PoolConfig,
} from 'pg';
import {
  createSafeFingerprint,
  createSafeFingerprintPayload,
} from './fingerprint.js';
import type {
  CallerIdentity,
  DependencyReadiness,
  HttpStorageRuntime,
  SafeDiagnosticCategory,
  SafeResolvedStorageProfile,
  StorageProfileRequest,
} from './runtime-contract.js';
import {
  DualProviderObjectIngestAdapter,
  type ProviderWriteTargetResolver,
} from './runtime-dual-provider.js';
import {
  createObjectIngestRuntime,
  type ResolvedObjectWriteAuthority,
} from './runtime-ingest.js';
import {
  BoundedMediaVerifier,
  type MediaVerificationAdapter,
} from './runtime-media-verification.js';
import {
  ObjectReadDeliveryCoordinator,
  S3CompatibleProviderObjectReader,
  type ProviderObjectReader,
} from './runtime-read-delivery.js';
import {
  PostgresObjectReadRegistry,
  createDeterministicObjectReadGrantTokenService,
  createReadEnabledHttpStorageRuntime,
  type ObjectReadGrantTokenService,
} from './runtime-read-grant.js';
import {
  type ProviderCredentialResolver,
  type ProviderObjectWriter,
  type ResolvedProviderWriteTarget,
  type ResolvedS3CredentialBinding,
  S3CompatibleProviderObjectWriter,
} from './runtime-s3-provider.js';
import {
  PostgresRuntimeStorageRegistry,
  createRuntimeStorageDuplicateResultCodec,
  type PostgresClientLike,
  type PostgresPoolLike,
} from './runtime-storage-registry.js';
import {
  createDeterministicUploadCompletionTokenService,
  type UploadCompletionTokenService,
} from './runtime-upload-token.js';

const DEVELOPMENT_AUTHORITY = Object.freeze({
  callerAppId: 'video-maker_app',
  callerServiceId: 'api',
  environment: 'dev',
  profileId: 'video-maker-dev-default',
  profileVersion: 1,
  prefixClassId: 'user-resources',
  normalizedPrefixPattern: 'video-maker/user-resources/*',
  hotProviderId: 'r2_video_maker_dev_01',
  canonicalProviderId: 'minio_zimspace_local_pc_01',
  allowedMediaTypes: Object.freeze(['image/png', 'video/mp4']),
  maximumByteLength: 32 * 1024 * 1024,
  intentTtlSeconds: 900 as const,
});

const REQUIRED_CAPABILITIES = Object.freeze([
  'put',
  'head',
  'get',
  'delete',
  'checksum',
] as const);
const PROVIDER_ROLES = Object.freeze(['hot', 'canonical'] as const);
const DEFAULT_POOL_MAXIMUM = 8;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const AUTHORITY_CACHE_TTL_MS = 5_000;

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
type ProviderRole = (typeof PROVIDER_ROLES)[number];
type Capability = (typeof REQUIRED_CAPABILITIES)[number] | 'size' | 'range';

export class RuntimeCompositionError extends Error {
  readonly category: SafeDiagnosticCategory;
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    category: SafeDiagnosticCategory,
    code: string,
    status: number,
    retryable = false,
  ) {
    super(code);
    this.name = 'RuntimeCompositionError';
    this.category = category;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function unavailable(code: string): RuntimeCompositionError {
  return new RuntimeCompositionError('dependency-unavailable', code, 503, true);
}

function safeString(value: unknown, maximum = 256): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum) return null;
  return normalized;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError('Invalid bounded runtime integer configuration.');
  }
  return parsed;
}

function parseBoolean(value: string | undefined): boolean | null {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function tokenReady(value: string | undefined): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 4096;
}

function constantTimeTokenEquals(left: string, right: string | undefined): boolean {
  if (left.length > 4096 || !tokenReady(right)) return false;
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function adaptClient(client: PoolClient): PostgresClientLike {
  return {
    query: async <Row extends Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) => {
      const result = await client.query<Row>(text, values as unknown[] | undefined);
      return Object.freeze({ rows: result.rows, rowCount: result.rowCount });
    },
    release: () => client.release(),
  };
}

export function adaptPostgresPool(pool: Pool): PostgresPoolLike {
  return Object.freeze({
    connect: async () => adaptClient(await pool.connect()),
  });
}

interface PoolResource {
  readonly pool: PostgresPoolLike;
  close(): Promise<void>;
  readonly configured: boolean;
}

function createPoolResource(environment: RuntimeEnvironment): PoolResource {
  const connectionString = safeString(environment.Z_S_POSTGRES_URL, 4096);
  if (connectionString === null) {
    return Object.freeze({
      pool: Object.freeze({
        connect: async () => {
          throw unavailable('postgres-configuration-unavailable');
        },
      }),
      close: async () => undefined,
      configured: false,
    });
  }
  const sslMode = environment.Z_S_POSTGRES_SSL_MODE?.trim() || 'disable';
  if (sslMode !== 'disable' && sslMode !== 'require') {
    throw new TypeError('Z_S_POSTGRES_SSL_MODE must be disable or require.');
  }
  const config: PoolConfig = {
    connectionString,
    max: boundedInteger(environment.Z_S_POSTGRES_POOL_MAX, DEFAULT_POOL_MAXIMUM, 1, 32),
    idleTimeoutMillis: boundedInteger(
      environment.Z_S_POSTGRES_IDLE_TIMEOUT_MS,
      DEFAULT_IDLE_TIMEOUT_MS,
      1_000,
      300_000,
    ),
    connectionTimeoutMillis: boundedInteger(
      environment.Z_S_POSTGRES_CONNECTION_TIMEOUT_MS,
      DEFAULT_CONNECTION_TIMEOUT_MS,
      250,
      60_000,
    ),
    allowExitOnIdle: false,
    ...(sslMode === 'require' ? { ssl: { rejectUnauthorized: true } } : {}),
  };
  const pool = new Pool(config);
  return Object.freeze({
    pool: adaptPostgresPool(pool),
    close: async () => {
      await pool.end();
    },
    configured: true,
  });
}

interface SecretReferenceBinding {
  endpointEnv: string;
  regionEnv: string;
  forcePathStyleEnv: string;
  accessKeyIdEnv: string;
  secretAccessKeyEnv: string;
  sessionTokenEnv?: string;
}

function safeEnvironmentVariableName(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(value)
    ? value
    : null;
}

function parseSecretBindings(raw: string | undefined): ReadonlyMap<string, SecretReferenceBinding> {
  if (raw === undefined || raw.trim() === '') return new Map();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return new Map();
  const bindings = new Map<string, SecretReferenceBinding>();
  for (const [secretReferenceId, candidate] of Object.entries(value)) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(secretReferenceId) ||
      candidate === null ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      return new Map();
    }
    const record = candidate as Record<string, unknown>;
    const endpointEnv = safeEnvironmentVariableName(record.endpointEnv);
    const regionEnv = safeEnvironmentVariableName(record.regionEnv);
    const forcePathStyleEnv = safeEnvironmentVariableName(record.forcePathStyleEnv);
    const accessKeyIdEnv = safeEnvironmentVariableName(record.accessKeyIdEnv);
    const secretAccessKeyEnv = safeEnvironmentVariableName(record.secretAccessKeyEnv);
    const sessionTokenEnv =
      record.sessionTokenEnv === undefined
        ? undefined
        : safeEnvironmentVariableName(record.sessionTokenEnv);
    if (
      endpointEnv === null ||
      regionEnv === null ||
      forcePathStyleEnv === null ||
      accessKeyIdEnv === null ||
      secretAccessKeyEnv === null ||
      sessionTokenEnv === null
    ) {
      return new Map();
    }
    const binding: SecretReferenceBinding = {
      endpointEnv,
      regionEnv,
      forcePathStyleEnv,
      accessKeyIdEnv,
      secretAccessKeyEnv,
    };
    if (sessionTokenEnv !== undefined) binding.sessionTokenEnv = sessionTokenEnv;
    bindings.set(secretReferenceId, Object.freeze(binding));
  }
  return bindings;
}

export interface ReadyProviderCredentialResolver extends ProviderCredentialResolver {
  isReady(secretReferenceId: string): boolean;
}

export function createEnvironmentCredentialResolver(
  environment: RuntimeEnvironment,
): ReadyProviderCredentialResolver {
  const bindings = parseSecretBindings(environment.Z_S_PROVIDER_SECRET_BINDINGS_JSON);

  function resolveBinding(secretReferenceId: string): Readonly<ResolvedS3CredentialBinding> | null {
    const names = bindings.get(secretReferenceId);
    if (names === undefined) return null;
    const endpoint = safeString(environment[names.endpointEnv], 2048);
    const region = safeString(environment[names.regionEnv], 128);
    const forcePathStyle = parseBoolean(environment[names.forcePathStyleEnv]);
    const accessKeyId = safeString(environment[names.accessKeyIdEnv], 512);
    const secretAccessKey = safeString(environment[names.secretAccessKeyEnv], 2048);
    const sessionToken =
      names.sessionTokenEnv === undefined
        ? undefined
        : safeString(environment[names.sessionTokenEnv], 4096);
    if (
      endpoint === null ||
      region === null ||
      forcePathStyle === null ||
      accessKeyId === null ||
      secretAccessKey === null ||
      sessionToken === null
    ) {
      return null;
    }
    let endpointUrl: URL;
    try {
      endpointUrl = new URL(endpoint);
    } catch {
      return null;
    }
    if (endpointUrl.protocol !== 'http:' && endpointUrl.protocol !== 'https:') return null;
    const resolved: ResolvedS3CredentialBinding = {
      endpoint: endpointUrl.toString(),
      region,
      forcePathStyle,
      accessKeyId,
      secretAccessKey,
    };
    if (sessionToken !== undefined) resolved.sessionToken = sessionToken;
    return Object.freeze(resolved);
  }

  return Object.freeze({
    isReady: (secretReferenceId: string): boolean => resolveBinding(secretReferenceId) !== null,
    resolve: async (secretReferenceId: string) => {
      const binding = resolveBinding(secretReferenceId);
      if (binding === null) throw unavailable('provider-credential-binding-unavailable');
      return binding;
    },
  });
}

interface AuthorityRow extends Record<string, unknown> {
  managed_app_id: string;
  managed_app_status: string;
  profile_uuid: string;
  profile_status: string;
  effective_at: Date | string;
  retired_at: Date | string | null;
  prefix_uuid: string;
  prefix_status: string;
  normalized_prefix_pattern: string;
  hot_binding_id: string;
  hot_binding_required: boolean;
  hot_provider_uuid: string;
  hot_provider_id: string;
  hot_provider_status: string;
  hot_bucket_label: string;
  hot_secret_reference_id: string;
  canonical_binding_id: string;
  canonical_binding_required: boolean;
  canonical_provider_uuid: string;
  canonical_provider_id: string;
  canonical_provider_status: string;
  canonical_bucket_label: string;
  canonical_secret_reference_id: string;
}

interface CapabilityRow extends Record<string, unknown> {
  storage_provider_id: string;
  bucket_label: string;
  capability: Capability;
  result: 'passed' | 'failed' | 'not-supported';
  expires_at: Date | string | null;
}

export interface ResolvedDevelopmentAuthority {
  readonly profile: Readonly<SafeResolvedStorageProfile>;
  readonly writeAuthority: Readonly<ResolvedObjectWriteAuthority>;
  readonly providerTargets: Readonly<Record<ProviderRole, Readonly<ResolvedProviderWriteTarget>>>;
}

function dateValue(value: Date | string): number {
  const parsed = value instanceof Date ? value : new Date(value);
  return parsed.getTime();
}

function assertAuthorityRow(row: AuthorityRow | undefined, now: Date): AuthorityRow {
  if (row === undefined) throw unavailable('storage-authority-unavailable');
  const effective = dateValue(row.effective_at);
  const retired = row.retired_at === null ? null : dateValue(row.retired_at);
  if (
    row.managed_app_status !== 'active' ||
    row.profile_status !== 'active' ||
    !Number.isFinite(effective) ||
    effective > now.getTime() ||
    (retired !== null && (!Number.isFinite(retired) || retired <= now.getTime())) ||
    row.prefix_status !== 'active' ||
    row.normalized_prefix_pattern !== DEVELOPMENT_AUTHORITY.normalizedPrefixPattern ||
    row.hot_provider_id !== DEVELOPMENT_AUTHORITY.hotProviderId ||
    row.canonical_provider_id !== DEVELOPMENT_AUTHORITY.canonicalProviderId ||
    row.hot_provider_status !== 'active' ||
    row.canonical_provider_status !== 'active' ||
    row.hot_binding_required !== true ||
    row.canonical_binding_required !== true
  ) {
    throw unavailable('storage-authority-not-ready');
  }
  return row;
}

function capabilityPolicy(
  rows: readonly CapabilityRow[],
  authority: AuthorityRow,
  now: Date,
): SafeResolvedStorageProfile['capabilityPolicy'] {
  const expected = Object.freeze({
    hot: Object.freeze({
      providerId: authority.hot_provider_uuid,
      bucketLabel: authority.hot_bucket_label,
    }),
    canonical: Object.freeze({
      providerId: authority.canonical_provider_uuid,
      bucketLabel: authority.canonical_bucket_label,
    }),
  });
  let sizeUnsupported = false;
  for (const role of PROVIDER_ROLES) {
    const assignment = expected[role];
    const records = new Map<Capability, CapabilityRow>();
    for (const row of rows) {
      if (
        row.storage_provider_id === assignment.providerId &&
        row.bucket_label === assignment.bucketLabel
      ) {
        records.set(row.capability, row);
      }
    }
    for (const capability of REQUIRED_CAPABILITIES) {
      const record = records.get(capability);
      if (
        record === undefined ||
        record.result !== 'passed' ||
        (record.expires_at !== null && dateValue(record.expires_at) <= now.getTime())
      ) {
        throw unavailable('provider-capability-not-ready');
      }
    }
    const size = records.get('size');
    if (
      size === undefined ||
      (size.result !== 'passed' && size.result !== 'not-supported') ||
      (size.expires_at !== null && dateValue(size.expires_at) <= now.getTime())
    ) {
      throw unavailable('provider-capability-not-ready');
    }
    sizeUnsupported ||= size.result === 'not-supported';
    const range = records.get('range');
    if (
      range === undefined ||
      range.result !== 'passed' ||
      (range.expires_at !== null && dateValue(range.expires_at) <= now.getTime())
    ) {
      throw unavailable('provider-range-capability-not-ready');
    }
  }
  return Object.freeze({
    checksumVerification: 'required',
    sizeVerification: 'required-when-supported',
    headContentLength: sizeUnsupported ? 'optional-with-checksum' : 'required',
    rangeRead: 'required',
  });
}

export class PostgresVideoMakerAuthorityRegistry implements ProviderWriteTargetResolver {
  readonly #pool: PostgresPoolLike;
  readonly #now: () => Date;
  #cached:
    | Readonly<{ expiresAt: number; value: Promise<Readonly<ResolvedDevelopmentAuthority>> }>
    | undefined;

  constructor(options: { pool: PostgresPoolLike; now?: () => Date }) {
    this.#pool = options.pool;
    this.#now = options.now ?? (() => new Date());
  }

  async #queryAuthority(): Promise<Readonly<ResolvedDevelopmentAuthority>> {
    const client = await this.#pool.connect();
    try {
      const authorityResult = await client.query<AuthorityRow>(
        `SELECT managed_app.id AS managed_app_id,
                managed_app.status AS managed_app_status,
                profile.id AS profile_uuid,
                profile.status AS profile_status,
                profile.effective_at,
                profile.retired_at,
                prefix_class.id AS prefix_uuid,
                prefix_class.status AS prefix_status,
                prefix_class.normalized_prefix_pattern,
                hot_binding.id AS hot_binding_id,
                hot_binding.required AS hot_binding_required,
                hot_provider.id AS hot_provider_uuid,
                hot_provider.provider_id AS hot_provider_id,
                hot_provider.status AS hot_provider_status,
                hot_binding.bucket_label AS hot_bucket_label,
                hot_provider.secret_reference_id AS hot_secret_reference_id,
                canonical_binding.id AS canonical_binding_id,
                canonical_binding.required AS canonical_binding_required,
                canonical_provider.id AS canonical_provider_uuid,
                canonical_provider.provider_id AS canonical_provider_id,
                canonical_provider.status AS canonical_provider_status,
                canonical_binding.bucket_label AS canonical_bucket_label,
                canonical_provider.secret_reference_id AS canonical_secret_reference_id
           FROM public.managed_apps AS managed_app
           JOIN public.storage_profiles AS profile
             ON profile.managed_app_id = managed_app.id
           JOIN public.storage_prefix_classes AS prefix_class
             ON prefix_class.storage_profile_id = profile.id
           JOIN public.storage_profile_provider_bindings AS hot_binding
             ON hot_binding.storage_profile_id = profile.id
            AND hot_binding.provider_role = 'hot'
           JOIN public.storage_providers AS hot_provider
             ON hot_provider.id = hot_binding.storage_provider_id
           JOIN public.storage_profile_provider_bindings AS canonical_binding
             ON canonical_binding.storage_profile_id = profile.id
            AND canonical_binding.provider_role = 'canonical'
           JOIN public.storage_providers AS canonical_provider
             ON canonical_provider.id = canonical_binding.storage_provider_id
          WHERE managed_app.app_id = $1
            AND managed_app.environment = $2
            AND profile.profile_id = $3
            AND profile.version = $4
            AND prefix_class.prefix_class_id = $5
            AND hot_provider.provider_id = $6
            AND canonical_provider.provider_id = $7`,
        [
          DEVELOPMENT_AUTHORITY.callerAppId,
          DEVELOPMENT_AUTHORITY.environment,
          DEVELOPMENT_AUTHORITY.profileId,
          DEVELOPMENT_AUTHORITY.profileVersion,
          DEVELOPMENT_AUTHORITY.prefixClassId,
          DEVELOPMENT_AUTHORITY.hotProviderId,
          DEVELOPMENT_AUTHORITY.canonicalProviderId,
        ],
      );
      const now = this.#now();
      const authority = assertAuthorityRow(authorityResult.rows[0], now);
      if (authorityResult.rows.length !== 1) throw unavailable('storage-authority-ambiguous');

      const capabilities = await client.query<CapabilityRow>(
        `WITH ranked AS (
           SELECT capability_result.storage_provider_id,
                  capability_result.bucket_label,
                  capability_result.capability,
                  capability_result.result,
                  capability_result.expires_at,
                  row_number() OVER (
                    PARTITION BY capability_result.storage_provider_id,
                                 capability_result.bucket_label,
                                 capability_result.capability
                    ORDER BY capability_result.verified_at DESC,
                             capability_result.created_at DESC
                  ) AS result_rank
             FROM public.storage_capability_results AS capability_result
            WHERE capability_result.storage_profile_id = $1
              AND capability_result.prefix_class_id = $2
              AND capability_result.storage_provider_id = ANY($3::uuid[])
              AND capability_result.bucket_label = ANY($4::text[])
         )
         SELECT storage_provider_id, bucket_label, capability, result, expires_at
           FROM ranked
          WHERE result_rank = 1`,
        [
          authority.profile_uuid,
          DEVELOPMENT_AUTHORITY.prefixClassId,
          [authority.hot_provider_uuid, authority.canonical_provider_uuid],
          [authority.hot_bucket_label, authority.canonical_bucket_label],
        ],
      );
      const policy = capabilityPolicy(capabilities.rows, authority, now);
      const safeFingerprint = createSafeFingerprint(
        createSafeFingerprintPayload({
          appId: DEVELOPMENT_AUTHORITY.callerAppId,
          environment: DEVELOPMENT_AUTHORITY.environment,
          profileId: DEVELOPMENT_AUTHORITY.profileId,
          profileVersion: DEVELOPMENT_AUTHORITY.profileVersion,
          hotProvider: {
            providerId: authority.hot_provider_id,
            bucketLabel: authority.hot_bucket_label,
          },
          canonicalProvider: {
            providerId: authority.canonical_provider_id,
            bucketLabel: authority.canonical_bucket_label,
          },
          prefixClassId: DEVELOPMENT_AUTHORITY.prefixClassId,
        }),
      );
      const writePolicy = Object.freeze({
        uploadMode: 'server-streamed-single-object' as const,
        allowedMediaTypes: DEVELOPMENT_AUTHORITY.allowedMediaTypes,
        maxByteLength: DEVELOPMENT_AUTHORITY.maximumByteLength,
        intentTtlSeconds: DEVELOPMENT_AUTHORITY.intentTtlSeconds,
      });
      const profile: SafeResolvedStorageProfile = Object.freeze({
        profileId: DEVELOPMENT_AUTHORITY.profileId,
        profileVersion: DEVELOPMENT_AUTHORITY.profileVersion,
        environment: DEVELOPMENT_AUTHORITY.environment,
        active: true,
        ready: true,
        safeFingerprint,
        capabilityPolicy: policy,
        capabilities: Object.freeze({
          objectWriteIntent: true,
          objectReadGrant: true,
          objectDeleteRequest: false,
          objectRepairOperation: false,
        }),
        protectionStages: Object.freeze([
          'write-intent-created',
          'canonical-and-hot-verified',
          'canonical-verified-hot-repair-required',
          'hot-verified-canonical-repair-required',
        ]),
        writePolicy,
      });
      const writeAuthority: ResolvedObjectWriteAuthority = Object.freeze({
        managedAppId: authority.managed_app_id,
        callerServiceId: DEVELOPMENT_AUTHORITY.callerServiceId,
        storageProfileId: authority.profile_uuid,
        storageProfileVersion: DEVELOPMENT_AUTHORITY.profileVersion,
        storageProfileFingerprint: safeFingerprint,
        storagePrefixClassId: authority.prefix_uuid,
        normalizedPrefixPattern: authority.normalized_prefix_pattern,
        hotProviderBindingId: authority.hot_binding_id,
        canonicalProviderBindingId: authority.canonical_binding_id,
        writePolicy,
      });
      const providerTargets = Object.freeze({
        hot: Object.freeze({
          providerRole: 'hot' as const,
          providerId: authority.hot_provider_id,
          bucketLabel: authority.hot_bucket_label,
          internalLocator: '',
          normalizedPrefixPattern: authority.normalized_prefix_pattern,
          capabilityPolicy: policy,
          credentialSecretReferenceId: authority.hot_secret_reference_id,
        }),
        canonical: Object.freeze({
          providerRole: 'canonical' as const,
          providerId: authority.canonical_provider_id,
          bucketLabel: authority.canonical_bucket_label,
          internalLocator: '',
          normalizedPrefixPattern: authority.normalized_prefix_pattern,
          capabilityPolicy: policy,
          credentialSecretReferenceId: authority.canonical_secret_reference_id,
        }),
      });
      return Object.freeze({ profile, writeAuthority, providerTargets });
    } catch (error) {
      if (error instanceof RuntimeCompositionError) throw error;
      throw unavailable('storage-authority-unavailable');
    } finally {
      client.release();
    }
  }

  load(): Promise<Readonly<ResolvedDevelopmentAuthority>> {
    const now = this.#now().getTime();
    if (this.#cached !== undefined && this.#cached.expiresAt > now) return this.#cached.value;
    const value = this.#queryAuthority();
    this.#cached = Object.freeze({ expiresAt: now + AUTHORITY_CACHE_TTL_MS, value });
    void value.catch(() => {
      if (this.#cached?.value === value) this.#cached = undefined;
    });
    return value;
  }

  async resolveStorageProfile(
    request: Readonly<StorageProfileRequest>,
    caller: Readonly<CallerIdentity>,
  ): Promise<Readonly<SafeResolvedStorageProfile>> {
    this.#assertRequest(request, caller);
    return (await this.load()).profile;
  }

  async resolveObjectWriteAuthority(
    request: Readonly<StorageProfileRequest>,
    caller: Readonly<CallerIdentity>,
  ): Promise<Readonly<ResolvedObjectWriteAuthority>> {
    this.#assertRequest(request, caller);
    return (await this.load()).writeAuthority;
  }

  #assertRequest(
    request: Readonly<StorageProfileRequest>,
    caller: Readonly<CallerIdentity>,
  ): void {
    if (
      caller.appId !== DEVELOPMENT_AUTHORITY.callerAppId ||
      (caller.serviceId ?? '') !== DEVELOPMENT_AUTHORITY.callerServiceId
    ) {
      throw new RuntimeCompositionError('unauthorized', 'storage-authority-caller-mismatch', 403);
    }
    if (
      request.environment !== DEVELOPMENT_AUTHORITY.environment ||
      request.profileId !== DEVELOPMENT_AUTHORITY.profileId ||
      request.profileVersion !== DEVELOPMENT_AUTHORITY.profileVersion
    ) {
      throw new RuntimeCompositionError(
        'not-ready',
        'storage-authority-request-mismatch',
        503,
      );
    }
  }

  async resolve(input: {
    providerRole: ProviderRole;
    providerBindingId: string;
    internalLocator: string;
  }): Promise<Readonly<ResolvedProviderWriteTarget>> {
    const authority = await this.load();
    const expectedBinding =
      input.providerRole === 'hot'
        ? authority.writeAuthority.hotProviderBindingId
        : authority.writeAuthority.canonicalProviderBindingId;
    if (input.providerBindingId !== expectedBinding) {
      throw new RuntimeCompositionError(
        'unauthorized',
        'provider-binding-authority-mismatch',
        403,
      );
    }
    const target = authority.providerTargets[input.providerRole];
    return Object.freeze({
      ...target,
      internalLocator: input.internalLocator,
    });
  }

  async readiness(
    credentialResolver?: ReadyProviderCredentialResolver,
  ): Promise<DependencyReadiness> {
    try {
      const authority = await this.load();
      if (
        credentialResolver !== undefined &&
        (!credentialResolver.isReady(
          authority.providerTargets.hot.credentialSecretReferenceId,
        ) ||
          !credentialResolver.isReady(
            authority.providerTargets.canonical.credentialSecretReferenceId,
          ))
      ) {
        return Object.freeze({
          status: 'not-ready',
          code: 'provider-credentials-unavailable',
        });
      }
      return Object.freeze({ status: 'ready' });
    } catch {
      return Object.freeze({
        status: 'not-ready',
        code: 'storage-authority-unavailable',
      });
    }
  }
}

function unavailableUploadTokenService(): UploadCompletionTokenService {
  return Object.freeze({
    issue: () => {
      throw unavailable('upload-signing-key-unavailable');
    },
    verify: () => {
      throw unavailable('upload-signing-key-unavailable');
    },
  });
}

function unavailableReadGrantTokenService(): ObjectReadGrantTokenService {
  return Object.freeze({
    issue: () => {
      throw unavailable('read-grant-signing-key-unavailable');
    },
    verify: () => {
      throw unavailable('read-grant-signing-key-unavailable');
    },
  });
}

function isReadNamespace(pathname: string): boolean {
  return (
    pathname === '/v1/object-read-grants' ||
    pathname.startsWith('/v1/object-read-grants/') ||
    pathname.startsWith('/v1/storage-objects/')
  );
}

export function composeStorageRuntimes(
  writeRuntime: HttpStorageRuntime,
  readRuntime: HttpStorageRuntime,
): HttpStorageRuntime {
  return Object.freeze({
    handle: (request: Request) => {
      const pathname = new URL(request.url).pathname;
      return isReadNamespace(pathname)
        ? readRuntime.handle(request)
        : writeRuntime.handle(request);
    },
    health: () => writeRuntime.health(),
    readiness: () => writeRuntime.readiness(),
  });
}

export interface VideoMakerRuntimeComposition {
  readonly runtime: HttpStorageRuntime;
  close(): Promise<void>;
}

export interface VideoMakerRuntimeCompositionOptions {
  readonly environment?: RuntimeEnvironment;
  readonly pool?: PostgresPoolLike;
  readonly closePool?: () => Promise<void>;
  readonly credentialResolver?: ReadyProviderCredentialResolver;
  readonly writer?: ProviderObjectWriter;
  readonly providerReader?: ProviderObjectReader;
  readonly mediaVerifier?: MediaVerificationAdapter;
  readonly now?: () => Date;
}

export function createVideoMakerRuntimeComposition(
  options: VideoMakerRuntimeCompositionOptions = {},
): VideoMakerRuntimeComposition {
  const environment = options.environment ?? process.env;
  const now = options.now ?? (() => new Date());
  const poolResource =
    options.pool === undefined
      ? createPoolResource(environment)
      : Object.freeze({
          pool: options.pool,
          close: options.closePool ?? (async () => undefined),
          configured: true,
        });
  const credentialResolver =
    options.credentialResolver ?? createEnvironmentCredentialResolver(environment);
  const authorityRegistry = new PostgresVideoMakerAuthorityRegistry({
    pool: poolResource.pool,
    now,
  });
  const runtimeStorageRegistry = new PostgresRuntimeStorageRegistry({
    pool: poolResource.pool,
    duplicateResultCodec: createRuntimeStorageDuplicateResultCodec(),
    now,
  });
  const readRegistry = new PostgresObjectReadRegistry({
    pool: poolResource.pool,
    now,
  });
  const uploadSigningKey = environment.Z_S_UPLOAD_COMPLETION_SIGNING_KEY;
  const readGrantSigningKey = environment.Z_S_READ_GRANT_SIGNING_KEY;
  const uploadTokenService = tokenReady(uploadSigningKey)
    ? createDeterministicUploadCompletionTokenService({
        signingKey: uploadSigningKey,
        now,
      })
    : unavailableUploadTokenService();
  const readGrantTokenService = tokenReady(readGrantSigningKey)
    ? createDeterministicObjectReadGrantTokenService({
        signingKey: readGrantSigningKey,
        now,
      })
    : unavailableReadGrantTokenService();
  const writer =
    options.writer ??
    new S3CompatibleProviderObjectWriter({
      credentialResolver,
    });
  const providerReader =
    options.providerReader ??
    new S3CompatibleProviderObjectReader({
      credentialResolver,
    });
  const temporaryRoot = safeString(environment.Z_S_TEMPORARY_ROOT, 2048);
  const ingestAdapter = new DualProviderObjectIngestAdapter({
    registry: runtimeStorageRegistry,
    writer,
    mediaVerifier:
      options.mediaVerifier ??
      new BoundedMediaVerifier({
        maximumByteLength: DEVELOPMENT_AUTHORITY.maximumByteLength,
      }),
    resolveTarget: authorityRegistry,
    ...(temporaryRoot === null ? {} : { temporaryRoot }),
  });
  const knownCaller = (caller: Readonly<CallerIdentity>): boolean =>
    (caller.appId === 'video-maker_app' || caller.appId === 'z-x_app') &&
    caller.serviceId === DEVELOPMENT_AUTHORITY.callerServiceId;
  const authenticate = (bearerToken: string): Readonly<CallerIdentity> | null => {
    if (constantTimeTokenEquals(bearerToken, environment.Z_S_VIDEO_MAKER_BEARER_TOKEN)) {
      return Object.freeze({
        appId: 'video-maker_app',
        serviceId: DEVELOPMENT_AUTHORITY.callerServiceId,
      });
    }
    if (constantTimeTokenEquals(bearerToken, environment.Z_S_Z_X_BEARER_TOKEN)) {
      return Object.freeze({
        appId: 'z-x_app',
        serviceId: DEVELOPMENT_AUTHORITY.callerServiceId,
      });
    }
    return null;
  };
  const controlPlaneReadiness = async (): Promise<DependencyReadiness> => {
    if (!poolResource.configured) {
      return Object.freeze({
        status: 'not-ready',
        code: 'postgres-configuration-unavailable',
      });
    }
    return authorityRegistry.readiness();
  };
  const dataPlaneReadiness = async (): Promise<DependencyReadiness> => {
    if (
      !tokenReady(environment.Z_S_VIDEO_MAKER_BEARER_TOKEN) ||
      !tokenReady(environment.Z_S_Z_X_BEARER_TOKEN) ||
      !tokenReady(uploadSigningKey) ||
      !tokenReady(readGrantSigningKey)
    ) {
      return Object.freeze({
        status: 'not-ready',
        code: 'runtime-identity-or-signing-configuration-unavailable',
      });
    }
    return authorityRegistry.readiness(credentialResolver);
  };

  const sharedRuntimeOptions = {
    authenticate,
    authorizeCaller: knownCaller,
    resolveStorageProfile: (
      request: Readonly<StorageProfileRequest>,
      context: Readonly<{ caller: Readonly<CallerIdentity> }>,
    ) => authorityRegistry.resolveStorageProfile(request, context.caller),
    resolveObjectWriteAuthority: (
      request: Readonly<StorageProfileRequest>,
      context: Readonly<{ caller: Readonly<CallerIdentity> }>,
    ) => authorityRegistry.resolveObjectWriteAuthority(request, context.caller),
    uploadCompletionTokenService: uploadTokenService,
    registry: runtimeStorageRegistry,
    adapter: ingestAdapter,
    controlPlaneReadiness,
    dataPlaneReadiness,
    now,
  };
  const writeRuntime = createObjectIngestRuntime(sharedRuntimeOptions);
  const readRuntime = createReadEnabledHttpStorageRuntime({
    authenticate,
    authorizeCaller: knownCaller,
    resolveStorageProfile: (
      request: Readonly<StorageProfileRequest>,
      context: Readonly<{ caller: Readonly<CallerIdentity> }>,
    ) => authorityRegistry.resolveStorageProfile(request, context.caller),
    createObjectWriteIntent: () => {
      throw new RuntimeCompositionError(
        'internal',
        'write-route-dispatched-to-read-runtime',
        500,
      );
    },
    controlPlaneReadiness,
    dataPlaneReadiness,
    now,
    authorizeObjectReadGrant: ({ caller }) => knownCaller(caller),
    objectReadGrantTokenService: readGrantTokenService,
    objectReadGrantRegistry: readRegistry,
    objectReadDeliveryService: new ObjectReadDeliveryCoordinator({
      registry: readRegistry,
      providerReader,
      now,
    }),
  });
  return Object.freeze({
    runtime: composeStorageRuntimes(writeRuntime, readRuntime),
    close: poolResource.close,
  });
}

export { DEVELOPMENT_AUTHORITY };
