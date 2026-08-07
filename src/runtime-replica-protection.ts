import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ClientStorageEnvironment } from './client-storage-configuration.js';
import {
  ProviderReadExecutionError,
  type ProviderObjectReader,
  type ResolvedProviderReadTarget,
} from './runtime-read-delivery.js';
import {
  ProviderExecutionError,
  type ProviderObjectWriter,
  type ResolvedProviderWriteTarget,
} from './runtime-s3-provider.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryable,
} from './runtime-storage-registry-types.js';

export const REPLICA_PROTECTION_LIMITS = Object.freeze({
  maximumAttempts: 8,
  retryDelayMs: 60_000,
  leaseDurationMs: 5 * 60_000,
  repairBatchSize: 2,
  retentionBatchSize: 1,
});

export type ReplicaProtectionDiagnosticCategory =
  | 'duplicate-conflict'
  | 'not-ready'
  | 'dependency-unavailable'
  | 'internal';

export class ReplicaProtectionError extends Error {
  readonly category: ReplicaProtectionDiagnosticCategory;
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    category: ReplicaProtectionDiagnosticCategory,
    code: string,
    retryable = false,
  ) {
    super(code);
    this.name = 'ReplicaProtectionError';
    this.category = category;
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ReplicaProtectionRepairJob {
  readonly providerAttemptId: string;
  readonly attemptNumber: number;
  readonly leaseToken: string;
  readonly storageObjectId: string;
  readonly sourceStorageObjectCopyId: string;
  readonly targetStorageObjectCopyId: string;
  readonly expectedChecksumSha256: string;
  readonly expectedByteLength: number;
  readonly sourceTarget: Readonly<ResolvedProviderReadTarget>;
  readonly targetReadTarget: Readonly<ResolvedProviderReadTarget>;
  readonly targetWriteTarget: Readonly<ResolvedProviderWriteTarget>;
}

export interface ReplicaProtectionRetentionJob {
  readonly providerAttemptId: string;
  readonly attemptNumber: number;
  readonly leaseToken: string;
  readonly storageObjectId: string;
  readonly primaryStorageObjectCopyId: string;
  readonly expectedChecksumSha256: string;
  readonly expectedByteLength: number;
  readonly primaryTarget: Readonly<ResolvedProviderWriteTarget>;
  readonly protectionCopies: readonly Readonly<{
    storageObjectCopyId: string;
    target: Readonly<ResolvedProviderReadTarget>;
  }>[];
}

export type ReplicaProtectionRetentionClaim =
  | Readonly<{ kind: 'job'; job: Readonly<ReplicaProtectionRetentionJob> }>
  | Readonly<{ kind: 'blocked' }>
  | Readonly<{ kind: 'idle' }>;

export interface ReplicaProtectionStore {
  claimRepair(input: {
    clientId: string;
    environment: ClientStorageEnvironment;
    workerId: string;
    now?: Date;
  }): Promise<Readonly<ReplicaProtectionRepairJob> | null>;
  completeRepair(job: Readonly<ReplicaProtectionRepairJob>, now?: Date): Promise<void>;
  failRepair(input: {
    job: Readonly<ReplicaProtectionRepairJob>;
    category: ReplicaProtectionDiagnosticCategory;
    code: string;
    retryable: boolean;
    now?: Date;
  }): Promise<void>;
  claimRetention(input: {
    clientId: string;
    environment: ClientStorageEnvironment;
    workerId: string;
    now?: Date;
  }): Promise<ReplicaProtectionRetentionClaim>;
  completeRetention(job: Readonly<ReplicaProtectionRetentionJob>, now?: Date): Promise<void>;
  failRetention(input: {
    job: Readonly<ReplicaProtectionRetentionJob>;
    category: ReplicaProtectionDiagnosticCategory;
    code: string;
    retryable: boolean;
    invalidateReplicaCopyId?: string;
    now?: Date;
  }): Promise<void>;
}

interface ReplicaProtectionPostgresPool extends PostgresPoolLike, PostgresQueryable {}

interface RepairClaimRow extends Record<string, unknown> {
  storage_object_id: string;
  target_storage_object_copy_id: string;
  source_storage_object_copy_id: string;
  configuration_route_target_id: string;
  verified_checksum_sha256: string;
  verified_byte_length: string | number;
  source_connection_id: string;
  source_bucket_label: string;
  source_internal_locator: string;
  source_secret_reference_id: string;
  target_connection_id: string;
  target_bucket_label: string;
  target_prefix_template: string;
  target_internal_locator: string;
  target_secret_reference_id: string;
  latest_attempt_number: string | number | null;
}

interface RetentionCandidateRow extends Record<string, unknown> {
  storage_object_id: string;
  primary_storage_object_copy_id: string;
  verified_checksum_sha256: string;
  verified_byte_length: string | number;
  primary_connection_id: string;
  primary_bucket_label: string;
  primary_prefix_template: string;
  primary_internal_locator: string;
  primary_secret_reference_id: string;
  latest_attempt_number: string | number | null;
}

interface RetentionReplicaRow extends Record<string, unknown> {
  storage_object_copy_id: string;
  copy_state: string;
  observed_checksum_sha256: string | null;
  observed_byte_length: string | number | null;
  connection_id: string;
  bucket_label: string;
  internal_locator: string;
  secret_reference_id: string;
}

const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,95}$/;

function safeCode(value: string): string {
  return SAFE_CODE_PATTERN.test(value) ? value : 'storage-replica-protection-failed';
}

function integer(value: string | number, code: string): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new ReplicaProtectionError('dependency-unavailable', code, true);
  }
  return result;
}

async function transaction<T>(
  pool: ReplicaProtectionPostgresPool,
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
      // Preserve the original bounded error.
    }
    throw error;
  } finally {
    client.release();
  }
}

