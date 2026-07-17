import { createHash, timingSafeEqual } from 'node:crypto';
import { Pool, type PoolConfig } from 'pg';
import { InMemoryStorageProfileRegistry } from './profile-registry.js';
import type {
  ControlPlaneDataSet,
  Environment,
  ProviderCapabilityPolicy,
  ProviderType,
  StorageCapabilityResult,
} from './domain.js';
import type {
  CallerIdentity,
  DependencyReadiness,
  HttpStorageRuntime,
  ObjectReadGrantRequest,
  SafeResolvedStorageProfile,
  StorageProfileRequest,
  StorageRuntimeOptions,
} from './runtime-contract.js';
import { DualProviderObjectIngestAdapter } from './runtime-dual-provider.js';
import {
  createObjectIngestRuntime,
  type ResolvedObjectWriteAuthority,
} from './runtime-ingest.js';
import { BoundedMediaVerifier } from './runtime-media-verification.js';
import {
  ObjectReadDeliveryCoordinator,
  S3CompatibleProviderObjectReader,
} from './runtime-read-delivery.js';
import {
  createDeterministicObjectReadGrantTokenService,
  createReadEnabledHttpStorageRuntime,
  PostgresObjectReadRegistry,
  type ObjectReadGrantTokenService,
} from './runtime-read-grant.js';
import {
  type ProviderCredentialResolver,
  type ResolvedProviderWriteTarget,
  type ResolvedS3CredentialBinding,
  S3CompatibleProviderObjectWriter,
} from './runtime-s3-provider.js';
import {
  createRuntimeStorageDuplicateResultCodec,
  PostgresRuntimeStorageRegistry,
} from './runtime-storage-registry.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryable,
  PostgresQueryResult,
} from './runtime-storage-registry-types.js';
import {
  createDeterministicUploadCompletionTokenService,
  type UploadCompletionTokenService,
} from './runtime-upload-token.js';

const VIDEO_MAKER_APP = 'video-maker_app';
const Z_X_APP = 'z-x_app';
const CALLER_SERVICE = 'api';
const DEVELOPMENT_ENVIRONMENT = 'dev' as const;
const PROFILE_ALIAS = 'video-maker-dev-default';
const PROFILE_VERSION = 1;
const HOT_PROVIDER_ALIAS = 'r2_video_maker_dev_01';
const CANONICAL_PROVIDER_ALIAS = 'minio_zimspace_local_pc_01';
const PREFIX_CLASS_ALIAS = 'video-maker-user-resource';
const NORMALIZED_PREFIX_PATTERN = 'video-maker/user-resources/*';
const DEFAULT_MAX_OBJECT_BYTE_LENGTH = 32 * 1024 * 1024;
const DEFAULT_POSTGRES_POOL_SIZE = 8;
const DEFAULT_POSTGRES_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_POSTGRES_IDLE_TIMEOUT_MS = 30_000;

const VIDEO_MAKER_CALLER: Readonly<CallerIdentity> = Object.freeze({
  appId: VIDEO_MAKER_APP,
  serviceId: CALLER_SERVICE,
});
const EXACT_PROFILE_REQUEST: Readonly<StorageProfileRequest> = Object.freeze({
  profileId: PROFILE_ALIAS,
  profileVersion: PROFILE_VERSION,
  environment: DEVELOPMENT_ENVIRONMENT,
});
const WRITE_POLICY = Object.freeze({
  uploadMode: 'server-streamed-single-object' as const,
  allowedMediaTypes: Object.freeze(['image/png', 'video/mp4']),
  intentTtlSeconds: 900 as const,
});

