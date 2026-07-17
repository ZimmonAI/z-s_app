import { randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { InMemoryStorageCapabilityRegistry } from './capability-registry.js';
import type {
  Environment,
  StorageCapabilityResult,
  StorageProfileProviderBinding,
} from './domain.js';
import { createSafeFingerprint, createSafeFingerprintPayload } from './fingerprint.js';
import type {
  CallerIdentity,
  DependencyReadiness,
  HttpStorageRuntime,
  ObjectReadGrantRequest,
  ResolvedObjectWritePolicy,
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
import { BoundedMediaVerifier } from './runtime-media-verification.js';
import {
  ObjectReadDeliveryCoordinator,
  S3CompatibleProviderObjectReader,
} from './runtime-read-delivery.js';
import {
  PostgresObjectReadRegistry,
  createDeterministicObjectReadGrantTokenService,
  createReadEnabledHttpStorageRuntime,
} from './runtime-read-grant.js';
import {
  S3CompatibleProviderObjectWriter,
  type ResolvedProviderWriteTarget,
} from './runtime-s3-provider.js';
import {
  PostgresRuntimeStorageRegistry,
  createRuntimeStorageDuplicateResultCodec,
} from './runtime-storage-registry.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryable,
} from './runtime-storage-registry-types.js';
import { createDeterministicUploadCompletionTokenService } from './runtime-upload-token.js';
import {
  EnvironmentProviderCredentialResolver,
  readRuntimeEnvironment,
  type RuntimeEnvironmentConfiguration,
} from './runtime-environment.js';

const EXPECTED_AUTHORITY = Object.freeze({
  callerAppId: 'video-maker_app',
  callerServiceId: 'api',
  environment: 'dev' as const,
  profileId: 'video-maker-dev-default',
  profileVersion: 1,
  hotProviderId: 'r2_video_maker_dev_01',
  canonicalProviderId: 'minio_zimspace_local_pc_01',
  prefixClassId: 'user-resources',
  normalizedPrefixPattern: 'video-maker/user-resources/*',
});
const ALLOWED_MEDIA_TYPES = Object.freeze(['image/png', 'video/mp4'] as const);
const OBJECT_WRITE_INTENT_TTL_SECONDS = 900 as const;
const OBJECT_READ_GRANT_MAX_TTL_SECONDS = 300;

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

export interface ClosableRuntimePool extends PostgresPoolLike {
  end(): Promise<void>;
}

class UnavailableRuntimePool implements ClosableRuntimePool {
  async connect(): Promise<PostgresClientLike> {
    throw new RuntimeCompositionError(
      'dependency-unavailable',
      'runtime-database-unavailable',
      503,
      true,
    );
  }

  async end(): Promise<void> {
    // No allocated database resource exists.
  }
}

function adaptClient(client: PoolClient): PostgresClientLike {
  return {
    query: async <Row extends Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) => {
      const result = await client.query<Row>(text, values as unknown[] | undefined);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    release: () => client.release(),
  };
}

function createRuntimePool(configuration: Readonly<RuntimeEnvironmentConfiguration>): ClosableRuntimePool {
  if (configuration.databaseUrl === undefined) return new UnavailableRuntimePool();
  const pool = new Pool({
    connectionString: configuration.databaseUrl,
    max: configuration.databasePoolMaximum,
    idleTimeoutMillis: configuration.databaseIdleTimeoutMs,
    connectionTimeoutMillis: configuration.databaseConnectionTimeoutMs,
    allowExitOnIdle: true,
  });
  return {
    connect: async () => adaptClient(await pool.connect()),
    end: () => pool.end(),
  };
}

async function withClient<T>(
  pool: PostgresPoolLike,
  operation: (client: PostgresQueryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

interface AuthorityRow extends Record<string, unknown> {
  managed_app_id: string;
  caller_app_id: string;
  environment: Environment;
  storage_profile_id: string;
  profile_id: string;
  profile_version: number;
  storage_prefix_class_id: string;
  prefix_class_id: string;
  normalized_prefix_pattern: string;
  hot_binding_id: string;
  hot_provider_id: string;
  hot_bucket_label: string;
  hot_secret_reference_id: string;
  canonical_binding_id: string;
  canonical_provider_id: string;
  canonical_bucket_label: string;
  canonical_secret_reference_id: string;
}

interface CapabilityRow extends Record<string, unknown> {
  capability_run_id: string;
  provider_id: string;
  bucket_label: string;
  capability: StorageCapabilityResult['capability'];
  result: StorageCapabilityResult['result'];
  verified_at: Date | string;
  expires_at: Date | string | null;
}

export interface ResolvedVideoMakerRuntimeAuthority {
  profile: Readonly<SafeResolvedStorageProfile>;
  writeAuthority: Readonly<ResolvedObjectWriteAuthority>;
  providerTargets: Readonly<Record<'hot' | 'canonical', Readonly<{
    bindingId: string;
    providerId: string;
    bucketLabel: string;
    secretReferenceId: string;
  }>>>;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RuntimeCompositionError('internal', 'runtime-authority-time-invalid', 500);
  }
  return date.toISOString();
}

function assertExactAuthority(row: AuthorityRow): void {
  if (
    row.caller_app_id !== EXPECTED_AUTHORITY.callerAppId ||
    row.environment !== EXPECTED_AUTHORITY.environment ||
    row.profile_id !== EXPECTED_AUTHORITY.profileId ||
    row.profile_version !== EXPECTED_AUTHORITY.profileVersion ||
    row.prefix_class_id !== EXPECTED_AUTHORITY.prefixClassId ||
    row.normalized_prefix_pattern !== EXPECTED_AUTHORITY.normalizedPrefixPattern ||
    row.hot_provider_id !== EXPECTED_AUTHORITY.hotProviderId ||
    row.canonical_provider_id !== EXPECTED_AUTHORITY.canonicalProviderId
  ) {
    throw new RuntimeCompositionError(
      'not-ready',
      'video-maker-storage-authority-mismatch',
      503,
      true,
    );
  }
}

function writePolicy(maximumObjectByteLength: number): Readonly<ResolvedObjectWritePolicy> {
  return Object.freeze({
    uploadMode: 'server-streamed-single-object',
    allowedMediaTypes: ALLOWED_MEDIA_TYPES,
    maxByteLength: maximumObjectByteLength,
    intentTtlSeconds: OBJECT_WRITE_INTENT_TTL_SECONDS,
  });
}

export class PostgresVideoMakerAuthorityResolver {
  readonly #pool: PostgresPoolLike;
  readonly #maximumObjectByteLength: number;
  readonly #now: () => Date;
  readonly #pending = new Map<string, Promise<Readonly<ResolvedVideoMakerRuntimeAuthority>>>();

  constructor(input: {
    pool: PostgresPoolLike;
    maximumObjectByteLength: number;
    now?: () => Date;
  }) {
    this.#pool = input.pool;
    this.#maximumObjectByteLength = input.maximumObjectByteLength;
    this.#now = input.now ?? (() => new Date());
  }

  resolve(
    request: Readonly<StorageProfileRequest>,
    caller: Readonly<CallerIdentity>,
  ): Promise<Readonly<ResolvedVideoMakerRuntimeAuthority>> {
    if (
      caller.appId !== EXPECTED_AUTHORITY.callerAppId ||
      caller.serviceId !== EXPECTED_AUTHORITY.callerServiceId ||
      request.environment !== EXPECTED_AUTHORITY.environment ||
      request.profileId !== EXPECTED_AUTHORITY.profileId ||
      request.profileVersion !== EXPECTED_AUTHORITY.profileVersion
    ) {
      return Promise.reject(
        new RuntimeCompositionError('unauthorized', 'video-maker-storage-authority-denied', 403),
      );
    }
    const key = `${caller.appId}:${caller.serviceId}:${request.environment}:${request.profileId}:${request.profileVersion}`;
    const active = this.#pending.get(key);
    if (active !== undefined) return active;
    const resolution = this.#load().finally(() => {
      this.#pending.delete(key);
    });
    this.#pending.set(key, resolution);
    return resolution;
  }

  resolveExpected(): Promise<Readonly<ResolvedVideoMakerRuntimeAuthority>> {
    return this.resolve(
      {
        profileId: EXPECTED_AUTHORITY.profileId,
        profileVersion: EXPECTED_AUTHORITY.profileVersion,
        environment: EXPECTED_AUTHORITY.environment,
      },
      { appId: EXPECTED_AUTHORITY.callerAppId, serviceId: EXPECTED_AUTHORITY.callerServiceId },
    );
  }

  async resolveProviderTarget(input: {
    providerRole: 'hot' | 'canonical';
    providerBindingId: string;
    internalLocator: string;
  }): Promise<Readonly<ResolvedProviderWriteTarget>> {
    const authority = await this.resolveExpected();
    const target = authority.providerTargets[input.providerRole];
    if (
      target.bindingId !== input.providerBindingId ||
      !input.internalLocator.startsWith(EXPECTED_AUTHORITY.normalizedPrefixPattern.slice(0, -1))
    ) {
      throw new RuntimeCompositionError(
        'unauthorized',
        'provider-target-authority-mismatch',
        403,
      );
    }
    return Object.freeze({
      providerRole: input.providerRole,
      providerId: target.providerId,
      bucketLabel: target.bucketLabel,
      internalLocator: input.internalLocator,
      normalizedPrefixPattern: EXPECTED_AUTHORITY.normalizedPrefixPattern,
      capabilityPolicy: authority.profile.capabilityPolicy,
      credentialSecretReferenceId: target.secretReferenceId,
    });
  }

  async #load(): Promise<Readonly<ResolvedVideoMakerRuntimeAuthority>> {
    try {
      return await withClient(this.#pool, async (client) => {
        const now = this.#now();
        const authorityResult = await client.query<AuthorityRow>(
          `SELECT managed_app.id AS managed_app_id, managed_app.app_id AS caller_app_id,
                  managed_app.environment, profile.id AS storage_profile_id,
                  profile.profile_id, profile.version AS profile_version,
                  prefix_class.id AS storage_prefix_class_id, prefix_class.prefix_class_id,
                  prefix_class.normalized_prefix_pattern,
                  hot_binding.id AS hot_binding_id, hot_provider.provider_id AS hot_provider_id,
                  hot_binding.bucket_label AS hot_bucket_label,
                  hot_provider.secret_reference_id AS hot_secret_reference_id,
                  canonical_binding.id AS canonical_binding_id,
                  canonical_provider.provider_id AS canonical_provider_id,
                  canonical_binding.bucket_label AS canonical_bucket_label,
                  canonical_provider.secret_reference_id AS canonical_secret_reference_id
             FROM public.managed_apps AS managed_app
             JOIN public.storage_profiles AS profile
               ON profile.managed_app_id = managed_app.id
             JOIN public.storage_prefix_classes AS prefix_class
               ON prefix_class.storage_profile_id = profile.id
              AND prefix_class.prefix_class_id = $5
              AND prefix_class.operation_class = 'user-upload'
              AND prefix_class.status = 'active'
             JOIN public.storage_profile_provider_bindings AS hot_binding
               ON hot_binding.storage_profile_id = profile.id
              AND hot_binding.provider_role = 'hot'
              AND hot_binding.required = true
             JOIN public.storage_providers AS hot_provider
               ON hot_provider.id = hot_binding.storage_provider_id
              AND hot_provider.status = 'active'
             JOIN public.storage_profile_provider_bindings AS canonical_binding
               ON canonical_binding.storage_profile_id = profile.id
              AND canonical_binding.provider_role = 'canonical'
              AND canonical_binding.required = true
             JOIN public.storage_providers AS canonical_provider
               ON canonical_provider.id = canonical_binding.storage_provider_id
              AND canonical_provider.status = 'active'
            WHERE managed_app.app_id = $1
              AND managed_app.environment = $2
              AND managed_app.status = 'active'
              AND profile.profile_id = $3
              AND profile.version = $4
              AND profile.status = 'active'
              AND profile.effective_at <= $6
              AND (profile.retired_at IS NULL OR profile.retired_at > $6)`,
          [
            EXPECTED_AUTHORITY.callerAppId,
            EXPECTED_AUTHORITY.environment,
            EXPECTED_AUTHORITY.profileId,
            EXPECTED_AUTHORITY.profileVersion,
            EXPECTED_AUTHORITY.prefixClassId,
            now,
          ],
        );
        const row = authorityResult.rows[0];
        if (row === undefined || authorityResult.rows.length !== 1) {
          throw new RuntimeCompositionError(
            'not-ready',
            'video-maker-storage-authority-not-ready',
            503,
            true,
          );
        }
        assertExactAuthority(row);

        const capabilitiesResult = await client.query<CapabilityRow>(
          `SELECT capability.capability_run_id, provider.provider_id, binding.bucket_label,
                  capability.capability, capability.result, capability.verified_at,
                  capability.expires_at
             FROM public.storage_profile_provider_bindings AS binding
             JOIN public.storage_providers AS provider
               ON provider.id = binding.storage_provider_id
             JOIN public.storage_capability_results AS capability
               ON capability.storage_profile_id = binding.storage_profile_id
              AND capability.storage_provider_id = binding.storage_provider_id
              AND capability.bucket_label = binding.bucket_label
              AND capability.prefix_class_id = $2
            WHERE binding.storage_profile_id = $1
              AND binding.id = ANY($3::uuid[])
            ORDER BY capability.verified_at DESC`,
          [
            row.storage_profile_id,
            row.prefix_class_id,
            [row.hot_binding_id, row.canonical_binding_id],
          ],
        );
        const capabilityResults: StorageCapabilityResult[] = capabilitiesResult.rows.map((entry) => ({
          capabilityRunId: entry.capability_run_id,
          profileId: row.profile_id,
          profileVersion: row.profile_version,
          providerId: entry.provider_id,
          bucketLabel: entry.bucket_label,
          prefixClassId: row.prefix_class_id,
          capability: entry.capability,
          result: entry.result,
          verifiedAt: iso(entry.verified_at),
          expiresAt: entry.expires_at === null ? null : iso(entry.expires_at),
        }));
        const bindings: StorageProfileProviderBinding[] = [
          {
            profileId: row.profile_id,
            profileVersion: row.profile_version,
            providerRole: 'hot',
            providerId: row.hot_provider_id,
            bucketLabel: row.hot_bucket_label,
            required: true,
          },
          {
            profileId: row.profile_id,
            profileVersion: row.profile_version,
            providerRole: 'canonical',
            providerId: row.canonical_provider_id,
            bucketLabel: row.canonical_bucket_label,
            required: true,
          },
        ];
        const capabilityPolicy = await new InMemoryStorageCapabilityRegistry(
          capabilityResults,
          this.#now,
        ).assertReady({
          profileId: row.profile_id,
          profileVersion: row.profile_version,
          prefixClassId: row.prefix_class_id,
          bindings,
        });
        if (capabilityPolicy.rangeRead !== 'required') {
          throw new RuntimeCompositionError(
            'not-ready',
            'video-maker-range-capability-not-ready',
            503,
            true,
          );
        }
        const policy = writePolicy(this.#maximumObjectByteLength);
        const safeFingerprint = createSafeFingerprint(
          createSafeFingerprintPayload({
            appId: row.caller_app_id,
            environment: row.environment,
            profileId: row.profile_id,
            profileVersion: row.profile_version,
            hotProvider: {
              providerId: row.hot_provider_id,
              bucketLabel: row.hot_bucket_label,
            },
            canonicalProvider: {
              providerId: row.canonical_provider_id,
              bucketLabel: row.canonical_bucket_label,
            },
            prefixClassId: row.prefix_class_id,
          }),
        );
        const profile: SafeResolvedStorageProfile = Object.freeze({
          profileId: row.profile_id,
          profileVersion: row.profile_version,
          environment: row.environment,
          active: true,
          ready: true,
          safeFingerprint,
          capabilityPolicy: Object.freeze(capabilityPolicy),
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
            'hot-verified-canonical-repair-required',
          ]),
          writePolicy: policy,
        });
        const writeAuthority: ResolvedObjectWriteAuthority = Object.freeze({
          managedAppId: row.managed_app_id,
          callerServiceId: EXPECTED_AUTHORITY.callerServiceId,
          storageProfileId: row.storage_profile_id,
          storageProfileVersion: row.profile_version,
          storageProfileFingerprint: safeFingerprint,
          storagePrefixClassId: row.storage_prefix_class_id,
          normalizedPrefixPattern: row.normalized_prefix_pattern,
          hotProviderBindingId: row.hot_binding_id,
          canonicalProviderBindingId: row.canonical_binding_id,
          writePolicy: policy,
        });
        return Object.freeze({
          profile,
          writeAuthority,
          providerTargets: Object.freeze({
            hot: Object.freeze({
              bindingId: row.hot_binding_id,
              providerId: row.hot_provider_id,
              bucketLabel: row.hot_bucket_label,
              secretReferenceId: row.hot_secret_reference_id,
            }),
            canonical: Object.freeze({
              bindingId: row.canonical_binding_id,
              providerId: row.canonical_provider_id,
              bucketLabel: row.canonical_bucket_label,
              secretReferenceId: row.canonical_secret_reference_id,
            }),
          }),
        });
      });
    } catch (error) {
      if (error instanceof RuntimeCompositionError) throw error;
      if (
        error !== null &&
        typeof error === 'object' &&
        typeof (error as Record<string, unknown>).category === 'string' &&
        typeof (error as Record<string, unknown>).code === 'string'
      ) {
        throw error;
      }
      throw new RuntimeCompositionError(
        'dependency-unavailable',
        'runtime-authority-resolution-unavailable',
        503,
        true,
      );
    }
  }
}

