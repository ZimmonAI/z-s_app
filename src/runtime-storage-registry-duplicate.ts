import { randomUUID } from 'node:crypto';
import type { DuplicateProtectionStore } from './runtime-contract.js';
import {
  RuntimeStorageRegistryError,
  type DurableDuplicateResultCodec,
  type IdempotencyRow,
  type RuntimeStorageRegistryOptions,
} from './runtime-storage-registry-types.js';
import {
  PostgresTransactionScope,
  parseDuplicateScope,
  requireSafeIdentifier,
  requireSha256,
  requireUuid,
} from './runtime-storage-registry-support.js';

export class PostgresRuntimeStorageRegistryDuplicateCore implements DuplicateProtectionStore {
  protected readonly scope: PostgresTransactionScope;
  protected readonly codec: DurableDuplicateResultCodec;
  protected readonly now: () => Date;
  protected readonly createId: () => string;
  protected readonly idempotencyReservationTtlMs: number;

  constructor(options: RuntimeStorageRegistryOptions) {
    this.scope = new PostgresTransactionScope(options.pool);
    this.codec = options.duplicateResultCodec;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.idempotencyReservationTtlMs = options.idempotencyReservationTtlMs ?? 5 * 60_000;
  }

  async execute<T>(input: {
    scope: string;
    key: string;
    fingerprint: string;
    operation: () => Promise<T>;
  }): Promise<Readonly<{ replayed: boolean; value: T }>> {
    const parsedScope = parseDuplicateScope(input.scope);
    const key = requireSafeIdentifier(input.key, 'duplicate-protection-key');
    const fingerprint = requireSha256(input.fingerprint, 'request-fingerprint');

    return this.scope.run(async (client) => {
      const now = this.now();
      const expiresAt = new Date(now.getTime() + this.idempotencyReservationTtlMs);
      const recordId = this.createId();
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO public.storage_idempotency_records (
           id, caller_app_id, caller_service_id, operation_scope, idempotency_key,
           request_fingerprint, state, expires_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'in_progress', $7, $8, $8)
         ON CONFLICT (caller_app_id, caller_service_id, operation_scope, idempotency_key)
         DO NOTHING
         RETURNING id`,
        [
          recordId,
          parsedScope.callerAppId,
          parsedScope.callerServiceId,
          parsedScope.operationScope,
          key,
          fingerprint,
          expiresAt,
          now,
        ],
      );

      const existing = await client.query<IdempotencyRow>(
        `SELECT request_fingerprint, state, result_kind, result_reference_id,
                result_storage_object_id, expires_at
           FROM public.storage_idempotency_records
          WHERE caller_app_id = $1
            AND caller_service_id = $2
            AND operation_scope = $3
            AND idempotency_key = $4
          FOR UPDATE`,
        [parsedScope.callerAppId, parsedScope.callerServiceId, parsedScope.operationScope, key],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        throw new RuntimeStorageRegistryError('internal', 'idempotency-record-missing', 500);
      }

      if (row.request_fingerprint !== fingerprint) {
        throw new RuntimeStorageRegistryError(
          'duplicate-conflict',
          'idempotency-key-reused',
          409,
        );
      }

      if (inserted.rowCount === 0 && row.state === 'succeeded') {
        if (row.result_kind === null || row.result_reference_id === null) {
          throw new RuntimeStorageRegistryError('internal', 'idempotency-result-missing', 500);
        }
        const decoded = await this.codec.decode(
          {
            resultKind: row.result_kind,
            resultReferenceId: row.result_reference_id,
            ...(row.result_storage_object_id === null
              ? {}
              : { storageObjectId: row.result_storage_object_id }),
          },
          client,
        );
        return Object.freeze({ replayed: true, value: decoded as T });
      }

      if (inserted.rowCount === 0 && row.state === 'in_progress' && new Date(row.expires_at) > now) {
        throw new RuntimeStorageRegistryError(
          'duplicate-conflict',
          'idempotency-request-in-progress',
          409,
          true,
        );
      }

      if (inserted.rowCount === 0) {
        await client.query(
          `UPDATE public.storage_idempotency_records
              SET state = 'in_progress', result_kind = NULL, result_reference_id = NULL,
                  result_storage_object_id = NULL, expires_at = $5, updated_at = $6
            WHERE caller_app_id = $1
              AND caller_service_id = $2
              AND operation_scope = $3
              AND idempotency_key = $4`,
          [
            parsedScope.callerAppId,
            parsedScope.callerServiceId,
            parsedScope.operationScope,
            key,
            expiresAt,
            now,
          ],
        );
      }

      const value = await input.operation();
      const reference = await this.codec.encode(value, client);
      requireSafeIdentifier(reference.resultKind, 'duplicate-result-kind', 64);
      requireUuid(reference.resultReferenceId, 'duplicate-result-reference');
      if (reference.storageObjectId !== undefined) {
        requireUuid(reference.storageObjectId, 'duplicate-storage-object');
      }
      await client.query(
        `UPDATE public.storage_idempotency_records
            SET state = 'succeeded', result_kind = $5, result_reference_id = $6,
                result_storage_object_id = $7, updated_at = $8
          WHERE caller_app_id = $1
            AND caller_service_id = $2
            AND operation_scope = $3
            AND idempotency_key = $4`,
        [
          parsedScope.callerAppId,
          parsedScope.callerServiceId,
          parsedScope.operationScope,
          key,
          reference.resultKind,
          reference.resultReferenceId,
          reference.storageObjectId ?? null,
          now,
        ],
      );
      return Object.freeze({ replayed: false, value });
    });
  }
}
