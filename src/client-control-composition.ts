import { Pool, type PoolConfig } from 'pg';
import {
  createUnavailableClientCredentialAuthenticator,
  PostgresStorageControlClientCredentialAuthenticator,
  type ClientCredentialAuthenticator,
} from './client-control-auth.js';
import {
  createUnavailableClientStorageConfigurationStore,
  type ClientStorageConfigurationStore,
} from './client-storage-configuration.js';
import { PostgresClientStorageConfigurationStore } from './client-storage-configuration-postgres.js';
import { SafeClientStorageConfigurationStore } from './client-storage-configuration-safe.js';
import { CloudflareR2Adapter } from './cloudflare-r2-adapter.js';
import {
  createUnavailableImageDerivativeStore,
  ImageDerivativeApplicationService,
  type ImageDerivativeStore,
} from './image-derivative.js';
import { PngImageDerivativeProcessor } from './image-derivative-png.js';
import { PostgresImageDerivativeStore } from './image-derivative-postgres.js';
import {
  ConfiguredImageDerivativeOutputWriter,
  ConfiguredImageDerivativeSourceReader,
} from './image-derivative-provider.js';
import { BoundedImageDerivativeWorker } from './image-derivative-worker.js';
import {
  AesGcmProviderSecretStore,
  providerSecretKeyFromEnvironment,
} from './provider-secret-store.js';
import { PostgresProviderSecretEnvelopeRepository } from './provider-secret-store-postgres.js';
import { createRuntimeProviderCredentialResolver } from './runtime-local-composition.js';
import { S3CompatibleProviderObjectReader } from './runtime-read-delivery.js';
import {
  type ProviderCredentialResolver,
  S3CompatibleProviderObjectWriter,
} from './runtime-s3-provider.js';
import type {
  PostgresPoolLike,
  PostgresQueryable,
} from './runtime-storage-registry-types.js';
import { StorageProviderAdapterRegistry } from './storage-provider-adapter.js';
import { StorageServiceApplicationService } from './storage-service-application.js';
import { StorageServiceProviderCredentialResolver } from './storage-service-credential-resolver.js';
import { PostgresStorageServiceRepository } from './storage-service-postgres.js';

export interface ClientControlComposition {
  readonly authenticator: ClientCredentialAuthenticator;
  readonly configurationStore: ClientStorageConfigurationStore;
  readonly storageService: StorageServiceApplicationService | null;
  readonly credentialResolver: ProviderCredentialResolver;
  readonly imageDerivativeStore: ImageDerivativeStore;
  readonly imageDerivativeWorker: BoundedImageDerivativeWorker | null;
  close(): Promise<void>;
}

function optionalString(value: string | undefined): string | undefined {
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
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

export function createClientControlComposition(
  environment: NodeJS.ProcessEnv,
): ClientControlComposition {
  const managedCredentialResolver = createRuntimeProviderCredentialResolver(
    optionalString(environment.Z_S_PROVIDER_CREDENTIAL_BINDINGS_JSON),
  );
  const postgresUrl = optionalString(environment.Z_S_POSTGRES_URL);
  if (postgresUrl === undefined) {
    return Object.freeze({
      authenticator: createUnavailableClientCredentialAuthenticator(),
      configurationStore: createUnavailableClientStorageConfigurationStore(),
      storageService: null,
      credentialResolver: managedCredentialResolver,
      imageDerivativeStore: createUnavailableImageDerivativeStore(),
      imageDerivativeWorker: null,
      async close(): Promise<void> {},
    });
  }
  const configuration: PoolConfig = {
    connectionString: postgresUrl,
    max: boundedInteger(environment.Z_S_POSTGRES_MAX_CONNECTIONS, 8, 1, 32),
    connectionTimeoutMillis: boundedInteger(
      environment.Z_S_POSTGRES_CONNECTION_TIMEOUT_MS,
      5_000,
      100,
      60_000,
    ),
    idleTimeoutMillis: boundedInteger(
      environment.Z_S_POSTGRES_IDLE_TIMEOUT_MS,
      30_000,
      1_000,
      10 * 60_000,
    ),
    allowExitOnIdle: false,
    application_name: 'z-s-client-storage-control',
  };
  const pool = new Pool(configuration);
  const queryable = pool as unknown as PostgresPoolLike & PostgresQueryable;
  const baseConfigurationStore = new PostgresClientStorageConfigurationStore(queryable);
  const storageServiceRepository = new PostgresStorageServiceRepository(queryable);
  const key = providerSecretKeyFromEnvironment(
    optionalString(environment.Z_S_PROVIDER_SECRET_MASTER_KEY_V1),
  );
  const secretKeys = new Map<number, Uint8Array>();
  if (key !== undefined) secretKeys.set(1, key);
  const secretStore = new AesGcmProviderSecretStore({
    repository: new PostgresProviderSecretEnvelopeRepository(queryable),
    keys: secretKeys,
    activeKeyVersion: 1,
  });
  const adapters = new StorageProviderAdapterRegistry([
    new CloudflareR2Adapter(),
  ]);
  const storageService = new StorageServiceApplicationService({
    repository: storageServiceRepository,
    secrets: secretStore,
    adapters,
    configurations: baseConfigurationStore,
  });
  const configurationStore = new SafeClientStorageConfigurationStore(
    baseConfigurationStore,
    {
      assertAllowed: (clientId, environmentValue, version) =>
        storageService.assertConfigurationActivationAllowed(
          clientId,
          environmentValue,
          version,
        ),
    },
  );
  const credentialResolver = new StorageServiceProviderCredentialResolver({
    services: storageServiceRepository,
    secrets: secretStore,
    adapters,
    managedResolver: managedCredentialResolver,
  });
  const imageDerivativeStore = new PostgresImageDerivativeStore(queryable);
  const imageDerivativeWorker = new BoundedImageDerivativeWorker(
    new ImageDerivativeApplicationService({
      store: imageDerivativeStore,
      sourceReader: new ConfiguredImageDerivativeSourceReader({
        store: imageDerivativeStore,
        reader: new S3CompatibleProviderObjectReader({ credentialResolver }),
      }),
      processor: new PngImageDerivativeProcessor(),
      outputWriter: new ConfiguredImageDerivativeOutputWriter({
        store: imageDerivativeStore,
        writer: new S3CompatibleProviderObjectWriter({ credentialResolver }),
      }),
    }),
  );
  const pollIntervalMs = boundedInteger(
    environment.Z_S_IMAGE_DERIVATIVE_POLL_INTERVAL_MS,
    5_000,
    1_000,
    60_000,
  );
  let workerRunning = false;
  const workerTimer = setInterval(() => {
    if (workerRunning) return;
    workerRunning = true;
    void imageDerivativeWorker.runBatch(`scheduled-${process.pid}`, new Date())
      .catch(() => undefined)
      .finally(() => { workerRunning = false; });
  }, pollIntervalMs);
  workerTimer.unref();
  return Object.freeze({
    authenticator: new PostgresStorageControlClientCredentialAuthenticator(queryable),
    configurationStore,
    storageService,
    credentialResolver,
    imageDerivativeStore,
    imageDerivativeWorker,
    close: async () => {
      clearInterval(workerTimer);
      await pool.end();
    },
  });
}