async function routeNotFound(response: Response): Promise<boolean> {
  if (response.status !== 404) return false;
  try {
    const body = await response.clone().json() as {
      readonly error?: { readonly diagnostic?: { readonly code?: string } };
    };
    return body.error?.diagnostic?.code === 'route-not-found';
  } catch {
    return false;
  }
}

export function composeStorageRuntimes(
  writeRuntime: HttpStorageRuntime,
  readRuntime: HttpStorageRuntime,
): HttpStorageRuntime {
  return Object.freeze({
    async handle(request: Request): Promise<Response> {
      const writeResponse = await writeRuntime.handle(request);
      if (!(await routeNotFound(writeResponse))) return writeResponse;
      return readRuntime.handle(request);
    },
    health: () => writeRuntime.health(),
    readiness: () => writeRuntime.readiness(),
  });
}

export interface RuntimeLocalComposition {
  runtime: HttpStorageRuntime;
  close(): Promise<void>;
}

export interface RuntimeLocalCompositionOptions {
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
  createId?: () => string;
  pool?: ClosableRuntimePool;
}

function readiness(code?: string): Readonly<DependencyReadiness> {
  return code === undefined
    ? Object.freeze({ status: 'ready' as const })
    : Object.freeze({ status: 'not-ready' as const, code });
}