class RuntimeCompositionError extends Error {
  readonly category: 'unauthenticated' | 'unauthorized' | 'dependency-unavailable' | 'internal';
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    category: RuntimeCompositionError['category'],
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

interface RuntimePostgresPool extends PostgresPoolLike, PostgresQueryable {
  end(): Promise<void>;
}

interface AuthorityRow extends Record<string, unknown> {
  managed_app_id: string;
  app_id: string;
  environment: Environment;
  managed_app_status: string;
  storage_profile_id: string;
  profile_id: string;
  profile_version: number;
  profile_status: string;
  effective_at: Date | string;
  retired_at: Date | string | null;
  storage_prefix_class_id: string;
  prefix_class_id: string;
  operation_class: string;
  normalized_prefix_pattern: string;
  prefix_status: string;
  provider_binding_id: string;
  provider_role: 'hot' | 'canonical';
  bucket_label: string;
  binding_required: boolean;
  storage_provider_id: string;
  provider_id: string;
  provider_type: ProviderType;
  provider_status: string;
  secret_reference_id: string;
}

interface CapabilityRow extends Record<string, unknown> {
  capability_run_id: string;
  provider_id: string;
  bucket_label: string;
  prefix_class_id: string;
  capability: StorageCapabilityResult['capability'];
  result: StorageCapabilityResult['result'];
  verified_at: Date | string;
  expires_at: Date | string | null;
  safe_evidence_ref: string | null;
}

interface ProviderAuthority {
  providerRole: 'hot' | 'canonical';
  providerBindingId: string;
  providerId: string;
  bucketLabel: string;
  secretReferenceId: string;
}

interface DevelopmentAuthoritySnapshot {
  profile: Readonly<SafeResolvedStorageProfile>;
  writeAuthority: Readonly<ResolvedObjectWriteAuthority>;
  providers: Readonly<Record<'hot' | 'canonical', Readonly<ProviderAuthority>>>;
}

interface RuntimeEnvironmentConfiguration {
  postgresUrl?: string;
  postgresPoolSize: number;
  postgresConnectionTimeoutMs: number;
  postgresIdleTimeoutMs: number;
  maximumObjectByteLength: number;
  videoMakerBearerToken?: string;
  zXBearerToken?: string;
  uploadSigningKey?: string;
  readGrantSigningKey?: string;
  providerCredentialBindingsJson?: string;
}

export interface RuntimeProviderCredentialResolver extends ProviderCredentialResolver {
  has(referenceIds: readonly string[]): boolean;
  readonly configured: boolean;
}

export interface VideoMakerRuntimeComposition {
  readonly runtime: HttpStorageRuntime;
  close(): Promise<void>;
}

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? undefined : normalized;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

function runtimeConfiguration(environment: NodeJS.ProcessEnv): RuntimeEnvironmentConfiguration {
  const result: RuntimeEnvironmentConfiguration = {
    postgresPoolSize: boundedInteger(
      environment.Z_S_POSTGRES_MAX_CONNECTIONS,
      DEFAULT_POSTGRES_POOL_SIZE,
      1,
      32,
    ),
    postgresConnectionTimeoutMs: boundedInteger(
      environment.Z_S_POSTGRES_CONNECTION_TIMEOUT_MS,
      DEFAULT_POSTGRES_CONNECTION_TIMEOUT_MS,
      100,
      60_000,
    ),
    postgresIdleTimeoutMs: boundedInteger(
      environment.Z_S_POSTGRES_IDLE_TIMEOUT_MS,
      DEFAULT_POSTGRES_IDLE_TIMEOUT_MS,
      1_000,
      10 * 60_000,
    ),
    maximumObjectByteLength: boundedInteger(
      environment.Z_S_MAX_OBJECT_BYTE_LENGTH,
      DEFAULT_MAX_OBJECT_BYTE_LENGTH,
      1,
      512 * 1024 * 1024,
    ),
  };
  const optionalValues: ReadonlyArray<readonly [keyof RuntimeEnvironmentConfiguration, string | undefined]> = [
    ['postgresUrl', trimmed(environment.Z_S_POSTGRES_URL)],
    ['videoMakerBearerToken', trimmed(environment.Z_S_VIDEO_MAKER_BEARER_TOKEN)],
    ['zXBearerToken', trimmed(environment.Z_S_Z_X_BEARER_TOKEN)],
    ['uploadSigningKey', trimmed(environment.Z_S_UPLOAD_COMPLETION_SIGNING_KEY)],
    ['readGrantSigningKey', trimmed(environment.Z_S_READ_GRANT_SIGNING_KEY)],
    ['providerCredentialBindingsJson', trimmed(environment.Z_S_PROVIDER_CREDENTIAL_BINDINGS_JSON)],
  ];
  for (const [key, value] of optionalValues) {
    if (value !== undefined) Object.assign(result, { [key]: value });
  }
  return Object.freeze(result);
}

function asIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RuntimeCompositionError('dependency-unavailable', 'storage-authority-invalid', 503);
  }
  return date.toISOString();
}

function isProviderType(value: string): value is ProviderType {
  return value === 'minio' || value === 'r2' || value === 's3-compatible';
}

