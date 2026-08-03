import { hostname } from 'node:os';
import { Pool, type PoolConfig } from 'pg';
import {
  BoundedPngImageDerivativeProcessor,
  ImageDerivativeError,
  ImageDerivativeWorker,
  type ImageDerivativeStatusSnapshot,
} from './image-derivative.js';
import { PostgresImageDerivativeStore } from './image-derivative-postgres.js';
import { createRuntimeProviderCredentialResolver } from './runtime-local-composition.js';
import { S3CompatibleProviderObjectReader } from './runtime-read-delivery.js';
import { S3CompatibleProviderObjectWriter } from './runtime-s3-provider.js';
import type {
  PostgresPoolLike,
  PostgresQueryable,
} from './runtime-storage-registry-types.js';

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

export interface ImageDerivativeWorkerComposition {
  readonly workerId: string;
  runOnce(): Promise<Readonly<ImageDerivativeStatusSnapshot> | null>;
  close(): Promise<void>;
}

export function createImageDerivativeWorkerComposition(
  environment: NodeJS.ProcessEnv = process.env,
): ImageDerivativeWorkerComposition {
  const postgresUrl = optionalString(environment.Z_S_POSTGRES_URL);
  if (postgresUrl === undefined) {
    throw new ImageDerivativeError(
      'dependency-unavailable',
      'postgres-not-configured',
      503,
      true,
    );
  }
  const credentialResolver = createRuntimeProviderCredentialResolver(
    optionalString(environment.Z_S_PROVIDER_CREDENTIAL_BINDINGS_JSON),
  );
  if (!credentialResolver.configured) {
    throw new ImageDerivativeError(
      'dependency-unavailable',
      'provider-credential-binding-unavailable',
      503,
      true,
    );
  }
  const configuration: PoolConfig = {
    connectionString: postgresUrl,
    max: boundedInteger(environment.Z_S_IMAGE_DERIVATIVE_POSTGRES_CONNECTIONS, 2, 1, 4),
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
    application_name: 'z-s-image-derivative-worker',
  };
  const pool = new Pool(configuration);
  const queryable = pool as unknown as PostgresPoolLike & PostgresQueryable;
  const worker = new ImageDerivativeWorker({
    store: new PostgresImageDerivativeStore({ pool: queryable }),
    providerReader: new S3CompatibleProviderObjectReader({ credentialResolver }),
    providerWriter: new S3CompatibleProviderObjectWriter({ credentialResolver }),
    processor: new BoundedPngImageDerivativeProcessor(),
  });
  const configuredWorkerId = optionalString(environment.Z_S_IMAGE_DERIVATIVE_WORKER_ID);
  const workerId = configuredWorkerId ?? `image-derivative:${hostname()}:${process.pid}`;
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    workerId,
    runOnce: () => worker.runOnce(workerId),
    close(): Promise<void> {
      closePromise ??= pool.end();
      return closePromise;
    },
  });
}
