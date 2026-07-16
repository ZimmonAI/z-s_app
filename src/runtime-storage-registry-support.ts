import { AsyncLocalStorage } from 'node:async_hooks';
import {
  RuntimeStorageRegistryError,
  type ObjectWriteIntentState,
  type PostgresPoolLike,
  type PostgresQueryable,
  type StorageObjectCopyState,
} from './runtime-storage-registry-types.js';

export const WRITE_INTENT_TRANSITIONS: Readonly<
  Record<ObjectWriteIntentState, readonly ObjectWriteIntentState[]>
> = {
  accepted: ['uploading', 'completed', 'expired', 'cancelled', 'failed'],
  uploading: ['completed', 'expired', 'cancelled', 'failed'],
  completed: [],
  expired: [],
  cancelled: [],
  failed: [],
};

export const COPY_TRANSITIONS: Readonly<
  Record<StorageObjectCopyState, readonly StorageObjectCopyState[]>
> = {
  pending: ['verified', 'failed', 'missing', 'delete_pending'],
  verified: ['missing', 'delete_pending'],
  failed: ['pending', 'verified', 'missing', 'delete_pending'],
  missing: ['pending', 'verified', 'delete_pending'],
  delete_pending: ['deleted', 'failed'],
  deleted: [],
};

const PROHIBITED_SAFE_PAYLOAD_KEYS = /(?:credential|secret|endpoint|bucket|locator|object[_-]?key|signed[_-]?url|bearer|prompt|user[_-]?name|project[_-]?title|scene[_-]?title)/i;

export function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function optionalIso(value: Date | string | null): string | undefined {
  return value === null ? undefined : asIso(value);
}

export function asNumber(value: string | number): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new RuntimeStorageRegistryError('internal', 'invalid-database-number', 500);
  }
  return result;
}

export function requireSafeIdentifier(value: string, name: string, max = 128): string {
  if (!new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${max - 1}}$`).test(value)) {
    throw new RuntimeStorageRegistryError('invalid-request', `invalid-${name}`, 400);
  }
  return value;
}

export function requireSha256(value: string, name: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new RuntimeStorageRegistryError('invalid-request', `invalid-${name}`, 400);
  }
  return value;
}

export function requireUuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new RuntimeStorageRegistryError('invalid-request', `invalid-${name}`, 400);
  }
  return value;
}

export function assertSafeJsonObject(
  value: Readonly<Record<string, unknown>>,
  name: string,
): void {
  const serialized = JSON.stringify(value);
  if (serialized.length > 8192) {
    throw new RuntimeStorageRegistryError('invalid-request', `${name}-too-large`, 400);
  }
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (entry !== null && typeof entry === 'object') {
      for (const [key, child] of Object.entries(entry)) {
        if (PROHIBITED_SAFE_PAYLOAD_KEYS.test(key)) {
          throw new RuntimeStorageRegistryError('invalid-request', `unsafe-${name}-field`, 400);
        }
        visit(child);
      }
    }
  };
  visit(value);
}

export function parseDuplicateScope(scope: string): {
  callerAppId: string;
  callerServiceId: string;
  operationScope: string;
} {
  const parts = scope.split(':');
  if (parts.length === 2) {
    return {
      callerAppId: requireSafeIdentifier(parts[0] ?? '', 'caller-app', 96),
      callerServiceId: '',
      operationScope: requireSafeIdentifier(parts[1] ?? '', 'operation-scope', 96),
    };
  }
  if (parts.length === 3) {
    return {
      callerAppId: requireSafeIdentifier(parts[0] ?? '', 'caller-app', 96),
      callerServiceId:
        parts[1] === '' ? '' : requireSafeIdentifier(parts[1] ?? '', 'caller-service', 96),
      operationScope: requireSafeIdentifier(parts[2] ?? '', 'operation-scope', 96),
    };
  }
  throw new RuntimeStorageRegistryError('invalid-request', 'invalid-duplicate-protection-scope', 400);
}

export class PostgresTransactionScope {
  readonly #pool: PostgresPoolLike;
  readonly #storage = new AsyncLocalStorage<PostgresQueryable>();

  constructor(pool: PostgresPoolLike) {
    this.#pool = pool;
  }

  async run<T>(operation: (client: PostgresQueryable) => Promise<T>): Promise<T> {
    const existing = this.#storage.getStore();
    if (existing !== undefined) return operation(existing);

    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.#storage.run(client, () => operation(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