function safeTokenMatch(received: string, expected: string | undefined): boolean {
  if (expected === undefined) return false;
  const receivedDigest = createHash('sha256').update(received, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(receivedDigest, expectedDigest);
}

function authenticateWithConfiguration(
  configuration: Readonly<RuntimeEnvironmentConfiguration>,
  token: string,
): Readonly<CallerIdentity> | null {
  if (safeTokenMatch(token, configuration.videoMakerBearerToken)) return VIDEO_MAKER_CALLER;
  if (safeTokenMatch(token, configuration.zXBearerToken)) {
    return Object.freeze({ appId: Z_X_APP, serviceId: CALLER_SERVICE });
  }
  return null;
}

function authorizedCaller(caller: Readonly<CallerIdentity>): boolean {
  return (
    (caller.appId === VIDEO_MAKER_APP || caller.appId === Z_X_APP) &&
    caller.serviceId === CALLER_SERVICE
  );
}

class UnavailablePostgresPool implements RuntimePostgresPool {
  async connect(): Promise<PostgresClientLike> {
    throw new RuntimeCompositionError(
      'dependency-unavailable',
      'postgres-not-configured',
      503,
      true,
    );
  }

  async query<Row extends Record<string, unknown>>(
    _text: string,
    _values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    throw new RuntimeCompositionError(
      'dependency-unavailable',
      'postgres-not-configured',
      503,
      true,
    );
  }

  async end(): Promise<void> {}
}

function createPostgresPool(
  configuration: Readonly<RuntimeEnvironmentConfiguration>,
): RuntimePostgresPool {
  if (configuration.postgresUrl === undefined) return new UnavailablePostgresPool();
  const poolConfiguration: PoolConfig = {
    connectionString: configuration.postgresUrl,
    max: configuration.postgresPoolSize,
    connectionTimeoutMillis: configuration.postgresConnectionTimeoutMs,
    idleTimeoutMillis: configuration.postgresIdleTimeoutMs,
    allowExitOnIdle: false,
    application_name: 'z-s-video-maker-runtime',
  };
  return new Pool(poolConfiguration) as unknown as RuntimePostgresPool;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function credentialBinding(value: unknown): Readonly<ResolvedS3CredentialBinding> | null {
  if (!isRecord(value)) return null;
  const endpoint = trimmed(typeof value.endpoint === 'string' ? value.endpoint : undefined);
  const region = trimmed(typeof value.region === 'string' ? value.region : undefined);
  const accessKeyId = trimmed(typeof value.accessKeyId === 'string' ? value.accessKeyId : undefined);
  const secretAccessKey = trimmed(
    typeof value.secretAccessKey === 'string' ? value.secretAccessKey : undefined,
  );
  if (
    endpoint === undefined ||
    region === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined ||
    typeof value.forcePathStyle !== 'boolean'
  ) {
    return null;
  }
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    return null;
  }
  if (parsedEndpoint.protocol !== 'https:' && parsedEndpoint.protocol !== 'http:') return null;
  const result: ResolvedS3CredentialBinding = {
    endpoint,
    region,
    forcePathStyle: value.forcePathStyle,
    accessKeyId,
    secretAccessKey,
  };
  const sessionToken = trimmed(
    typeof value.sessionToken === 'string' ? value.sessionToken : undefined,
  );
  if (sessionToken !== undefined) result.sessionToken = sessionToken;
  return Object.freeze(result);
}

export function createRuntimeProviderCredentialResolver(
  rawBindings: string | undefined,
): RuntimeProviderCredentialResolver {
  const bindings = new Map<string, Readonly<ResolvedS3CredentialBinding>>();
  let parseValid = rawBindings !== undefined;
  if (rawBindings !== undefined) {
    try {
      const parsed: unknown = JSON.parse(rawBindings);
      if (!isRecord(parsed)) {
        parseValid = false;
      } else {
        for (const [referenceId, value] of Object.entries(parsed)) {
          const normalizedReference = trimmed(referenceId);
          const binding = credentialBinding(value);
          if (
            normalizedReference === undefined ||
            normalizedReference.length > 256 ||
            binding === null
          ) {
            parseValid = false;
            bindings.clear();
            break;
          }
          bindings.set(normalizedReference, binding);
        }
      }
    } catch {
      parseValid = false;
    }
  }
  const resolver: RuntimeProviderCredentialResolver = {
    configured: parseValid && bindings.size > 0,
    has(referenceIds: readonly string[]): boolean {
      return parseValid && referenceIds.every((referenceId) => bindings.has(referenceId));
    },
    resolve(referenceId: string): Readonly<ResolvedS3CredentialBinding> {
      const binding = parseValid ? bindings.get(referenceId) : undefined;
      if (binding === undefined) {
        throw new RuntimeCompositionError(
          'dependency-unavailable',
          'provider-credential-binding-unavailable',
          503,
          true,
        );
      }
      return binding;
    },
  };
  return Object.freeze(resolver);
}

function unavailableUploadTokenService(): UploadCompletionTokenService {
  return Object.freeze({
    issue(): never {
      throw new RuntimeCompositionError(
        'dependency-unavailable',
        'upload-completion-signing-key-unavailable',
        503,
        true,
      );
    },
    verify(): never {
      throw new RuntimeCompositionError(
        'unauthenticated',
        'invalid-upload-completion-token',
        401,
      );
    },
  });
}

function unavailableReadGrantTokenService(): ObjectReadGrantTokenService {
  return Object.freeze({
    issue(): never {
      throw new RuntimeCompositionError(
        'dependency-unavailable',
        'object-read-grant-signing-key-unavailable',
        503,
        true,
      );
    },
    verify(): never {
      throw new RuntimeCompositionError(
        'unauthenticated',
        'invalid-object-read-grant-token',
        401,
      );
    },
  });
}

function uploadTokenService(
  configuration: Readonly<RuntimeEnvironmentConfiguration>,
): UploadCompletionTokenService {
  return configuration.uploadSigningKey === undefined
    ? unavailableUploadTokenService()
    : createDeterministicUploadCompletionTokenService({
        signingKey: configuration.uploadSigningKey,
      });
}

function readGrantTokenService(
  configuration: Readonly<RuntimeEnvironmentConfiguration>,
): ObjectReadGrantTokenService {
  return configuration.readGrantSigningKey === undefined
    ? unavailableReadGrantTokenService()
    : createDeterministicObjectReadGrantTokenService({
        signingKey: configuration.readGrantSigningKey,
      });
}

function validateAuthorityRows(rows: readonly AuthorityRow[], now: Date): {
  hot: AuthorityRow;
  canonical: AuthorityRow;
} {
  if (rows.length !== 2) {
    throw new RuntimeCompositionError('dependency-unavailable', 'storage-authority-incomplete', 503, true);
  }
  const hot = rows.find((row) => row.provider_role === 'hot');
  const canonical = rows.find((row) => row.provider_role === 'canonical');
  if (hot === undefined || canonical === undefined) {
    throw new RuntimeCompositionError('dependency-unavailable', 'storage-authority-incomplete', 503, true);
  }
  for (const row of rows) {
    if (
      row.app_id !== VIDEO_MAKER_APP ||
      row.environment !== DEVELOPMENT_ENVIRONMENT ||
      row.managed_app_status !== 'active' ||
      row.profile_id !== PROFILE_ALIAS ||
      row.profile_version !== PROFILE_VERSION ||
      row.profile_status !== 'active' ||
      new Date(row.effective_at).getTime() > now.getTime() ||
      (row.retired_at !== null && new Date(row.retired_at).getTime() <= now.getTime()) ||
      row.prefix_class_id !== PREFIX_CLASS_ALIAS ||
      row.operation_class !== 'user-upload' ||
      row.normalized_prefix_pattern !== NORMALIZED_PREFIX_PATTERN ||
      row.prefix_status !== 'active' ||
      row.binding_required !== true ||
      row.provider_status !== 'active' ||
      !isProviderType(row.provider_type)
    ) {
      throw new RuntimeCompositionError('dependency-unavailable', 'storage-authority-not-ready', 503, true);
    }
  }
  if (hot.provider_id !== HOT_PROVIDER_ALIAS || canonical.provider_id !== CANONICAL_PROVIDER_ALIAS) {
    throw new RuntimeCompositionError('dependency-unavailable', 'provider-authority-mismatch', 503);
  }
  const commonKeys: ReadonlyArray<keyof AuthorityRow> = [
    'managed_app_id',
    'storage_profile_id',
    'storage_prefix_class_id',
    'prefix_class_id',
    'normalized_prefix_pattern',
  ];
  if (commonKeys.some((key) => hot[key] !== canonical[key])) {
    throw new RuntimeCompositionError('dependency-unavailable', 'storage-authority-ambiguous', 503);
  }
  return { hot, canonical };
}

class DevelopmentAuthorityResolver {
  readonly #pool: RuntimePostgresPool;
  readonly #maximumObjectByteLength: number;
  readonly #now: () => Date;

  constructor(options: {
    pool: RuntimePostgresPool;
    maximumObjectByteLength: number;
    now?: () => Date;
  }) {
    this.#pool = options.pool;
    this.#maximumObjectByteLength = options.maximumObjectByteLength;
    this.#now = options.now ?? (() => new Date());
  }

  async resolve(
    request: Readonly<StorageProfileRequest>,
    caller: Readonly<CallerIdentity>,
  ): Promise<Readonly<DevelopmentAuthoritySnapshot>> {
    if (caller.appId !== VIDEO_MAKER_APP || caller.serviceId !== CALLER_SERVICE) {
      throw new RuntimeCompositionError('unauthorized', 'storage-authority-caller-mismatch', 403);
    }
    if (
      request.profileId !== PROFILE_ALIAS ||
      request.profileVersion !== PROFILE_VERSION ||
      request.environment !== DEVELOPMENT_ENVIRONMENT
    ) {
      throw new RuntimeCompositionError('unauthorized', 'storage-authority-request-mismatch', 403);
    }
    try {
      return await this.#load();
    } catch (error) {
      if (error instanceof RuntimeCompositionError) throw error;
      throw new RuntimeCompositionError(
        'dependency-unavailable',
        'storage-authority-unavailable',
        503,
        true,
      );
    }
  }

  async resolveTarget(input: {
    providerRole: 'hot' | 'canonical';
    providerBindingId: string;
    internalLocator: string;
  }): Promise<Readonly<ResolvedProviderWriteTarget>> {
    const snapshot = await this.resolve(EXACT_PROFILE_REQUEST, VIDEO_MAKER_CALLER);
    const provider = snapshot.providers[input.providerRole];
    if (
      provider.providerBindingId !== input.providerBindingId ||
      !input.internalLocator.startsWith(NORMALIZED_PREFIX_PATTERN.slice(0, -1)) ||
      input.internalLocator.startsWith('/') ||
      input.internalLocator.includes('..') ||
      input.internalLocator.includes('\\') ||
      input.internalLocator.includes('://')
    ) {
      throw new RuntimeCompositionError('internal', 'provider-target-authority-mismatch', 500);
    }
    return Object.freeze({
      providerRole: provider.providerRole,
      providerId: provider.providerId,
      bucketLabel: provider.bucketLabel,
      internalLocator: input.internalLocator,
      normalizedPrefixPattern: NORMALIZED_PREFIX_PATTERN,
      capabilityPolicy: snapshot.profile.capabilityPolicy,
      credentialSecretReferenceId: provider.secretReferenceId,
    });
  }

  async #load(): Promise<Readonly<DevelopmentAuthoritySnapshot>> {
    const authorityResult = await this.#pool.query<AuthorityRow>(
      `SELECT managed_app.id AS managed_app_id, managed_app.app_id, managed_app.environment,
              managed_app.status AS managed_app_status,
              profile.id AS storage_profile_id, profile.profile_id, profile.version AS profile_version,
              profile.status AS profile_status, profile.effective_at, profile.retired_at,
              prefix_class.id AS storage_prefix_class_id, prefix_class.prefix_class_id,
              prefix_class.operation_class, prefix_class.normalized_prefix_pattern,
              prefix_class.status AS prefix_status,
              binding.id AS provider_binding_id, binding.provider_role,
              binding.bucket_label, binding.required AS binding_required,
              provider.id AS storage_provider_id, provider.provider_id, provider.provider_type,
              provider.status AS provider_status, provider.secret_reference_id
         FROM public.managed_apps AS managed_app
         JOIN public.storage_profiles AS profile ON profile.managed_app_id = managed_app.id
         JOIN public.storage_prefix_classes AS prefix_class ON prefix_class.storage_profile_id = profile.id
         JOIN public.storage_profile_provider_bindings AS binding ON binding.storage_profile_id = profile.id
         JOIN public.storage_providers AS provider ON provider.id = binding.storage_provider_id
        WHERE managed_app.app_id = $1
          AND managed_app.environment = $2
          AND profile.profile_id = $3
          AND profile.version = $4
          AND prefix_class.prefix_class_id = $5
          AND prefix_class.normalized_prefix_pattern = $6
          AND binding.provider_role IN ('hot', 'canonical')
        ORDER BY binding.provider_role`,
      [
        VIDEO_MAKER_APP,
        DEVELOPMENT_ENVIRONMENT,
        PROFILE_ALIAS,
        PROFILE_VERSION,
        PREFIX_CLASS_ALIAS,
        NORMALIZED_PREFIX_PATTERN,
      ],
    );
    const { hot, canonical } = validateAuthorityRows(authorityResult.rows, this.#now());
    const capabilityResult = await this.#pool.query<CapabilityRow>(
      `SELECT capability.capability_run_id, provider.provider_id, capability.bucket_label,
              capability.prefix_class_id, capability.capability, capability.result,
              capability.verified_at, capability.expires_at, capability.safe_evidence_ref
         FROM public.storage_capability_results AS capability
         JOIN public.storage_providers AS provider ON provider.id = capability.storage_provider_id
        WHERE capability.storage_profile_id = $1
          AND capability.storage_provider_id = ANY($2::uuid[])
          AND capability.prefix_class_id = $3`,
      [
        hot.storage_profile_id,
        [hot.storage_provider_id, canonical.storage_provider_id],
        hot.prefix_class_id,
      ],
    );
    const data: ControlPlaneDataSet = {
      managedApps: [
        {
          appId: hot.app_id,
          environment: hot.environment,
          status: 'active',
        },
      ],
      providers: [hot, canonical].map((row) => ({
        providerId: row.provider_id,
        providerType: row.provider_type,
        status: 'active' as const,
        secretReferenceId: row.secret_reference_id,
      })),
      profiles: [
        {
          profileId: hot.profile_id,
          appId: hot.app_id,
          environment: hot.environment,
          version: hot.profile_version,
          status: 'active',
        },
      ],
      bindings: [hot, canonical].map((row) => ({
        profileId: row.profile_id,
        profileVersion: row.profile_version,
        providerRole: row.provider_role,
        providerId: row.provider_id,
        bucketLabel: row.bucket_label,
        required: row.binding_required,
      })),
      prefixClasses: [
        {
          prefixClassId: hot.prefix_class_id,
          profileId: hot.profile_id,
          profileVersion: hot.profile_version,
          operationClass: 'user-upload',
          normalizedPrefixPattern: hot.normalized_prefix_pattern,
          status: 'active',
        },
      ],
      capabilityResults: capabilityResult.rows.map((row) => ({
        capabilityRunId: row.capability_run_id,
        profileId: hot.profile_id,
        profileVersion: hot.profile_version,
        providerId: row.provider_id,
        bucketLabel: row.bucket_label,
        prefixClassId: row.prefix_class_id,
        capability: row.capability,
        result: row.result,
        verifiedAt: asIso(row.verified_at),
        expiresAt: row.expires_at === null ? null : asIso(row.expires_at),
        safeEvidenceRef: row.safe_evidence_ref,
      })),
    };
    const assignment = await new InMemoryStorageProfileRegistry(data, this.#now).resolve({
      appId: VIDEO_MAKER_APP,
      environment: DEVELOPMENT_ENVIRONMENT,
      profileId: PROFILE_ALIAS,
      operationClass: 'user-upload',
      expectedConfiguration: {
        hotProviderId: HOT_PROVIDER_ALIAS,
        hotBucket: hot.bucket_label,
        canonicalProviderId: CANONICAL_PROVIDER_ALIAS,
        canonicalBucket: canonical.bucket_label,
        normalizedPrefixPattern: NORMALIZED_PREFIX_PATTERN,
      },
    });
    if (
      assignment.profileVersion !== PROFILE_VERSION ||
      assignment.prefixClassId !== PREFIX_CLASS_ALIAS ||
      assignment.capabilityPolicy.rangeRead !== 'required'
    ) {
      throw new RuntimeCompositionError('dependency-unavailable', 'storage-capability-not-ready', 503, true);
    }
    const capabilityPolicy: Readonly<ProviderCapabilityPolicy> = Object.freeze({
      ...assignment.capabilityPolicy,
    });
    const writePolicy = Object.freeze({
      ...WRITE_POLICY,
      maxByteLength: this.#maximumObjectByteLength,
    });
    const profile: SafeResolvedStorageProfile = Object.freeze({
      profileId: PROFILE_ALIAS,
      profileVersion: PROFILE_VERSION,
      environment: DEVELOPMENT_ENVIRONMENT,
      active: true,
      ready: true,
      safeFingerprint: assignment.safeFingerprint,
      capabilityPolicy,
      capabilities: Object.freeze({
        objectWriteIntent: true,
        objectReadGrant: true,
        objectDeleteRequest: false,
        objectRepairOperation: false,
      }),
      protectionStages: Object.freeze([
        'write-intent-created',
        'upload-completion-recorded',
        'canonical-and-hot-verified',
        'canonical-verified-hot-repair-required',
      ]),
      writePolicy,
    });
    const writeAuthority: ResolvedObjectWriteAuthority = Object.freeze({
      managedAppId: hot.managed_app_id,
      callerServiceId: CALLER_SERVICE,
      storageProfileId: hot.storage_profile_id,
      storageProfileVersion: PROFILE_VERSION,
      storageProfileFingerprint: assignment.safeFingerprint,
      storagePrefixClassId: hot.storage_prefix_class_id,
      normalizedPrefixPattern: NORMALIZED_PREFIX_PATTERN,
      hotProviderBindingId: hot.provider_binding_id,
      canonicalProviderBindingId: canonical.provider_binding_id,
      writePolicy,
    });
    return Object.freeze({
      profile,
      writeAuthority,
      providers: Object.freeze({
        hot: Object.freeze({
          providerRole: 'hot',
          providerBindingId: hot.provider_binding_id,
          providerId: hot.provider_id,
          bucketLabel: hot.bucket_label,
          secretReferenceId: hot.secret_reference_id,
        }),
        canonical: Object.freeze({
          providerRole: 'canonical',
          providerBindingId: canonical.provider_binding_id,
          providerId: canonical.provider_id,
          bucketLabel: canonical.bucket_label,
          secretReferenceId: canonical.secret_reference_id,
        }),
      }),
    });
  }
}