function storeFailure(error: unknown, code: string): ReplicaProtectionError {
  if (error instanceof ReplicaProtectionError) return error;
  return new ReplicaProtectionError('dependency-unavailable', code, true);
}

function writeTarget(input: {
  role: 'primary' | 'replica';
  connectionId: string;
  bucketLabel: string;
  prefixTemplate: string;
  internalLocator: string;
  secretReferenceId: string;
}): Readonly<ResolvedProviderWriteTarget> {
  return Object.freeze({
    providerRole: input.role,
    providerId: input.connectionId,
    bucketLabel: input.bucketLabel,
    internalLocator: input.internalLocator,
    normalizedPrefixPattern: input.prefixTemplate,
    capabilityPolicy: Object.freeze({
      checksumVerification: 'required' as const,
      sizeVerification: 'required-when-supported' as const,
      headContentLength: 'required' as const,
      rangeRead: 'optional' as const,
    }),
    credentialSecretReferenceId: input.secretReferenceId,
  });
}

function readTarget(input: {
  role: 'primary' | 'replica';
  connectionId: string;
  bucketLabel: string;
  internalLocator: string;
  secretReferenceId: string;
}): Readonly<ResolvedProviderReadTarget> {
  return Object.freeze({
    providerRole: input.role,
    providerId: input.connectionId,
    bucketLabel: input.bucketLabel,
    internalLocator: input.internalLocator,
    credentialSecretReferenceId: input.secretReferenceId,
  });
}

async function lockObject(client: PostgresClientLike, storageObjectId: string): Promise<void> {
  const result = await client.query(
    `SELECT storage_object_id
       FROM public.storage_objects
      WHERE storage_object_id = $1
      FOR UPDATE`,
    [storageObjectId],
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new ReplicaProtectionError('duplicate-conflict', 'storage-object-protection-conflict');
  }
}

