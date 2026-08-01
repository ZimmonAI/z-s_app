import { Pool, type PoolConfig } from 'pg';
import {
  createUnavailableClientCredentialAuthenticator,
  PostgresStorageControlClientCredentialAuthenticator,
  type ClientCredentialAuthenticator,
} from './client-control-auth.js';
import type { PostgresQueryable } from './runtime-storage-registry-types.js';

export interface ClientControlComposition {
  readonly authenticator: ClientCredentialAuthenticator;
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
  const postgresUrl = optionalString(environment.Z_S_POSTGRES_URL);
  if (postgresUrl === undefined) {
    return Object.freeze({
      authenticator: createUnavailableClientCredentialAuthenticator(),
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
    application_name: 'z-s-client-control-login',
  };
  const pool = new Pool(configuration);
  return Object.freeze({
    authenticator: new PostgresStorageControlClientCredentialAuthenticator(
      pool as unknown as PostgresQueryable,
    ),
    close: () => pool.end(),
  });
}