function safeReadinessCode(error: unknown, fallback: string): string {
  if (
    error !== null &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    /^[a-z0-9][a-z0-9-]{0,95}$/.test((error as { code: string }).code)
  ) {
    return (error as { code: string }).code;
  }
  return fallback;
}

function routeNotFoundBody(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.error) || !isRecord(value.error.diagnostic)) return false;
  return value.error.diagnostic.code === 'route-not-found';
}

async function isRouteNotFound(response: Response): Promise<boolean> {
  if (response.status !== 404) return false;
  try {
    return routeNotFoundBody(await response.clone().json());
  } catch {
    return false;
  }
}

export function composeStorageRuntimeRoutes(
  writeRuntime: HttpStorageRuntime,
  readRuntime: HttpStorageRuntime,
): HttpStorageRuntime {
  return Object.freeze({
    async handle(request: Request): Promise<Response> {
      const writeResponse = await writeRuntime.handle(request);
      if (request.bodyUsed || !(await isRouteNotFound(writeResponse))) return writeResponse;
      return readRuntime.handle(request);
    },
    health: () => writeRuntime.health(),
    readiness: () => writeRuntime.readiness(),
  });
}

function rejectUnexpectedWriteDispatch(): never {
  throw new RuntimeCompositionError('internal', 'composition-route-invariant', 500);
}

