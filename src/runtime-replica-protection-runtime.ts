import { randomUUID } from 'node:crypto';
import { Pool, type PoolConfig } from 'pg';
import type { ClientStorageConfigurationStore } from './client-storage-configuration.js';
import type { HttpStorageRuntime } from './runtime-contract.js';
import {
  ConfigurationStoreRuntimeIntegrationTokenAuthenticator,
  RuntimeIntegrationTokenAuthenticationError,
} from './runtime-integration-token-auth.js';
import {
  BoundedReplicaProtectionWorker,
  PostgresReplicaProtectionStore,
  ReplicaProtectionError,
} from './runtime-replica-protection.js';
import {
  S3CompatibleProviderObjectReader,
} from './runtime-read-delivery.js';
import {
  S3CompatibleProviderObjectWriter,
  type ProviderCredentialResolver,
} from './runtime-s3-provider.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryable,
  PostgresQueryResult,
} from './runtime-storage-registry-types.js';

const RUN_ROUTE = '/v1/storage-protection/run';
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
});

interface ReplicaProtectionRuntimePool extends PostgresPoolLike, PostgresQueryable {
  end(): Promise<void>;
}

export interface ReplicaProtectionRuntimeComposition {
  readonly runtime: HttpStorageRuntime;
  close(): Promise<void>;
}

function optionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? undefined : normalized;
}

function queryValues(values?: readonly unknown[]): unknown[] | undefined {
  return values === undefined ? undefined : [...values];
}

function createPool(environment: NodeJS.ProcessEnv): ReplicaProtectionRuntimePool | null {
  const connectionString = optionalString(environment.Z_S_POSTGRES_URL);
  if (connectionString === undefined) return null;
  const configuration: PoolConfig = {
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: false,
    application_name: 'z-s-replica-protection-worker',
  };
  const pool = new Pool(configuration);
  return {
    connect: async (): Promise<PostgresClientLike> => {
      const client = await pool.connect();
      return {
        query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
          text: string,
          values?: readonly unknown[],
        ): Promise<PostgresQueryResult<Row>> => {
          const result = await client.query<Row>(text, queryValues(values));
          return { rows: result.rows, rowCount: result.rowCount };
        },
        release: () => client.release(),
      };
    },
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<PostgresQueryResult<Row>> => {
      const result = await pool.query<Row>(text, queryValues(values));
      return { rows: result.rows, rowCount: result.rowCount };
    },
    end: () => pool.end(),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function bearer(request: Request): string | null {
  const value = request.headers.get('authorization');
  if (value === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  const token = match?.[1]?.trim();
  return token === undefined || token === '' ? null : token;
}

async function requestMode(request: Request): Promise<'repair' | 'retention' | 'all'> {
  if (request.headers.get('content-length') === '0') return 'repair';
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType === '') return 'repair';
  if (!contentType.includes('application/json')) {
    throw new ReplicaProtectionError('not-ready', 'storage-protection-request-invalid');
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ReplicaProtectionError('not-ready', 'storage-protection-request-invalid');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ReplicaProtectionError('not-ready', 'storage-protection-request-invalid');
  }
  const mode = (body as Record<string, unknown>).mode;
  if (mode === undefined) return 'repair';
  if (mode === 'repair' || mode === 'retention' || mode === 'all') return mode;
  throw new ReplicaProtectionError('not-ready', 'storage-protection-mode-invalid');
}

function errorResponse(error: unknown): Response {
  if (error instanceof RuntimeIntegrationTokenAuthenticationError) {
    return json({ error: { code: error.code } }, error.status);
  }
  if (error instanceof ReplicaProtectionError) {
    const status = error.category === 'duplicate-conflict'
      ? 409
      : error.category === 'not-ready'
        ? 409
        : error.category === 'dependency-unavailable'
          ? 503
          : 500;
    return json({ error: { code: error.code } }, status);
  }
  return json({ error: { code: 'storage-protection-unavailable' } }, 503);
}

export function createReplicaProtectionRuntimeComposition(input: Readonly<{
  runtime: HttpStorageRuntime;
  environment: NodeJS.ProcessEnv;
  credentialResolver: ProviderCredentialResolver;
  configurationStore: ClientStorageConfigurationStore;
}>): ReplicaProtectionRuntimeComposition {
  const pool = createPool(input.environment);
  if (pool === null) {
    return Object.freeze({
      runtime: input.runtime,
      async close(): Promise<void> {},
    });
  }
  const store = new PostgresReplicaProtectionStore(pool);
  const worker = new BoundedReplicaProtectionWorker({
    store,
    reader: new S3CompatibleProviderObjectReader({ credentialResolver: input.credentialResolver }),
    writer: new S3CompatibleProviderObjectWriter({ credentialResolver: input.credentialResolver }),
  });
  const authenticator = new ConfigurationStoreRuntimeIntegrationTokenAuthenticator(
    input.configurationStore,
  );

  const runtime: HttpStorageRuntime = Object.freeze({
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== RUN_ROUTE || request.method !== 'POST') {
        return input.runtime.handle(request);
      }
      try {
        const token = bearer(request);
        if (token === null) {
          throw new RuntimeIntegrationTokenAuthenticationError(
            'unauthenticated',
            'integration-token-invalid',
            401,
          );
        }
        const principal = await authenticator.authenticate(token, 'object:manage');
        const mode = await requestMode(request);
        const workerId = `storage-protection:${randomUUID()}`;
        const repair = mode === 'retention'
          ? null
          : await worker.runRepairBatch({
              clientId: principal.clientId,
              environment: principal.environment,
              workerId,
            });
        const retention = mode === 'repair'
          ? null
          : await worker.runRetentionBatch({
              clientId: principal.clientId,
              environment: principal.environment,
              workerId,
            });
        return json({
          result: {
            mode,
            ...(repair === null ? {} : { repair }),
            ...(retention === null ? {} : { retention }),
          },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
    health: () => input.runtime.health(),
    readiness: () => input.runtime.readiness(),
  });

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    runtime,
    close(): Promise<void> {
      closePromise ??= pool.end();
      return closePromise;
    },
  });
}
