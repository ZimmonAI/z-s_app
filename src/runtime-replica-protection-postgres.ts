import { randomUUID } from 'node:crypto';
import type { ClientStorageEnvironment } from './client-storage-configuration.js';
import {
  PostgresReplicaProtectionStore,
  REPLICA_PROTECTION_LIMITS,
  ReplicaProtectionError,
  type ReplicaProtectionRepairJob,
  type ReplicaProtectionRetentionClaim,
  type ReplicaProtectionRetentionJob,
  type ReplicaProtectionStore,
} from './runtime-replica-protection.js';
import type { ResolvedProviderReadTarget } from './runtime-read-delivery.js';
import type { ResolvedProviderWriteTarget } from './runtime-s3-provider.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryable,
} from './runtime-storage-registry-types.js';

interface ProtectionPool extends PostgresPoolLike, PostgresQueryable {}

interface LockedCopyRow extends Record<string, unknown> {
  storage_object_copy_id: string;
}

interface RepairAuthorityRow extends Record<string, unknown> {
  storage_object_id: string;
  target_storage_object_copy_id: string;
  source_storage_object_copy_id: string;
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
  latest_attempt_number: string | number;
}

interface RetentionAuthorityRow extends Record<string, unknown> {
  storage_object_id: string;
  primary_storage_object_copy_id: string;
  verified_checksum_sha256: string;
  verified_byte_length: string | number;
  primary_connection_id: string;
  primary_bucket_label: string;
  primary_prefix_template: string;
  primary_internal_locator: string;
  primary_secret_reference_id: string;
  latest_attempt_number: string | number;
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

function integer(value: string | number, code: string): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new ReplicaProtectionError('dependency-unavailable', code, true);
  }
  return result;
}

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
      // Preserve the original bounded error.
    }
    throw error;
  } finally {
    client.release();
  }
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