export function createVideoMakerRuntimeComposition(
  environment: NodeJS.ProcessEnv = process.env,
): VideoMakerRuntimeComposition {
  const configuration = runtimeConfiguration(environment);
  const pool = createPostgresPool(configuration);
  const credentials = createRuntimeProviderCredentialResolver(
    configuration.providerCredentialBindingsJson,
  );
  const authority = new DevelopmentAuthorityResolver({
    pool,
    maximumObjectByteLength: configuration.maximumObjectByteLength,
  });
  const authenticate: StorageRuntimeOptions['authenticate'] = (token) =>
    authenticateWithConfiguration(configuration, token);
  const authorizeCaller: StorageRuntimeOptions['authorizeCaller'] = authorizedCaller;
  const resolveStorageProfile: StorageRuntimeOptions['resolveStorageProfile'] = async (
    request,
    context,
  ) => (await authority.resolve(request, context.caller)).profile;
  const resolveObjectWriteAuthority: NonNullable<
    StorageRuntimeOptions['resolveObjectWriteAuthority']
  > = async (request, context) => (await authority.resolve(request, context.caller)).writeAuthority;

  const controlPlaneReadiness = async (): Promise<DependencyReadiness> => {
    try {
      await pool.query('SELECT 1 AS ready');
      await authority.resolve(EXACT_PROFILE_REQUEST, VIDEO_MAKER_CALLER);
      return Object.freeze({ status: 'ready' });
    } catch (error) {
      return Object.freeze({
        status: 'not-ready',
        code: safeReadinessCode(error, 'control-plane-not-ready'),
      });
    }
  };
  const dataPlaneReadiness = async (): Promise<DependencyReadiness> => {
    try {
      if (
        configuration.videoMakerBearerToken === undefined ||
        configuration.zXBearerToken === undefined ||
        configuration.uploadSigningKey === undefined ||
        configuration.readGrantSigningKey === undefined
      ) {
        throw new RuntimeCompositionError(
          'dependency-unavailable',
          'runtime-secret-binding-unavailable',
          503,
          true,
        );
      }
      const snapshot = await authority.resolve(EXACT_PROFILE_REQUEST, VIDEO_MAKER_CALLER);
      const secretReferences = Object.values(snapshot.providers).map(
        (provider) => provider.secretReferenceId,
      );
      if (!credentials.configured || !credentials.has(secretReferences)) {
        throw new RuntimeCompositionError(
          'dependency-unavailable',
          'provider-credential-binding-unavailable',
          503,
          true,
        );
      }
      return Object.freeze({ status: 'ready' });
    } catch (error) {
      return Object.freeze({
        status: 'not-ready',
        code: safeReadinessCode(error, 'data-plane-not-ready'),
      });
    }
  };

  const storageRegistry = new PostgresRuntimeStorageRegistry({
    pool,
    duplicateResultCodec: createRuntimeStorageDuplicateResultCodec(),
  });
  const writer = new S3CompatibleProviderObjectWriter({ credentialResolver: credentials });
  const ingestAdapter = new DualProviderObjectIngestAdapter({
    registry: storageRegistry,
    writer,
    mediaVerifier: new BoundedMediaVerifier({
      maximumByteLength: configuration.maximumObjectByteLength,
    }),
    resolveTarget: {
      resolve: (input) => authority.resolveTarget(input),
    },
  });
  const writeRuntime = createObjectIngestRuntime({
    authenticate,
    authorizeCaller,
    resolveStorageProfile,
    resolveObjectWriteAuthority,
    uploadCompletionTokenService: uploadTokenService(configuration),
    registry: storageRegistry,
    adapter: ingestAdapter,
    controlPlaneReadiness,
    dataPlaneReadiness,
  });

  const readRegistry = new PostgresObjectReadRegistry({ pool });
  const readTokenService = readGrantTokenService(configuration);
  const readRuntime = createReadEnabledHttpStorageRuntime({
    authenticate,
    authorizeCaller,
    resolveStorageProfile,
    resolveObjectWriteAuthority,
    createObjectWriteIntent: rejectUnexpectedWriteDispatch,
    controlPlaneReadiness,
    dataPlaneReadiness,
    authorizeObjectReadGrant: async (input: {
      caller: Readonly<CallerIdentity>;
      request: Readonly<ObjectReadGrantRequest>;
      appCorrelationReference: string;
    }): Promise<boolean> => {
      if (input.caller.appId !== VIDEO_MAKER_APP || input.caller.serviceId !== CALLER_SERVICE) {
        return false;
      }
      try {
        const snapshot = await authority.resolve(EXACT_PROFILE_REQUEST, input.caller);
        return (
          snapshot.profile.capabilities.objectReadGrant &&
          input.request.allowedMethods.every((method) => method === 'HEAD' || method === 'GET')
        );
      } catch {
        return false;
      }
    },
    objectReadGrantTokenService: readTokenService,
    objectReadGrantRegistry: readRegistry,
    objectReadDeliveryService: new ObjectReadDeliveryCoordinator({
      registry: readRegistry,
      providerReader: new S3CompatibleProviderObjectReader({ credentialResolver: credentials }),
    }),
  });

  let closing: Promise<void> | undefined;
  return Object.freeze({
    runtime: composeStorageRuntimeRoutes(writeRuntime, readRuntime),
    close(): Promise<void> {
      closing ??= pool.end();
      return closing;
    },
  });
}