async function setRepairProtectionState(
  client: PostgresClientLike,
  storageObjectId: string,
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE public.storage_objects
        SET registry_state = 'degraded',
            object_protection_stage = 'configuration-replica-repair-required',
            updated_at = $2,
            row_version = row_version + 1
      WHERE storage_object_id = $1
        AND registry_state NOT IN ('delete_pending', 'deleted')`,
    [storageObjectId, now],
  );
}

export class PostgresReplicaProtectionStore implements ReplicaProtectionStore {
  readonly #pool: ReplicaProtectionPostgresPool;
  readonly #createId: () => string;

  constructor(pool: ReplicaProtectionPostgresPool, createId: () => string = randomUUID) {
    this.#pool = pool;
    this.#createId = createId;
  }

  async claimRepair(input: {
    clientId: string;
    environment: ClientStorageEnvironment;
    workerId: string;
    now?: Date;
  }): Promise<Readonly<ReplicaProtectionRepairJob> | null> {
    const now = input.now ?? new Date();
    const leaseToken = this.#createId();
    try {
      return await transaction(this.#pool, async (client) => {
        const candidate = (await client.query<RepairClaimRow>(
          `SELECT
             object_record.storage_object_id,
             replica.storage_object_copy_id AS target_storage_object_copy_id,
             primary_copy.storage_object_copy_id AS source_storage_object_copy_id,
             replica.configuration_route_target_id,
             object_record.verified_checksum_sha256,
             object_record.verified_byte_length,
             source_connection.connection_id AS source_connection_id,
             source_vault.bucket_label AS source_bucket_label,
             primary_copy.internal_locator AS source_internal_locator,
             source_connection.secret_reference_id AS source_secret_reference_id,
             target_connection.connection_id AS target_connection_id,
             target_vault.bucket_label AS target_bucket_label,
             target_vault.prefix_template AS target_prefix_template,
             replica.internal_locator AS target_internal_locator,
             target_connection.secret_reference_id AS target_secret_reference_id,
             latest.attempt_number AS latest_attempt_number
           FROM public.storage_object_copies AS replica
           JOIN public.storage_objects AS object_record
             ON object_record.storage_object_id = replica.storage_object_id
           JOIN public.storage_control_clients AS clients
             ON clients.id = object_record.storage_control_client_id
           JOIN public.storage_control_configuration_versions AS versions
             ON versions.storage_control_client_id = object_record.storage_control_client_id
            AND versions.id = object_record.configuration_version_id
           JOIN public.storage_object_copies AS primary_copy
             ON primary_copy.storage_object_id = object_record.storage_object_id
            AND primary_copy.configuration_route_target_id IS NOT NULL
            AND primary_copy.target_role = 'primary'
            AND primary_copy.target_order = 0
            AND primary_copy.copy_state = 'verified'
            AND primary_copy.observed_checksum_sha256 = object_record.verified_checksum_sha256
            AND primary_copy.observed_byte_length = object_record.verified_byte_length
           JOIN public.storage_control_configuration_vaults AS source_vault
             ON source_vault.id = primary_copy.configuration_vault_id
            AND source_vault.storage_control_client_id = object_record.storage_control_client_id
            AND source_vault.configuration_version_id = object_record.configuration_version_id
           JOIN public.storage_control_provider_connections AS source_connection
             ON source_connection.id = primary_copy.provider_connection_id
            AND source_connection.storage_control_client_id = object_record.storage_control_client_id
            AND source_connection.status = 'active'
           JOIN public.storage_control_configuration_vaults AS target_vault
             ON target_vault.id = replica.configuration_vault_id
            AND target_vault.storage_control_client_id = object_record.storage_control_client_id
            AND target_vault.configuration_version_id = object_record.configuration_version_id
           JOIN public.storage_control_provider_connections AS target_connection
             ON target_connection.id = replica.provider_connection_id
            AND target_connection.storage_control_client_id = object_record.storage_control_client_id
            AND target_connection.status = 'active'
           LEFT JOIN LATERAL (
             SELECT attempt_number, state, retryable, next_retry_at, lease_expires_at
               FROM public.storage_provider_attempts AS attempt
              WHERE attempt.storage_object_copy_id = replica.storage_object_copy_id
                AND attempt.operation = 'repair'
                AND attempt.operation_reference LIKE 'async-replica:%'
              ORDER BY attempt.attempt_number DESC
              LIMIT 1
           ) AS latest ON true
          WHERE clients.client_id = $1
            AND clients.status = 'active'
            AND versions.environment = $2
            AND replica.configuration_route_target_id IS NOT NULL
            AND replica.target_role = 'replica'
            AND replica.copy_state IN ('pending', 'failed', 'missing')
            AND object_record.registry_state IN ('active', 'degraded')
            AND object_record.verified_checksum_sha256 = object_record.expected_checksum_sha256
            AND object_record.verified_byte_length = object_record.expected_byte_length
            AND (
              latest.attempt_number IS NULL
              OR (
                latest.state = 'failed'
                AND latest.retryable = true
                AND latest.next_retry_at IS NOT NULL
                AND latest.next_retry_at <= $3
              )
              OR (
                latest.state = 'in_progress'
                AND latest.lease_expires_at IS NOT NULL
                AND latest.lease_expires_at <= $3
              )
            )
            AND COALESCE(latest.attempt_number, 0) < $4
          ORDER BY replica.updated_at, replica.storage_object_copy_id
          FOR UPDATE OF replica SKIP LOCKED
          LIMIT 1`,
          [input.clientId, input.environment, now, REPLICA_PROTECTION_LIMITS.maximumAttempts],
        )).rows[0];
        if (candidate === undefined) return null;

        await client.query(
          `UPDATE public.storage_provider_attempts
              SET state = 'failed',
                  retryable = true,
                  next_retry_at = $2,
                  lease_owner = NULL,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  safe_diagnostic_category = 'dependency-unavailable',
                  safe_diagnostic_code = 'storage-replica-lease-expired',
                  finished_at = $2,
                  updated_at = $2
            WHERE storage_object_copy_id = $1
              AND operation = 'repair'
              AND operation_reference LIKE 'async-replica:%'
              AND state = 'in_progress'
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at <= $2`,
          [candidate.target_storage_object_copy_id, now],
        );

        const attemptNumber = integer(candidate.latest_attempt_number ?? 0, 'storage-replica-attempt-invalid') + 1;
        const providerAttemptId = this.#createId();
        const byteLength = integer(candidate.verified_byte_length, 'storage-replica-length-invalid');
        await client.query(
          `INSERT INTO public.storage_provider_attempts (
             storage_provider_attempt_id,
             storage_object_copy_id,
             storage_object_id,
             operation,
             operation_reference,
             attempt_number,
             state,
             retryable,
             lease_owner,
             lease_token,
             lease_expires_at,
             expected_checksum_sha256,
             expected_byte_length,
             started_at,
             created_at,
             updated_at
           ) VALUES (
             $1, $2, $3, 'repair', $4, $5, 'in_progress', false,
             $6, $7, $8 + ($9::bigint * interval '1 millisecond'),
             $10, $11, $8, $8, $8
           )`,
          [
            providerAttemptId,
            candidate.target_storage_object_copy_id,
            candidate.storage_object_id,
            `async-replica:${candidate.source_storage_object_copy_id}`,
            attemptNumber,
            input.workerId,
            leaseToken,
            now,
            REPLICA_PROTECTION_LIMITS.leaseDurationMs,
            candidate.verified_checksum_sha256,
            byteLength,
          ],
        );
        return Object.freeze({
          providerAttemptId,
          attemptNumber,
          leaseToken,
          storageObjectId: candidate.storage_object_id,
          sourceStorageObjectCopyId: candidate.source_storage_object_copy_id,
          targetStorageObjectCopyId: candidate.target_storage_object_copy_id,
          expectedChecksumSha256: candidate.verified_checksum_sha256,
          expectedByteLength: byteLength,
          sourceTarget: readTarget({
            role: 'primary',
            connectionId: candidate.source_connection_id,
            bucketLabel: candidate.source_bucket_label,
            internalLocator: candidate.source_internal_locator,
            secretReferenceId: candidate.source_secret_reference_id,
          }),
          targetReadTarget: readTarget({
            role: 'replica',
            connectionId: candidate.target_connection_id,
            bucketLabel: candidate.target_bucket_label,
            internalLocator: candidate.target_internal_locator,
            secretReferenceId: candidate.target_secret_reference_id,
          }),
          targetWriteTarget: writeTarget({
            role: 'replica',
            connectionId: candidate.target_connection_id,
            bucketLabel: candidate.target_bucket_label,
            prefixTemplate: candidate.target_prefix_template,
            internalLocator: candidate.target_internal_locator,
            secretReferenceId: candidate.target_secret_reference_id,
          }),
        });
      });
    } catch (error) {
      throw storeFailure(error, 'storage-replica-claim-unavailable');
    }
  }

  async completeRepair(job: Readonly<ReplicaProtectionRepairJob>, now = new Date()): Promise<void> {
    try {
      await transaction(this.#pool, async (client) => {
        await lockObject(client, job.storageObjectId);
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
                  verified_at = $6,
                  finished_at = $6,
                  updated_at = $6
            WHERE storage_provider_attempt_id = $1
              AND storage_object_copy_id = $2
              AND storage_object_id = $3
              AND state = 'in_progress'
              AND lease_token = $7
              AND lease_expires_at > $6`,
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
                  observed_checksum_sha256 = $4,
                  observed_byte_length = $5,
                  latest_verified_at = $6,
                  absent_at = NULL,
                  updated_at = $6,
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
                   AND object_record.verified_checksum_sha256 = $4
                   AND object_record.verified_byte_length = $5
              )`,
          [
            job.targetStorageObjectCopyId,
            job.storageObjectId,
            job.sourceStorageObjectCopyId,
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
        const rows = states.rows;
        const primary = rows.filter((row) => row.target_role === 'primary');
        const replicas = rows.filter((row) => row.target_role === 'replica');
        const exact = (row: (typeof rows)[number]): boolean =>
          row.copy_state === 'verified' &&
          row.observed_checksum_sha256 === row.verified_checksum_sha256 &&
          integer(row.observed_byte_length ?? -1, 'storage-replica-length-invalid') ===
            integer(row.verified_byte_length, 'storage-replica-length-invalid');
        const ready = primary.length === 1 && exact(primary[0]!) && replicas.length > 0 && replicas.every(exact);
        await client.query(
          `UPDATE public.storage_objects
              SET registry_state = $2,
                  object_protection_stage = $3,
                  updated_at = $4,
                  row_version = row_version + 1
            WHERE storage_object_id = $1`,
          [
            job.storageObjectId,
            ready ? 'active' : 'degraded',
            ready ? 'configuration-primary-and-replicas-verified' : 'configuration-replica-repair-required',
            now,
          ],
        );
      });
    } catch (error) {
      throw storeFailure(error, 'storage-replica-completion-unavailable');
    }
  }

  async failRepair(input: {
    job: Readonly<ReplicaProtectionRepairJob>;
    category: ReplicaProtectionDiagnosticCategory;
    code: string;
    retryable: boolean;
    now?: Date;
  }): Promise<void> {
    const now = input.now ?? new Date();
    const canRetry = input.retryable && input.job.attemptNumber < REPLICA_PROTECTION_LIMITS.maximumAttempts;
    try {
      await transaction(this.#pool, async (client) => {
        await lockObject(client, input.job.storageObjectId);
        const attempt = await client.query(
          `UPDATE public.storage_provider_attempts
              SET state = 'failed',
                  retryable = $4,
                  next_retry_at = CASE
                    WHEN $4 THEN $5 + ($6::bigint * interval '1 millisecond')
                    ELSE NULL
                  END,
                  lease_owner = NULL,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  safe_diagnostic_category = $7,
                  safe_diagnostic_code = $8,
                  finished_at = $5,
                  updated_at = $5
            WHERE storage_provider_attempt_id = $1
              AND storage_object_copy_id = $2
              AND storage_object_id = $3
              AND state = 'in_progress'
              AND lease_token = $9
              AND lease_expires_at > $5`,
          [
            input.job.providerAttemptId,
            input.job.targetStorageObjectCopyId,
            input.job.storageObjectId,
            canRetry,
            now,
            REPLICA_PROTECTION_LIMITS.retryDelayMs,
            input.category,
            safeCode(input.code),
            input.job.leaseToken,
          ],
        );
        if ((attempt.rowCount ?? 0) !== 1) {
          throw new ReplicaProtectionError('duplicate-conflict', 'storage-replica-lease-lost');
        }
        await client.query(
          `UPDATE public.storage_object_copies
              SET copy_state = 'failed',
                  updated_at = $3,
                  row_version = row_version + 1
            WHERE storage_object_copy_id = $1
              AND storage_object_id = $2
              AND target_role = 'replica'
              AND copy_state IN ('pending', 'failed', 'missing')`,
          [input.job.targetStorageObjectCopyId, input.job.storageObjectId, now],
        );
        await setRepairProtectionState(client, input.job.storageObjectId, now);
      });
    } catch (error) {
      throw storeFailure(error, 'storage-replica-failure-recording-unavailable');
    }
  }

  async claimRetention(input: {
    clientId: string;
    environment: ClientStorageEnvironment;
    workerId: string;
    now?: Date;
  }): Promise<ReplicaProtectionRetentionClaim> {
    const now = input.now ?? new Date();
    const leaseToken = this.#createId();
    try {
      return await transaction(this.#pool, async (client) => {
        const candidate = (await client.query<RetentionCandidateRow>(
          `SELECT
             object_record.storage_object_id,
             primary_copy.storage_object_copy_id AS primary_storage_object_copy_id,
             object_record.verified_checksum_sha256,
             object_record.verified_byte_length,
             primary_connection.connection_id AS primary_connection_id,
             primary_vault.bucket_label AS primary_bucket_label,
             primary_vault.prefix_template AS primary_prefix_template,
             primary_copy.internal_locator AS primary_internal_locator,
             primary_connection.secret_reference_id AS primary_secret_reference_id,
             latest.attempt_number AS latest_attempt_number
           FROM public.storage_object_copies AS primary_copy
           JOIN public.storage_objects AS object_record
             ON object_record.storage_object_id = primary_copy.storage_object_id
           JOIN public.storage_control_clients AS clients
             ON clients.id = object_record.storage_control_client_id
           JOIN public.storage_control_configuration_versions AS versions
             ON versions.storage_control_client_id = object_record.storage_control_client_id
            AND versions.id = object_record.configuration_version_id
           JOIN public.storage_control_configuration_vaults AS primary_vault
             ON primary_vault.id = primary_copy.configuration_vault_id
            AND primary_vault.storage_control_client_id = object_record.storage_control_client_id
            AND primary_vault.configuration_version_id = object_record.configuration_version_id
           JOIN public.storage_control_provider_connections AS primary_connection
             ON primary_connection.id = primary_copy.provider_connection_id
            AND primary_connection.storage_control_client_id = object_record.storage_control_client_id
            AND primary_connection.status = 'active'
           LEFT JOIN LATERAL (
             SELECT attempt_number, state, retryable, next_retry_at, lease_expires_at
               FROM public.storage_provider_attempts AS attempt
              WHERE attempt.storage_object_copy_id = primary_copy.storage_object_copy_id
                AND attempt.operation = 'delete'
                AND attempt.operation_reference = 'protected-primary-retention'
              ORDER BY attempt.attempt_number DESC
              LIMIT 1
           ) AS latest ON true
          WHERE clients.client_id = $1
            AND clients.status = 'active'
            AND versions.environment = $2
            AND primary_copy.configuration_route_target_id IS NOT NULL
            AND primary_copy.target_role = 'primary'
            AND primary_copy.target_order = 0
            AND primary_copy.copy_state = 'verified'
            AND primary_copy.observed_checksum_sha256 = object_record.verified_checksum_sha256
            AND primary_copy.observed_byte_length = object_record.verified_byte_length
            AND object_record.registry_state IN ('active', 'degraded')
            AND object_record.verified_checksum_sha256 = object_record.expected_checksum_sha256
            AND object_record.verified_byte_length = object_record.expected_byte_length
            AND primary_vault.retention_mode = 'delete-after-days'
            AND primary_vault.delete_after_days IS NOT NULL
            AND primary_copy.latest_verified_at IS NOT NULL
            AND primary_copy.latest_verified_at +
                (primary_vault.delete_after_days::bigint * interval '1 day') <= $3
            AND (
              latest.attempt_number IS NULL
              OR (
                latest.state = 'failed'
                AND latest.retryable = true
                AND latest.next_retry_at IS NOT NULL
                AND latest.next_retry_at <= $3
              )
              OR (
                latest.state = 'in_progress'
                AND latest.lease_expires_at IS NOT NULL
                AND latest.lease_expires_at <= $3
              )
            )
            AND COALESCE(latest.attempt_number, 0) < $4
          ORDER BY primary_copy.latest_verified_at, primary_copy.storage_object_copy_id
          FOR UPDATE OF primary_copy SKIP LOCKED
          LIMIT 1`,
          [input.clientId, input.environment, now, REPLICA_PROTECTION_LIMITS.maximumAttempts],
        )).rows[0];
        if (candidate === undefined) return Object.freeze({ kind: 'idle' as const });

        await client.query(
          `UPDATE public.storage_provider_attempts
              SET state = 'failed',
                  retryable = true,
                  next_retry_at = $2,
                  lease_owner = NULL,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  safe_diagnostic_category = 'dependency-unavailable',
                  safe_diagnostic_code = 'storage-retention-lease-expired',
                  finished_at = $2,
                  updated_at = $2
            WHERE storage_object_copy_id = $1
              AND operation = 'delete'
              AND operation_reference = 'protected-primary-retention'
              AND state = 'in_progress'
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at <= $2`,
          [candidate.primary_storage_object_copy_id, now],
        );

        const replicas = (await client.query<RetentionReplicaRow>(
          `SELECT
             copy.storage_object_copy_id,
             copy.copy_state,
             copy.observed_checksum_sha256,
             copy.observed_byte_length,
             connection.connection_id,
             vault.bucket_label,
             copy.internal_locator,
             connection.secret_reference_id
           FROM public.storage_object_copies AS copy
           JOIN public.storage_control_configuration_vaults AS vault
             ON vault.id = copy.configuration_vault_id
           JOIN public.storage_control_provider_connections AS connection
             ON connection.id = copy.provider_connection_id
            AND connection.status = 'active'
          WHERE copy.storage_object_id = $1
            AND copy.configuration_route_target_id IS NOT NULL
            AND copy.target_role = 'replica'
          ORDER BY copy.target_order, copy.storage_object_copy_id
          FOR UPDATE OF copy`,
          [candidate.storage_object_id],
        )).rows;
        const expectedLength = integer(candidate.verified_byte_length, 'storage-retention-length-invalid');
        const invalidVerifiedReplicaIds = replicas
          .filter((replica) => replica.copy_state === 'verified' && (
            replica.observed_checksum_sha256 !== candidate.verified_checksum_sha256 ||
            integer(replica.observed_byte_length ?? -1, 'storage-retention-length-invalid') !== expectedLength
          ))
          .map((replica) => replica.storage_object_copy_id);
        if (invalidVerifiedReplicaIds.length > 0) {
          await client.query(
            `UPDATE public.storage_object_copies
                SET copy_state = 'failed',
                    updated_at = $3,
                    row_version = row_version + 1
              WHERE storage_object_id = $1
                AND storage_object_copy_id = ANY($2::uuid[])
                AND target_role = 'replica'
                AND copy_state = 'verified'`,
            [candidate.storage_object_id, invalidVerifiedReplicaIds, now],
          );
        }
        const protectedByReplica = replicas.length > 0 && replicas.every((replica) =>
          replica.copy_state === 'verified' &&
          replica.observed_checksum_sha256 === candidate.verified_checksum_sha256 &&
          integer(replica.observed_byte_length ?? -1, 'storage-retention-length-invalid') === expectedLength,
        );
        if (!protectedByReplica) {
          await setRepairProtectionState(client, candidate.storage_object_id, now);
          return Object.freeze({ kind: 'blocked' as const });
        }

        const attemptNumber = integer(candidate.latest_attempt_number ?? 0, 'storage-retention-attempt-invalid') + 1;
        const providerAttemptId = this.#createId();
        await client.query(
          `INSERT INTO public.storage_provider_attempts (
             storage_provider_attempt_id,
             storage_object_copy_id,
             storage_object_id,
             operation,
             operation_reference,
             attempt_number,
             state,
             retryable,
             lease_owner,
             lease_token,
             lease_expires_at,
             expected_checksum_sha256,
             expected_byte_length,
             started_at,
             created_at,
             updated_at
           ) VALUES (
             $1, $2, $3, 'delete', 'protected-primary-retention', $4,
             'in_progress', false, $5, $6,
             $7 + ($8::bigint * interval '1 millisecond'),
             $9, $10, $7, $7, $7
           )`,
          [
            providerAttemptId,
            candidate.primary_storage_object_copy_id,
            candidate.storage_object_id,
            attemptNumber,
            input.workerId,
            leaseToken,
            now,
            REPLICA_PROTECTION_LIMITS.leaseDurationMs,
            candidate.verified_checksum_sha256,
            expectedLength,
          ],
        );
        const job: ReplicaProtectionRetentionJob = Object.freeze({
          providerAttemptId,
          attemptNumber,
          leaseToken,
          storageObjectId: candidate.storage_object_id,
          primaryStorageObjectCopyId: candidate.primary_storage_object_copy_id,
          expectedChecksumSha256: candidate.verified_checksum_sha256,
          expectedByteLength: expectedLength,
          primaryTarget: writeTarget({
            role: 'primary',
            connectionId: candidate.primary_connection_id,
            bucketLabel: candidate.primary_bucket_label,
            prefixTemplate: candidate.primary_prefix_template,
            internalLocator: candidate.primary_internal_locator,
            secretReferenceId: candidate.primary_secret_reference_id,
          }),
          protectionCopies: Object.freeze(replicas.map((replica) => Object.freeze({
            storageObjectCopyId: replica.storage_object_copy_id,
            target: readTarget({
              role: 'replica',
              connectionId: replica.connection_id,
              bucketLabel: replica.bucket_label,
              internalLocator: replica.internal_locator,
              secretReferenceId: replica.secret_reference_id,
            }),
          }))),
        });
        return Object.freeze({ kind: 'job' as const, job });
      });
    } catch (error) {
      throw storeFailure(error, 'storage-retention-claim-unavailable');
    }
  }

  async completeRetention(job: Readonly<ReplicaProtectionRetentionJob>, now = new Date()): Promise<void> {
    try {
      await transaction(this.#pool, async (client) => {
        await lockObject(client, job.storageObjectId);
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
                  verified_at = $6,
                  finished_at = $6,
                  updated_at = $6
            WHERE storage_provider_attempt_id = $1
              AND storage_object_copy_id = $2
              AND storage_object_id = $3
              AND state = 'in_progress'
              AND lease_token = $7
              AND lease_expires_at > $6`,
          [
            job.providerAttemptId,
            job.primaryStorageObjectCopyId,
            job.storageObjectId,
            job.expectedChecksumSha256,
            job.expectedByteLength,
            now,
            job.leaseToken,
          ],
        );
        if ((attempt.rowCount ?? 0) !== 1) {
          throw new ReplicaProtectionError('duplicate-conflict', 'storage-retention-lease-lost');
        }
        const copy = await client.query(
          `UPDATE public.storage_object_copies
              SET copy_state = 'deleted',
                  delete_requested_at = COALESCE(delete_requested_at, $3),
                  deleted_at = $3,
                  updated_at = $3,
                  row_version = row_version + 1
            WHERE storage_object_copy_id = $1
              AND storage_object_id = $2
              AND target_role = 'primary'
              AND copy_state = 'verified'`,
          [job.primaryStorageObjectCopyId, job.storageObjectId, now],
        );
        if ((copy.rowCount ?? 0) !== 1) {
          throw new ReplicaProtectionError('duplicate-conflict', 'storage-retention-copy-conflict');
        }
        await client.query(
          `UPDATE public.storage_objects
              SET registry_state = 'active',
                  object_protection_stage = 'configuration-primary-retention-cleaned',
                  updated_at = $2,
                  row_version = row_version + 1
            WHERE storage_object_id = $1
              AND EXISTS (
                SELECT 1
                  FROM public.storage_object_copies AS replica
                 WHERE replica.storage_object_id = $1
                   AND replica.target_role = 'replica'
                   AND replica.copy_state = 'verified'
                   AND replica.observed_checksum_sha256 = public.storage_objects.verified_checksum_sha256
                   AND replica.observed_byte_length = public.storage_objects.verified_byte_length
              )`,
          [job.storageObjectId, now],
        );
      });
    } catch (error) {
      throw storeFailure(error, 'storage-retention-completion-unavailable');
    }
  }

  async failRetention(input: {
    job: Readonly<ReplicaProtectionRetentionJob>;
    category: ReplicaProtectionDiagnosticCategory;
    code: string;
    retryable: boolean;
    invalidateReplicaCopyId?: string;
    now?: Date;
  }): Promise<void> {
    const now = input.now ?? new Date();
    const canRetry = input.retryable && input.job.attemptNumber < REPLICA_PROTECTION_LIMITS.maximumAttempts;
    try {
      await transaction(this.#pool, async (client) => {
        await lockObject(client, input.job.storageObjectId);
        const attempt = await client.query(
          `UPDATE public.storage_provider_attempts
              SET state = 'failed',
                  retryable = $4,
                  next_retry_at = CASE
                    WHEN $4 THEN $5 + ($6::bigint * interval '1 millisecond')
                    ELSE NULL
                  END,
                  lease_owner = NULL,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  safe_diagnostic_category = $7,
                  safe_diagnostic_code = $8,
                  finished_at = $5,
                  updated_at = $5
            WHERE storage_provider_attempt_id = $1
              AND storage_object_copy_id = $2
              AND storage_object_id = $3
              AND state = 'in_progress'
              AND lease_token = $9
              AND lease_expires_at > $5`,
          [
            input.job.providerAttemptId,
            input.job.primaryStorageObjectCopyId,
            input.job.storageObjectId,
            canRetry,
            now,
            REPLICA_PROTECTION_LIMITS.retryDelayMs,
            input.category,
            safeCode(input.code),
            input.job.leaseToken,
          ],
        );
        if ((attempt.rowCount ?? 0) !== 1) {
          throw new ReplicaProtectionError('duplicate-conflict', 'storage-retention-lease-lost');
        }
        if (input.invalidateReplicaCopyId !== undefined) {
          await client.query(
            `UPDATE public.storage_object_copies
                SET copy_state = 'failed',
                    updated_at = $3,
                    row_version = row_version + 1
              WHERE storage_object_copy_id = $1
                AND storage_object_id = $2
                AND target_role = 'replica'
                AND copy_state = 'verified'`,
            [input.invalidateReplicaCopyId, input.job.storageObjectId, now],
          );
          await setRepairProtectionState(client, input.job.storageObjectId, now);
        }
      });
    } catch (error) {
      throw storeFailure(error, 'storage-retention-failure-recording-unavailable');
    }
  }
}