async function markRepairRequired(
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

function retryEligibleSql(alias: string, operation: 'repair' | 'delete', reference: string): string {
  return `
    NOT EXISTS (
      SELECT 1
        FROM public.storage_provider_attempts AS latest
       WHERE latest.storage_provider_attempt_id = (
         SELECT prior.storage_provider_attempt_id
           FROM public.storage_provider_attempts AS prior
          WHERE prior.storage_object_copy_id = ${alias}.storage_object_copy_id
            AND prior.operation = '${operation}'
            AND prior.operation_reference ${operation === 'repair' ? "LIKE 'async-replica:%'" : `= '${reference}'`}
          ORDER BY prior.attempt_number DESC
          LIMIT 1
       )
         AND NOT (
           (latest.state = 'failed'
            AND latest.retryable = true
            AND latest.next_retry_at IS NOT NULL
            AND latest.next_retry_at <= $3::timestamptz)
           OR
           (latest.state = 'in_progress'
            AND latest.lease_expires_at IS NOT NULL
            AND latest.lease_expires_at <= $3::timestamptz)
         )
    )
    AND COALESCE((
      SELECT max(prior.attempt_number)
        FROM public.storage_provider_attempts AS prior
       WHERE prior.storage_object_copy_id = ${alias}.storage_object_copy_id
         AND prior.operation = '${operation}'
         AND prior.operation_reference ${operation === 'repair' ? "LIKE 'async-replica:%'" : `= '${reference}'`}
    ), 0) < $4::integer`;
}

/**
 * Claim-layer replacement that keeps row locking independent from optional
 * attempt-history joins. Completion/failure mutations remain delegated to the
 * original CAS implementation.
 */
export class PostgresLeasedReplicaProtectionStore implements ReplicaProtectionStore {
  readonly #pool: ProtectionPool;
  readonly #delegate: PostgresReplicaProtectionStore;
  readonly #createId: () => string;

  constructor(pool: ProtectionPool, createId: () => string = randomUUID) {
    this.#pool = pool;
    this.#delegate = new PostgresReplicaProtectionStore(pool, createId);
    this.#createId = createId;
  }

  completeRepair(job: Readonly<ReplicaProtectionRepairJob>, now?: Date): Promise<void> {
    return this.#delegate.completeRepair(job, now);
  }

  failRepair(input: Parameters<ReplicaProtectionStore['failRepair']>[0]): Promise<void> {
    return this.#delegate.failRepair(input);
  }

  completeRetention(job: Readonly<ReplicaProtectionRetentionJob>, now?: Date): Promise<void> {
    return this.#delegate.completeRetention(job, now);
  }

  failRetention(input: Parameters<ReplicaProtectionStore['failRetention']>[0]): Promise<void> {
    return this.#delegate.failRetention(input);
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
        const locked = (await client.query<LockedCopyRow>(
          `SELECT replica.storage_object_copy_id
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
            WHERE clients.client_id = $1
              AND clients.status = 'active'
              AND versions.environment = $2
              AND replica.configuration_route_target_id IS NOT NULL
              AND replica.target_role = 'replica'
              AND replica.copy_state IN ('pending', 'failed', 'missing')
              AND object_record.registry_state IN ('active', 'degraded')
              AND object_record.verified_checksum_sha256 = object_record.expected_checksum_sha256
              AND object_record.verified_byte_length = object_record.expected_byte_length
              AND ${retryEligibleSql('replica', 'repair', '')}
            ORDER BY replica.updated_at, replica.storage_object_copy_id
            FOR UPDATE OF replica SKIP LOCKED
            LIMIT 1`,
          [input.clientId, input.environment, now, REPLICA_PROTECTION_LIMITS.maximumAttempts],
        )).rows[0];
        if (locked === undefined) return null;

        await client.query(
          `UPDATE public.storage_provider_attempts
              SET state = 'failed',
                  retryable = true,
                  next_retry_at = $2::timestamptz,
                  lease_owner = NULL,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  safe_diagnostic_category = 'dependency-unavailable',
                  safe_diagnostic_code = 'storage-replica-lease-expired',
                  finished_at = $2::timestamptz,
                  updated_at = $2::timestamptz
            WHERE storage_object_copy_id = $1
              AND operation = 'repair'
              AND operation_reference LIKE 'async-replica:%'
              AND state = 'in_progress'
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at <= $2::timestamptz`,
          [locked.storage_object_copy_id, now],
        );

        const authority = (await client.query<RepairAuthorityRow>(
          `SELECT
             object_record.storage_object_id,
             replica.storage_object_copy_id AS target_storage_object_copy_id,
             primary_copy.storage_object_copy_id AS source_storage_object_copy_id,
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
             COALESCE((
               SELECT max(prior.attempt_number)
                 FROM public.storage_provider_attempts AS prior
                WHERE prior.storage_object_copy_id = replica.storage_object_copy_id
                  AND prior.operation = 'repair'
                  AND prior.operation_reference LIKE 'async-replica:%'
             ), 0) AS latest_attempt_number
           FROM public.storage_object_copies AS replica
           JOIN public.storage_objects AS object_record
             ON object_record.storage_object_id = replica.storage_object_id
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
          WHERE replica.storage_object_copy_id = $1`,
          [locked.storage_object_copy_id],
        )).rows[0];
        if (authority === undefined) {
          throw new ReplicaProtectionError('duplicate-conflict', 'storage-replica-authority-conflict');
        }

        const attemptNumber = integer(authority.latest_attempt_number, 'storage-replica-attempt-invalid') + 1;
        const providerAttemptId = this.#createId();
        const byteLength = integer(authority.verified_byte_length, 'storage-replica-length-invalid');
        await client.query(
          `INSERT INTO public.storage_provider_attempts (
             storage_provider_attempt_id, storage_object_copy_id, storage_object_id,
             operation, operation_reference, attempt_number, state, retryable,
             lease_owner, lease_token, lease_expires_at,
             expected_checksum_sha256, expected_byte_length,
             started_at, created_at, updated_at
           ) VALUES (
             $1, $2, $3, 'repair', $4, $5, 'in_progress', false,
             $6, $7,
             $8::timestamptz + ($9::bigint * interval '1 millisecond'),
             $10, $11, $8::timestamptz, $8::timestamptz, $8::timestamptz
           )`,
          [
            providerAttemptId,
            authority.target_storage_object_copy_id,
            authority.storage_object_id,
            `async-replica:${authority.source_storage_object_copy_id}`,
            attemptNumber,
            input.workerId,
            leaseToken,
            now,
            REPLICA_PROTECTION_LIMITS.leaseDurationMs,
            authority.verified_checksum_sha256,
            byteLength,
          ],
        );

        return Object.freeze({
          providerAttemptId,
          attemptNumber,
          leaseToken,
          storageObjectId: authority.storage_object_id,
          sourceStorageObjectCopyId: authority.source_storage_object_copy_id,
          targetStorageObjectCopyId: authority.target_storage_object_copy_id,
          expectedChecksumSha256: authority.verified_checksum_sha256,
          expectedByteLength: byteLength,
          sourceTarget: readTarget({
            role: 'primary',
            connectionId: authority.source_connection_id,
            bucketLabel: authority.source_bucket_label,
            internalLocator: authority.source_internal_locator,
            secretReferenceId: authority.source_secret_reference_id,
          }),
          targetReadTarget: readTarget({
            role: 'replica',
            connectionId: authority.target_connection_id,
            bucketLabel: authority.target_bucket_label,
            internalLocator: authority.target_internal_locator,
            secretReferenceId: authority.target_secret_reference_id,
          }),
          targetWriteTarget: writeTarget({
            role: 'replica',
            connectionId: authority.target_connection_id,
            bucketLabel: authority.target_bucket_label,
            prefixTemplate: authority.target_prefix_template,
            internalLocator: authority.target_internal_locator,
            secretReferenceId: authority.target_secret_reference_id,
          }),
        });
      });
    } catch (error) {
      throw boundedStoreError(error, 'storage-replica-claim-unavailable');
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
        const locked = (await client.query<LockedCopyRow>(
          `SELECT primary_copy.storage_object_copy_id
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
                  (primary_vault.delete_after_days::bigint * interval '1 day') <= $3::timestamptz
              AND ${retryEligibleSql('primary_copy', 'delete', 'protected-primary-retention')}
            ORDER BY primary_copy.latest_verified_at, primary_copy.storage_object_copy_id
            FOR UPDATE OF primary_copy SKIP LOCKED
            LIMIT 1`,
          [input.clientId, input.environment, now, REPLICA_PROTECTION_LIMITS.maximumAttempts],
        )).rows[0];
        if (locked === undefined) return Object.freeze({ kind: 'idle' as const });

        await client.query(
          `UPDATE public.storage_provider_attempts
              SET state = 'failed', retryable = true,
                  next_retry_at = $2::timestamptz,
                  lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                  safe_diagnostic_category = 'dependency-unavailable',
                  safe_diagnostic_code = 'storage-retention-lease-expired',
                  finished_at = $2::timestamptz,
                  updated_at = $2::timestamptz
            WHERE storage_object_copy_id = $1
              AND operation = 'delete'
              AND operation_reference = 'protected-primary-retention'
              AND state = 'in_progress'
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at <= $2::timestamptz`,
          [locked.storage_object_copy_id, now],
        );

        const authority = (await client.query<RetentionAuthorityRow>(
          `SELECT
             object_record.storage_object_id,
             primary_copy.storage_object_copy_id AS primary_storage_object_copy_id,
             object_record.verified_checksum_sha256,
             object_record.verified_byte_length,
             connection.connection_id AS primary_connection_id,
             vault.bucket_label AS primary_bucket_label,
             vault.prefix_template AS primary_prefix_template,
             primary_copy.internal_locator AS primary_internal_locator,
             connection.secret_reference_id AS primary_secret_reference_id,
             COALESCE((
               SELECT max(prior.attempt_number)
                 FROM public.storage_provider_attempts AS prior
                WHERE prior.storage_object_copy_id = primary_copy.storage_object_copy_id
                  AND prior.operation = 'delete'
                  AND prior.operation_reference = 'protected-primary-retention'
             ), 0) AS latest_attempt_number
           FROM public.storage_object_copies AS primary_copy
           JOIN public.storage_objects AS object_record
             ON object_record.storage_object_id = primary_copy.storage_object_id
           JOIN public.storage_control_configuration_vaults AS vault
             ON vault.id = primary_copy.configuration_vault_id
            AND vault.storage_control_client_id = object_record.storage_control_client_id
            AND vault.configuration_version_id = object_record.configuration_version_id
           JOIN public.storage_control_provider_connections AS connection
             ON connection.id = primary_copy.provider_connection_id
            AND connection.storage_control_client_id = object_record.storage_control_client_id
            AND connection.status = 'active'
          WHERE primary_copy.storage_object_copy_id = $1`,
          [locked.storage_object_copy_id],
        )).rows[0];
        if (authority === undefined) {
          throw new ReplicaProtectionError('duplicate-conflict', 'storage-retention-authority-conflict');
        }

        const replicas = (await client.query<RetentionReplicaRow>(
          `SELECT copy.storage_object_copy_id, copy.copy_state,
                  copy.observed_checksum_sha256, copy.observed_byte_length,
                  connection.connection_id, vault.bucket_label,
                  copy.internal_locator, connection.secret_reference_id
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
          [authority.storage_object_id],
        )).rows;

        const expectedLength = integer(authority.verified_byte_length, 'storage-retention-length-invalid');
        const invalidVerifiedReplicaIds = replicas
          .filter((replica) => replica.copy_state === 'verified' && (
            replica.observed_checksum_sha256 !== authority.verified_checksum_sha256 ||
            integer(replica.observed_byte_length ?? -1, 'storage-retention-length-invalid') !== expectedLength
          ))
          .map((replica) => replica.storage_object_copy_id);
        if (invalidVerifiedReplicaIds.length > 0) {
          await client.query(
            `UPDATE public.storage_object_copies
                SET copy_state = 'failed', updated_at = $3::timestamptz,
                    row_version = row_version + 1
              WHERE storage_object_id = $1
                AND storage_object_copy_id = ANY($2::uuid[])
                AND target_role = 'replica'
                AND copy_state = 'verified'`,
            [authority.storage_object_id, invalidVerifiedReplicaIds, now],
          );
        }

        const protectedByReplica = replicas.length > 0 && replicas.every((replica) =>
          replica.copy_state === 'verified' &&
          replica.observed_checksum_sha256 === authority.verified_checksum_sha256 &&
          integer(replica.observed_byte_length ?? -1, 'storage-retention-length-invalid') === expectedLength,
        );
        if (!protectedByReplica) {
          await markRepairRequired(client, authority.storage_object_id, now);
          return Object.freeze({ kind: 'blocked' as const });
        }

        const attemptNumber = integer(authority.latest_attempt_number, 'storage-retention-attempt-invalid') + 1;
        const providerAttemptId = this.#createId();
        await client.query(
          `INSERT INTO public.storage_provider_attempts (
             storage_provider_attempt_id, storage_object_copy_id, storage_object_id,
             operation, operation_reference, attempt_number, state, retryable,
             lease_owner, lease_token, lease_expires_at,
             expected_checksum_sha256, expected_byte_length,
             started_at, created_at, updated_at
           ) VALUES (
             $1, $2, $3, 'delete', 'protected-primary-retention', $4,
             'in_progress', false, $5, $6,
             $7::timestamptz + ($8::bigint * interval '1 millisecond'),
             $9, $10, $7::timestamptz, $7::timestamptz, $7::timestamptz
           )`,
          [
            providerAttemptId,
            authority.primary_storage_object_copy_id,
            authority.storage_object_id,
            attemptNumber,
            input.workerId,
            leaseToken,
            now,
            REPLICA_PROTECTION_LIMITS.leaseDurationMs,
            authority.verified_checksum_sha256,
            expectedLength,
          ],
        );

        const job: ReplicaProtectionRetentionJob = Object.freeze({
          providerAttemptId,
          attemptNumber,
          leaseToken,
          storageObjectId: authority.storage_object_id,
          primaryStorageObjectCopyId: authority.primary_storage_object_copy_id,
          expectedChecksumSha256: authority.verified_checksum_sha256,
          expectedByteLength: expectedLength,
          primaryTarget: writeTarget({
            role: 'primary',
            connectionId: authority.primary_connection_id,
            bucketLabel: authority.primary_bucket_label,
            prefixTemplate: authority.primary_prefix_template,
            internalLocator: authority.primary_internal_locator,
            secretReferenceId: authority.primary_secret_reference_id,
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
      throw boundedStoreError(error, 'storage-retention-claim-unavailable');
    }
  }
}
