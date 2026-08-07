import { randomUUID } from 'node:crypto';
import {
  PostgresLeasedReplicaProtectionStore,
} from './runtime-replica-protection-postgres.js';
import {
  ReplicaProtectionError,
  type ReplicaProtectionRepairJob,
} from './runtime-replica-protection.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryable,
} from './runtime-storage-registry-types.js';

interface ProtectionPool extends PostgresPoolLike, PostgresQueryable {}

async function transaction<T>(
  pool: ProtectionPool,
  operation: (client: PostgresClientLike) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original bounded failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

function integer(value: string | number | null, code: string): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new ReplicaProtectionError('dependency-unavailable', code, true);
  }
  return result;
}

function boundedStoreError(error: unknown, code: string): ReplicaProtectionError {
  if (error instanceof ReplicaProtectionError) return error;
  const sqlState = typeof error === 'object' && error !== null &&
      'code' in error && typeof (error as { code?: unknown }).code === 'string' &&
      /^[0-9A-Z]{5}$/.test((error as { code: string }).code)
    ? (error as { code: string }).code.toLowerCase()
    : null;
  return new ReplicaProtectionError(
    'dependency-unavailable',
    sqlState === null ? code : `${code}-${sqlState}`,
    true,
  );
}

/**
 * Production store facade. Claiming uses the simplified leased implementation;
 * replica completion fixes the legacy prepared-statement parameter gap while
 * retaining object/copy/attempt compare-and-set semantics.
 */
export class PostgresReplicaProtectionRuntimeStore extends PostgresLeasedReplicaProtectionStore {
  readonly #pool: ProtectionPool;

  constructor(pool: ProtectionPool, createId: () => string = randomUUID) {
    super(pool, createId);
    this.#pool = pool;
  }

  override async completeRepair(
    job: Readonly<ReplicaProtectionRepairJob>,
    now = new Date(),
  ): Promise<void> {
    try {
      await transaction(this.#pool, async (client) => {
        const locked = await client.query(
          `SELECT storage_object_id
             FROM public.storage_objects
            WHERE storage_object_id = $1
            FOR UPDATE`,
          [job.storageObjectId],
        );
        if ((locked.rowCount ?? 0) !== 1) {
          throw new ReplicaProtectionError(
            'duplicate-conflict',
            'storage-object-protection-conflict',
          );
        }

        const attempt = await client.query(
          `UPDATE public.storage_provider_attempts
              SET state = 'succeeded',
                  retryable = false,
                  next_retry_at = NULL,
                  lease_owner = NULL,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  observed_checksum_sha256 = $4,
                  observed_byte_length = $5,
                  safe_diagnostic_category = NULL,
                  safe_diagnostic_code = NULL,
                  verified_at = $6::timestamptz,
                  finished_at = $6::timestamptz,
                  updated_at = $6::timestamptz
            WHERE storage_provider_attempt_id = $1
              AND storage_object_copy_id = $2
              AND storage_object_id = $3
              AND state = 'in_progress'
              AND lease_token = $7
              AND lease_expires_at > $6::timestamptz`,
          [
            job.providerAttemptId,
            job.targetStorageObjectCopyId,
            job.storageObjectId,
            job.expectedChecksumSha256,
            job.expectedByteLength,
            now,
            job.leaseToken,
          ],
        );
        if ((attempt.rowCount ?? 0) !== 1) {
          throw new ReplicaProtectionError('duplicate-conflict', 'storage-replica-lease-lost');
        }

        const copy = await client.query(
          `UPDATE public.storage_object_copies
              SET copy_state = 'verified',
                  observed_checksum_sha256 = $3,
                  observed_byte_length = $4,
                  latest_verified_at = $5::timestamptz,
                  absent_at = NULL,
                  updated_at = $5::timestamptz,
                  row_version = row_version + 1
            WHERE storage_object_copy_id = $1
              AND storage_object_id = $2
              AND target_role = 'replica'
              AND configuration_route_target_id IS NOT NULL
              AND copy_state IN ('pending', 'failed', 'missing')
              AND EXISTS (
                SELECT 1
                  FROM public.storage_objects AS object_record
                 WHERE object_record.storage_object_id = $2
                   AND object_record.verified_checksum_sha256 = $3
                   AND object_record.verified_byte_length = $4
              )`,
          [
            job.targetStorageObjectCopyId,
            job.storageObjectId,
            job.expectedChecksumSha256,
            job.expectedByteLength,
            now,
          ],
        );
        if ((copy.rowCount ?? 0) !== 1) {
          throw new ReplicaProtectionError('duplicate-conflict', 'storage-replica-copy-conflict');
        }

        const states = await client.query<{
          target_role: 'primary' | 'replica';
          copy_state: string;
          observed_checksum_sha256: string | null;
          observed_byte_length: string | number | null;
          verified_checksum_sha256: string;
          verified_byte_length: string | number;
        }>(
          `SELECT copy.target_role, copy.copy_state,
                  copy.observed_checksum_sha256, copy.observed_byte_length,
                  object_record.verified_checksum_sha256, object_record.verified_byte_length
             FROM public.storage_object_copies AS copy
             JOIN public.storage_objects AS object_record
               ON object_record.storage_object_id = copy.storage_object_id
            WHERE copy.storage_object_id = $1
              AND copy.configuration_route_target_id IS NOT NULL
            ORDER BY copy.target_order`,
          [job.storageObjectId],
        );
        const primary = states.rows.filter((row) => row.target_role === 'primary');
        const replicas = states.rows.filter((row) => row.target_role === 'replica');
        const exact = (row: (typeof states.rows)[number]): boolean =>
          row.copy_state === 'verified' &&
          row.observed_checksum_sha256 === row.verified_checksum_sha256 &&
          integer(row.observed_byte_length, 'storage-replica-length-invalid') ===
            integer(row.verified_byte_length, 'storage-replica-length-invalid');
        const ready = primary.length === 1 && exact(primary[0]!) &&
          replicas.length > 0 && replicas.every(exact);

        await client.query(
          `UPDATE public.storage_objects
              SET registry_state = $2,
                  object_protection_stage = $3,
                  updated_at = $4::timestamptz,
                  row_version = row_version + 1
            WHERE storage_object_id = $1`,
          [
            job.storageObjectId,
            ready ? 'active' : 'degraded',
            ready
              ? 'configuration-primary-and-replicas-verified'
              : 'configuration-replica-repair-required',
            now,
          ],
        );
      });
    } catch (error) {
      throw boundedStoreError(error, 'storage-replica-completion-unavailable');
    }
  }
}