interface VerificationResult {
  readonly state: 'verified' | 'missing' | 'mismatch';
}

async function verifyProviderObject(
  reader: ProviderObjectReader,
  target: Readonly<ResolvedProviderReadTarget>,
  checksumSha256: string,
  byteLength: number,
): Promise<Readonly<VerificationResult>> {
  let opened: Awaited<ReturnType<ProviderObjectReader['get']>> | undefined;
  try {
    opened = await reader.get({ target });
  } catch (error) {
    if (error instanceof ProviderReadExecutionError && error.code === 'provider-read-missing') {
      return Object.freeze({ state: 'missing' });
    }
    throw new ReplicaProtectionError(
      'dependency-unavailable',
      'storage-replica-read-unavailable',
      true,
    );
  }
  try {
    if (opened.byteLength !== byteLength) return Object.freeze({ state: 'mismatch' });
    const hash = createHash('sha256');
    let observedLength = 0;
    for await (const chunk of opened.body) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(Buffer.from(chunk as string));
      observedLength += bytes.byteLength;
      if (observedLength > byteLength) return Object.freeze({ state: 'mismatch' });
      hash.update(bytes);
    }
    return Object.freeze({
      state: observedLength === byteLength && hash.digest('hex') === checksumSha256
        ? 'verified'
        : 'mismatch',
    });
  } finally {
    opened.close();
  }
}