export function createRuntimeLocalComposition(
  options: RuntimeLocalCompositionOptions = {},
): RuntimeLocalComposition {
  const environment = options.environment ?? process.env;
  const configuration = readRuntimeEnvironment(environment);
  const pool = options.pool ?? createRuntimePool(configuration);
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const authorityResolver = new PostgresVideoMakerAuthorityResolver({
    pool,
    maximumObjectByteLength: configuration.maximumObjectByteLength,
    now,
  });
  const credentialResolver = new EnvironmentProviderCredentialResolver({
    environment,
    bindings: configuration.providerSecretBindings,
  });
  const uploadCompletionTokenService = createDeterministicUploadCompletionTokenService({
    signingKey:
      configuration.uploadCompletionSigningKey ?? randomBytes(32).toString('base64url'),
    now,
  });
  const objectReadGrantTokenService = createDeterministicObjectReadGrantTokenService({
    signingKey:
      configuration.objectReadGrantSigningKey ?? randomBytes(32).toString('base64url'),
    now,
  });
  const registry = new PostgresRuntimeStorageRegistry({
    pool,
    duplicateResultCodec: createRuntimeStorageDuplicateResultCodec(),
    now,
    createId,
  });
  const readRegistry = new PostgresObjectReadRegistry({ pool, now, createId });
  const writer = new S3CompatibleProviderObjectWriter({ credentialResolver });
  const reader = new S3CompatibleProviderObjectReader({ credentialResolver });
  const targetResolver: ProviderWriteTargetResolver = Object.freeze({
    resolve: (input) => authorityResolver.resolveProviderTarget(input),
  });
  const adapter = new DualProviderObjectIngestAdapter({
    registry,
    writer,
    mediaVerifier: new BoundedMediaVerifier({
      maximumByteLength: configuration.maximumObjectByteLength,
    }),
    resolveTarget: targetResolver,
  });

  const authenticate = (token: string): Readonly<CallerIdentity> | null => {
    if (
      configuration.videoMakerBearerToken !== undefined &&
      token === configuration.videoMakerBearerToken
    ) {
      return Object.freeze({ appId: 'video-maker_app', serviceId: 'api' });
    }
    if (configuration.zXBearerToken !== undefined && token === configuration.zXBearerToken) {
      return Object.freeze({ appId: 'z-x_app', serviceId: 'api' });
    }
    return null;
  };
  const authorizeCaller = (caller: Readonly<CallerIdentity>): boolean =>
    caller.serviceId === 'api' &&
    (caller.appId === 'video-maker_app' || caller.appId === 'z-x_app');

  const controlPlaneReadiness = async (): Promise<Readonly<DependencyReadiness>> => {
    const databaseConfigurationCode = configuration.safeConfigurationCodes.find(
      (code) => code === 'database-url-missing' || code.startsWith('invalid-z-s-runtime-db-'),
    );
    if (databaseConfigurationCode !== undefined) return readiness(databaseConfigurationCode);
    try {
      await withClient(pool, async (client) => {
        await client.query('SELECT 1 AS ready');
      });
      await authorityResolver.resolveExpected();
      return readiness();
    } catch (error) {
      return readiness(
        error instanceof RuntimeCompositionError
          ? error.code
          : 'runtime-control-plane-unavailable',
      );
    }
  };

  const dataPlaneReadiness = async (): Promise<Readonly<DependencyReadiness>> => {
    const configurationCode = configuration.safeConfigurationCodes.find(
      (code) =>
        code === 'upload-signing-key-missing' ||
        code === 'read-signing-key-missing' ||
        code.startsWith('provider-secret-bindings-') ||
        code === 'invalid-z-s-runtime-max-object-bytes',
    );
    if (configurationCode !== undefined) return readiness(configurationCode);
    try {
      const authority = await authorityResolver.resolveExpected();
      for (const target of Object.values(authority.providerTargets)) {
        const code = credentialResolver.readinessCode(target.secretReferenceId);
        if (code !== undefined) return readiness(code);
      }
      return readiness();
    } catch (error) {
      return readiness(
        error instanceof RuntimeCompositionError
          ? error.code
          : 'runtime-data-plane-unavailable',
      );
    }
  };

  const writeRuntime = createObjectIngestRuntime({
    authenticate,
    authorizeCaller,
    resolveStorageProfile: async (request, context) =>
      (await authorityResolver.resolve(request, context.caller)).profile,
    resolveObjectWriteAuthority: async (request, context) =>
      (await authorityResolver.resolve(request, context.caller)).writeAuthority,
    uploadCompletionTokenService,
    registry,
    adapter,
    controlPlaneReadiness,
    dataPlaneReadiness,
    now,
    createId,
  });
  const readDeliveryService = new ObjectReadDeliveryCoordinator({
    registry: readRegistry,
    providerReader: reader,
    now,
    createId,
  });
  const readRuntime = createReadEnabledHttpStorageRuntime({
    authenticate,
    authorizeCaller,
    resolveStorageProfile: async (request, context) =>
      (await authorityResolver.resolve(request, context.caller)).profile,
    resolveObjectWriteAuthority: async (request, context) =>
      (await authorityResolver.resolve(request, context.caller)).writeAuthority,
    createObjectWriteIntent: () => {
      throw new RuntimeCompositionError('internal', 'unreachable-composed-write-route', 500);
    },
    uploadCompletionTokenService,
    controlPlaneReadiness,
    dataPlaneReadiness,
    now,
    createId,
    authorizeObjectReadGrant: async (input) => {
      if (
        input.caller.appId !== EXPECTED_AUTHORITY.callerAppId ||
        input.caller.serviceId !== EXPECTED_AUTHORITY.callerServiceId ||
        input.request.requestedTtlSeconds > OBJECT_READ_GRANT_MAX_TTL_SECONDS ||
        input.request.allowRange !== true ||
        input.request.allowedMethods.some((method) => method !== 'HEAD' && method !== 'GET')
      ) {
        return false;
      }
      await authorityResolver.resolveExpected();
      return true;
    },
    objectReadGrantTokenService,
    objectReadGrantRegistry: readRegistry,
    objectReadDeliveryService: readDeliveryService,
  });
  const runtime = composeStorageRuntimes(writeRuntime, readRuntime);
  let closed = false;
  return Object.freeze({
    runtime,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  });
}