function sourceMirror(input: {
  body: Readable;
  expectedByteLength: number;
}): Readonly<{
  body: Readable;
  result(): Readonly<{ checksumSha256: string; byteLength: number; completed: boolean }>;
}> {
  const hash = createHash('sha256');
  let byteLength = 0;
  let completed = false;
  const body = Readable.from((async function* (): AsyncGenerator<Uint8Array> {
    for await (const chunk of input.body) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(Buffer.from(chunk as string));
      byteLength += bytes.byteLength;
      if (byteLength > input.expectedByteLength) {
        throw new ReplicaProtectionError('not-ready', 'storage-primary-integrity-mismatch');
      }
      hash.update(bytes);
      yield bytes;
    }
    completed = true;
  })());
  return Object.freeze({
    body,
    result: () => Object.freeze({
      checksumSha256: hash.copy().digest('hex'),
      byteLength,
      completed,
    }),
  });
}

function normalizedError(error: unknown): ReplicaProtectionError {
  if (error instanceof ReplicaProtectionError) return error;
  if (error instanceof ProviderExecutionError) {
    return new ReplicaProtectionError('dependency-unavailable', safeCode(error.code), error.retryable);
  }
  if (error instanceof ProviderReadExecutionError) {
    return new ReplicaProtectionError('dependency-unavailable', safeCode(error.code), error.retryable);
  }
  return new ReplicaProtectionError('internal', 'storage-replica-protection-failed');
}

export interface ReplicaProtectionWorkerBatchResult {
  readonly processed: number;
  readonly idle: number;
  readonly failed: number;
  readonly blocked: number;
}

export class ReplicaProtectionApplicationService {
  readonly #store: ReplicaProtectionStore;
  readonly #reader: ProviderObjectReader;
  readonly #writer: ProviderObjectWriter;

  constructor(input: Readonly<{
    store: ReplicaProtectionStore;
    reader: ProviderObjectReader;
    writer: ProviderObjectWriter;
  }>) {
    this.#store = input.store;
    this.#reader = input.reader;
    this.#writer = input.writer;
  }

  async processRepair(job: Readonly<ReplicaProtectionRepairJob>, now = new Date()): Promise<void> {
    try {
      const existing = await verifyProviderObject(
        this.#reader,
        job.targetReadTarget,
        job.expectedChecksumSha256,
        job.expectedByteLength,
      );
      if (existing.state === 'verified') {
        await this.#store.completeRepair(job, now);
        return;
      }
      if (existing.state === 'mismatch') {
        const cleanup = await this.#writer.cleanup({ target: job.targetWriteTarget });
        if (!cleanup.deleted) {
          throw new ReplicaProtectionError(
            'dependency-unavailable',
            cleanup.diagnostic?.code ?? 'storage-replica-cleanup-failed',
            cleanup.diagnostic?.retryable ?? true,
          );
        }
      }

      let source: Awaited<ReturnType<ProviderObjectReader['get']>>;
      try {
        source = await this.#reader.get({ target: job.sourceTarget });
      } catch {
        throw new ReplicaProtectionError(
          'dependency-unavailable',
          'storage-primary-read-unavailable',
          true,
        );
      }
      try {
        if (source.byteLength !== job.expectedByteLength) {
          throw new ReplicaProtectionError('not-ready', 'storage-primary-integrity-mismatch');
        }
        const mirrored = sourceMirror({
          body: source.body,
          expectedByteLength: job.expectedByteLength,
        });
        try {
          await this.#writer.write({
            target: job.targetWriteTarget,
            source: mirrored.body,
            checksumSha256: job.expectedChecksumSha256,
            byteLength: job.expectedByteLength,
          });
        } catch (error) {
          const raced = await verifyProviderObject(
            this.#reader,
            job.targetReadTarget,
            job.expectedChecksumSha256,
            job.expectedByteLength,
          );
          if (raced.state !== 'verified') {
            if (error instanceof ProviderExecutionError && error.cleanupRequired) {
              await this.#writer.cleanup({ target: job.targetWriteTarget });
            }
            throw error;
          }
        }
        const mirroredResult = mirrored.result();
        if (
          !mirroredResult.completed ||
          mirroredResult.byteLength !== job.expectedByteLength ||
          mirroredResult.checksumSha256 !== job.expectedChecksumSha256
        ) {
          await this.#writer.cleanup({ target: job.targetWriteTarget });
          throw new ReplicaProtectionError('not-ready', 'storage-primary-integrity-mismatch');
        }
      } finally {
        source.close();
      }

      const verified = await verifyProviderObject(
        this.#reader,
        job.targetReadTarget,
        job.expectedChecksumSha256,
        job.expectedByteLength,
      );
      if (verified.state !== 'verified') {
        await this.#writer.cleanup({ target: job.targetWriteTarget });
        throw new ReplicaProtectionError(
          'dependency-unavailable',
          'storage-replica-verification-mismatch',
          true,
        );
      }
      await this.#store.completeRepair(job, now);
    } catch (error) {
      const normalized = normalizedError(error);
      await this.#store.failRepair({
        job,
        category: normalized.category,
        code: normalized.code,
        retryable: normalized.retryable,
        now,
      });
    }
  }

  async processRetention(
    claim: ReplicaProtectionRetentionClaim,
    now = new Date(),
  ): Promise<'processed' | 'blocked' | 'idle'> {
    if (claim.kind === 'idle') return 'idle';
    if (claim.kind === 'blocked') return 'blocked';
    const job = claim.job;
    try {
      for (const protection of job.protectionCopies) {
        const verified = await verifyProviderObject(
          this.#reader,
          protection.target,
          job.expectedChecksumSha256,
          job.expectedByteLength,
        );
        if (verified.state !== 'verified') {
          await this.#store.failRetention({
            job,
            category: verified.state === 'missing' ? 'not-ready' : 'dependency-unavailable',
            code: verified.state === 'missing'
              ? 'storage-retention-protection-copy-missing'
              : 'storage-retention-protection-integrity-mismatch',
            retryable: true,
            invalidateReplicaCopyId: protection.storageObjectCopyId,
            now,
          });
          return 'blocked';
        }
      }
      const cleanup = await this.#writer.cleanup({ target: job.primaryTarget });
      if (!cleanup.deleted) {
        throw new ReplicaProtectionError(
          'dependency-unavailable',
          cleanup.diagnostic?.code ?? 'storage-retention-primary-delete-failed',
          cleanup.diagnostic?.retryable ?? true,
        );
      }
      await this.#store.completeRetention(job, now);
      return 'processed';
    } catch (error) {
      const normalized = normalizedError(error);
      await this.#store.failRetention({
        job,
        category: normalized.category,
        code: normalized.code,
        retryable: normalized.retryable,
        now,
      });
      return 'blocked';
    }
  }
}

export class BoundedReplicaProtectionWorker {
  readonly #store: ReplicaProtectionStore;
  readonly #service: ReplicaProtectionApplicationService;

  constructor(input: Readonly<{
    store: ReplicaProtectionStore;
    reader: ProviderObjectReader;
    writer: ProviderObjectWriter;
  }>) {
    this.#store = input.store;
    this.#service = new ReplicaProtectionApplicationService(input);
  }

  async runRepairBatch(input: {
    clientId: string;
    environment: ClientStorageEnvironment;
    workerId: string;
    now?: Date;
  }): Promise<Readonly<ReplicaProtectionWorkerBatchResult>> {
    const now = input.now ?? new Date();
    let processed = 0;
    let idle = 0;
    let failed = 0;
    for (let index = 0; index < REPLICA_PROTECTION_LIMITS.repairBatchSize; index += 1) {
      const job = await this.#store.claimRepair({
        clientId: input.clientId,
        environment: input.environment,
        workerId: `${input.workerId}:repair:${index + 1}`,
        now,
      });
      if (job === null) {
        idle += 1;
        continue;
      }
      try {
        await this.#service.processRepair(job, now);
        processed += 1;
      } catch {
        failed += 1;
      }
    }
    return Object.freeze({ processed, idle, failed, blocked: 0 });
  }

  async runRetentionBatch(input: {
    clientId: string;
    environment: ClientStorageEnvironment;
    workerId: string;
    now?: Date;
  }): Promise<Readonly<ReplicaProtectionWorkerBatchResult>> {
    const now = input.now ?? new Date();
    let processed = 0;
    let idle = 0;
    let failed = 0;
    let blocked = 0;
    for (let index = 0; index < REPLICA_PROTECTION_LIMITS.retentionBatchSize; index += 1) {
      const claim = await this.#store.claimRetention({
        clientId: input.clientId,
        environment: input.environment,
        workerId: `${input.workerId}:retention:${index + 1}`,
        now,
      });
      try {
        const result = await this.#service.processRetention(claim, now);
        if (result === 'processed') processed += 1;
        else if (result === 'blocked') blocked += 1;
        else idle += 1;
      } catch {
        failed += 1;
      }
    }
    return Object.freeze({ processed, idle, failed, blocked });
  }
}
