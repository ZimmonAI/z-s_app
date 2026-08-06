import { randomUUID } from 'node:crypto';
import {
  ImageDerivativeError,
  type ImageDerivativeClaimInput,
  type ImageDerivativeFailureInput,
  type ImageDerivativeJob,
  type VerifiedImageDerivativeOutput,
} from './image-derivative.js';
import {
  PostgresImageDerivativeStore as BasePostgresImageDerivativeStore,
  type ImageDerivativeOutputReservation,
  type ImageDerivativeSourceAuthority,
} from './image-derivative-postgres.js';
import type { ResolvedProviderReadTarget } from './runtime-read-delivery.js';
import type { ResolvedProviderWriteTarget } from './runtime-s3-provider.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryable,
} from './runtime-storage-registry-types.js';

export type {
  ImageDerivativeOutputReservation,
  ImageDerivativeSourceAuthority,
} from './image-derivative-postgres.js';

interface ImageDerivativePostgresPool extends PostgresPoolLike, PostgresQueryable {}

interface JobRow extends Record<string, unknown> {
  image_derivative_job_id: string;
  source_storage_object_id: string;
  storage_control_client_id: string;
  environment: ImageDerivativeJob['environment'];
  configuration_version_id: string;
  configuration_fingerprint: string;
  configuration_route_id: string;
  configuration_image_preset_id: string;
  preset_id: string;
  target_configuration_vault_id: string;
  requested_width: number;
  output_format: ImageDerivativeJob['outputFormat'];
  quality: number;
  fit_mode: ImageDerivativeJob['fit'];
  state: ImageDerivativeJob['state'];
  attempt_count: number;
  maximum_attempts: number;
  lease_token: string;
}

interface SourceTargetRow extends Record<string, unknown> {
  expected_content_type: string;
  verified_byte_length: string | number;
  verified_checksum_sha256: string;
  connection_id: string;
  bucket_label: string;
  internal_locator: string;
  secret_reference_id: string;
}

interface OutputAuthorityRow extends Record<string, unknown> {
  configuration_vault_id: string;
  provider_connection_id: string;
  connection_id: string;
  bucket_label: string;
  prefix_template: string;
  secret_reference_id: string;
}

interface ExistingOutputRow extends Record<string, unknown> {
  storage_object_id: string;
  storage_object_copy_id: string;
  registry_state: string;
  copy_state: string;
  verified_byte_length: string | number | null;
  verified_checksum_sha256: string | null;
  internal_locator: string;
  connection_id: string;
  bucket_label: string;
  prefix_template: string;
  secret_reference_id: string;
}

interface ReservationAuthority {
  readonly jobId: string;
  readonly leaseToken: string;
}

const FINAL_LEASE_RECOVERY_BATCH_SIZE = 100;
export const IMAGE_DERIVATIVE_FINAL_LEASE_EXPIRY_CODE =
  'image-derivative-final-lease-expired';

function integer(value: string | number | null, code: string): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new ImageDerivativeError('dependency-unavailable', code, true);
  }
  return result;
}

function jobFromRow(row: Readonly<JobRow>): Readonly<ImageDerivativeJob> {
  return Object.freeze({
    id: row.image_derivative_job_id,
    sourceStorageObjectId: row.source_storage_object_id,
    storageControlClientId: row.storage_control_client_id,
    environment: row.environment,
    configurationVersionId: row.configuration_version_id,
    configurationFingerprint: row.configuration_fingerprint,
    configurationRouteId: row.configuration_route_id,
    configurationImagePresetId: row.configuration_image_preset_id,
    presetId: row.preset_id,
    targetConfigurationVaultId: row.target_configuration_vault_id,
    requestedWidth: row.requested_width,
    outputFormat: row.output_format,
    quality: row.quality,
    fit: row.fit_mode,
    state: row.state,
    attemptCount: row.attempt_count,
    maximumAttempts: row.maximum_attempts,
    leaseToken: row.lease_token,
  });
}

async function transaction<T>(
  pool: ImageDerivativePostgresPool,
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
      // Preserve the original safe failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

function storeFailure(error: unknown, code: string): ImageDerivativeError {
  if (error instanceof ImageDerivativeError) return error;
  return new ImageDerivativeError('dependency-unavailable', code, true);
}

async function assertActiveLease(
  client: PostgresClientLike,
  jobId: string,
  leaseToken: string,
  now: Date,
): Promise<void> {
  const result = await client.query(
    `SELECT 1
       FROM public.storage_image_derivative_jobs
      WHERE image_derivative_job_id = $1
        AND state = 'processing'
        AND lease_token = $2
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > $3
      FOR UPDATE`,
    [jobId, leaseToken, now],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new ImageDerivativeError(
      'duplicate-conflict',
      'image-derivative-lease-lost',
      false,
    );
  }
}

export class PostgresImageDerivativeStore extends BasePostgresImageDerivativeStore {
  readonly #pool: ImageDerivativePostgresPool;
  readonly #createId: () => string;
  readonly #now: () => Date;
  readonly #reservationAuthority = new WeakMap<object, Readonly<ReservationAuthority>>();

  constructor(
    pool: ImageDerivativePostgresPool,
    createId: () => string = randomUUID,
    now: () => Date = () => new Date(),
  ) {
    super(pool, createId);
    this.#pool = pool;
    this.#createId = createId;
    this.#now = now;
  }

  #operationNow(candidate?: Date): Date {
    const current = this.#now();
    if (!Number.isFinite(current.getTime())) {
      throw new ImageDerivativeError(
        'dependency-unavailable',
        'image-derivative-store-invalid-time',
        true,
      );
    }
    if (candidate === undefined || !Number.isFinite(candidate.getTime())) return current;
    return candidate.getTime() > current.getTime() ? candidate : current;
  }

  #authorizeReservation(
    reservation: Readonly<ImageDerivativeOutputReservation>,
    job: Readonly<ImageDerivativeJob>,
  ): Readonly<ImageDerivativeOutputReservation> {
    this.#reservationAuthority.set(reservation, Object.freeze({
      jobId: job.id,
      leaseToken: job.leaseToken,
    }));
    return reservation;
  }

  override async claimNext(
    input: Readonly<ImageDerivativeClaimInput>,
  ): Promise<Readonly<ImageDerivativeJob> | null> {
    const now = this.#operationNow(input.now);
    const leaseToken = this.#createId();
    try {
      return await transaction(this.#pool, async (client) => {
        await client.query(
          `WITH expired_final AS (
             SELECT image_derivative_job_id
               FROM public.storage_image_derivative_jobs
              WHERE state = 'processing'
                AND lease_expires_at IS NOT NULL
                AND lease_expires_at <= $1
                AND attempt_count >= LEAST(maximum_attempts, $2)
              ORDER BY created_at, image_derivative_job_id
              FOR UPDATE SKIP LOCKED
              LIMIT $3
           )
           UPDATE public.storage_image_derivative_jobs AS jobs
              SET state = 'failed',
                  lease_owner = NULL,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  next_retry_at = NULL,
                  safe_diagnostic_category = 'dependency-unavailable',
                  safe_diagnostic_code = $4,
                  finished_at = $1,
                  updated_at = $1,
                  row_version = jobs.row_version + 1
             FROM expired_final
            WHERE jobs.image_derivative_job_id = expired_final.image_derivative_job_id`,
          [
            now,
            input.maximumAttempts,
            FINAL_LEASE_RECOVERY_BATCH_SIZE,
            IMAGE_DERIVATIVE_FINAL_LEASE_EXPIRY_CODE,
          ],
        );

        const row = (await client.query<JobRow>(
          `WITH candidate AS (
             SELECT image_derivative_job_id
               FROM public.storage_image_derivative_jobs
              WHERE attempt_count < LEAST(maximum_attempts, $3)
                AND (
                  state = 'queued'
                  OR (state = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= $1)
                  OR (state = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1)
                )
              ORDER BY created_at, image_derivative_job_id
              FOR UPDATE SKIP LOCKED
              LIMIT 1
           )
           UPDATE public.storage_image_derivative_jobs AS jobs
              SET state = 'processing',
                  attempt_count = jobs.attempt_count + 1,
                  lease_owner = $2,
                  lease_token = $4,
                  lease_expires_at = $1 + ($5::bigint * interval '1 millisecond'),
                  started_at = COALESCE(jobs.started_at, $1),
                  finished_at = NULL,
                  next_retry_at = NULL,
                  safe_diagnostic_category = NULL,
                  safe_diagnostic_code = NULL,
                  updated_at = $1,
                  row_version = jobs.row_version + 1
             FROM candidate
            WHERE jobs.image_derivative_job_id = candidate.image_derivative_job_id
           RETURNING jobs.*`,
          [now, input.workerId, input.maximumAttempts, leaseToken, input.leaseDurationMs],
        )).rows[0];
        return row === undefined ? null : jobFromRow(row);
      });
    } catch (error) {
      throw storeFailure(error, 'image-derivative-claim-unavailable');
    }
  }

  override async complete(
    job: Readonly<ImageDerivativeJob>,
    output: Readonly<VerifiedImageDerivativeOutput>,
    candidateNow?: Date,
  ): Promise<void> {
    const now = this.#operationNow(candidateNow);
    try {
      await transaction(this.#pool, async (client) => {
        await assertActiveLease(client, job.id, job.leaseToken, now);
        const inserted = await client.query(
          `INSERT INTO public.storage_image_derivative_outputs (
             image_derivative_output_id,
             image_derivative_job_id,
             source_storage_object_id,
             output_storage_object_id,
             width,
             output_format,
             verified_byte_length,
             verified_checksum_sha256,
             created_at
           )
           SELECT $1, jobs.image_derivative_job_id, jobs.source_storage_object_id, $3,
                  jobs.requested_width, jobs.output_format, $4, $5, $6
             FROM public.storage_image_derivative_jobs AS jobs
             JOIN public.storage_objects AS output_object
               ON output_object.storage_object_id = $3
              AND output_object.image_derivative_job_id = jobs.image_derivative_job_id
              AND output_object.registry_state = 'active'
              AND output_object.verified_byte_length = $4
              AND output_object.verified_checksum_sha256 = $5
             JOIN public.storage_object_copies AS output_copy
               ON output_copy.storage_object_id = output_object.storage_object_id
              AND output_copy.image_derivative_job_id = jobs.image_derivative_job_id
              AND output_copy.copy_state = 'verified'
            WHERE jobs.image_derivative_job_id = $2
              AND jobs.state = 'processing'
              AND jobs.lease_token = $7
              AND jobs.lease_expires_at > $6
           ON CONFLICT (image_derivative_job_id) DO NOTHING`,
          [
            this.#createId(),
            job.id,
            output.storageObjectId,
            output.byteLength,
            output.checksumSha256,
            now,
            job.leaseToken,
          ],
        );
        if ((inserted.rowCount ?? 0) === 0) {
          const existing = await client.query(
            `SELECT 1
               FROM public.storage_image_derivative_outputs AS outputs
              WHERE outputs.image_derivative_job_id = $1
                AND outputs.output_storage_object_id = $2
                AND outputs.verified_byte_length = $3
                AND outputs.verified_checksum_sha256 = $4`,
            [job.id, output.storageObjectId, output.byteLength, output.checksumSha256],
          );
          if ((existing.rowCount ?? 0) === 0) {
            throw new ImageDerivativeError(
              'duplicate-conflict',
              'image-derivative-completion-conflict',
              false,
            );
          }
        }
        const updated = await client.query(
          `UPDATE public.storage_image_derivative_jobs
              SET state = 'succeeded',
                  lease_owner = NULL,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  next_retry_at = NULL,
                  safe_diagnostic_category = NULL,
                  safe_diagnostic_code = NULL,
                  finished_at = $2,
                  updated_at = $2,
                  row_version = row_version + 1
            WHERE image_derivative_job_id = $1
              AND state = 'processing'
              AND lease_token = $3
              AND lease_expires_at > $2`,
          [job.id, now, job.leaseToken],
        );
        if ((updated.rowCount ?? 0) === 0) {
          throw new ImageDerivativeError(
            'duplicate-conflict',
            'image-derivative-lease-lost',
            false,
          );
        }
      });
    } catch (error) {
      throw storeFailure(error, 'image-derivative-completion-unavailable');
    }
  }

  override async fail(input: Readonly<ImageDerivativeFailureInput>): Promise<void> {
    const now = this.#operationNow(input.now);
    const retry = input.retryable && input.job.attemptCount < input.job.maximumAttempts;
    try {
      await transaction(this.#pool, async (client) => {
        await assertActiveLease(client, input.job.id, input.job.leaseToken, now);
        const result = await client.query(
          `UPDATE public.storage_image_derivative_jobs
              SET state = 'failed',
                  lease_owner = NULL,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  next_retry_at = CASE WHEN $4 THEN $2 + ($5::bigint * interval '1 millisecond') ELSE NULL END,
                  safe_diagnostic_category = $6,
                  safe_diagnostic_code = $7,
                  finished_at = CASE WHEN $4 THEN NULL ELSE $2 END,
                  updated_at = $2,
                  row_version = row_version + 1
            WHERE image_derivative_job_id = $1
              AND state = 'processing'
              AND lease_token = $3
              AND lease_expires_at > $2`,
          [
            input.job.id,
            now,
            input.job.leaseToken,
            retry,
            input.retryDelayMs,
            input.category,
            input.code,
          ],
        );
        if ((result.rowCount ?? 0) === 0) {
          throw new ImageDerivativeError(
            'duplicate-conflict',
            'image-derivative-lease-lost',
            false,
          );
        }
      });
    } catch (error) {
      throw storeFailure(error, 'image-derivative-failure-recording-unavailable');
    }
  }

  override async sourceAuthority(
    job: Readonly<ImageDerivativeJob>,
  ): Promise<Readonly<ImageDerivativeSourceAuthority>> {
    const now = this.#operationNow();
    try {
      return await transaction(this.#pool, async (client) => {
        await assertActiveLease(client, job.id, job.leaseToken, now);
        const row = (await client.query<SourceTargetRow>(
          `SELECT
             objects.expected_content_type,
             objects.verified_byte_length,
             objects.verified_checksum_sha256,
             connections.connection_id,
             vaults.bucket_label,
             copies.internal_locator,
             connections.secret_reference_id
           FROM public.storage_objects AS objects
           JOIN public.storage_object_copies AS copies
             ON copies.storage_object_id = objects.storage_object_id
            AND copies.copy_state = 'verified'
            AND copies.configuration_route_target_id IS NOT NULL
           JOIN public.storage_control_configuration_vaults AS vaults
             ON vaults.id = copies.configuration_vault_id
            AND vaults.storage_control_client_id = objects.storage_control_client_id
            AND vaults.configuration_version_id = objects.configuration_version_id
           JOIN public.storage_control_provider_connections AS connections
             ON connections.id = copies.provider_connection_id
            AND connections.storage_control_client_id = objects.storage_control_client_id
            AND connections.status = 'active'
          WHERE objects.storage_object_id = $1
            AND objects.storage_control_client_id = $2
            AND objects.configuration_version_id = $3
            AND objects.configuration_fingerprint = $4
            AND objects.configuration_route_id = $5
            AND objects.registry_state = 'active'
            AND objects.verified_byte_length IS NOT NULL
            AND objects.verified_checksum_sha256 IS NOT NULL
          ORDER BY CASE copies.target_role WHEN 'replica' THEN 0 ELSE 1 END,
                   copies.target_order,
                   copies.storage_object_copy_id
          LIMIT 1`,
          [
            job.sourceStorageObjectId,
            job.storageControlClientId,
            job.configurationVersionId,
            job.configurationFingerprint,
            job.configurationRouteId,
          ],
        )).rows[0];
        if (row === undefined) {
          throw new ImageDerivativeError(
            'not-ready',
            'image-derivative-source-copy-unavailable',
            true,
          );
        }
        return Object.freeze({
          mediaType: row.expected_content_type,
          byteLength: integer(
            row.verified_byte_length,
            'image-derivative-source-length-invalid',
          ),
          checksumSha256: row.verified_checksum_sha256,
          target: Object.freeze({
            providerRole: 'replica',
            providerId: row.connection_id,
            bucketLabel: row.bucket_label,
            internalLocator: row.internal_locator,
            credentialSecretReferenceId: row.secret_reference_id,
          } satisfies ResolvedProviderReadTarget),
        });
      });
    } catch (error) {
      throw storeFailure(error, 'image-derivative-source-authority-unavailable');
    }
  }

  override async reserveOutput(
    job: Readonly<ImageDerivativeJob>,
    output: Readonly<{ mediaType: string; byteLength: number; checksumSha256: string }>,
    candidateNow?: Date,
  ): Promise<Readonly<ImageDerivativeOutputReservation>> {
    const now = this.#operationNow(candidateNow);
    try {
      return await transaction(this.#pool, async (client) => {
        await assertActiveLease(client, job.id, job.leaseToken, now);
        const existing = (await client.query<ExistingOutputRow>(
          `SELECT
             objects.storage_object_id,
             copies.storage_object_copy_id,
             objects.registry_state,
             copies.copy_state,
             objects.verified_byte_length,
             objects.verified_checksum_sha256,
             copies.internal_locator,
             connections.connection_id,
             vaults.bucket_label,
             vaults.prefix_template,
             connections.secret_reference_id
           FROM public.storage_objects AS objects
           JOIN public.storage_object_copies AS copies
             ON copies.storage_object_id = objects.storage_object_id
            AND copies.image_derivative_job_id = objects.image_derivative_job_id
           JOIN public.storage_control_configuration_vaults AS vaults
             ON vaults.id = copies.configuration_vault_id
           JOIN public.storage_control_provider_connections AS connections
             ON connections.id = copies.provider_connection_id
          WHERE objects.image_derivative_job_id = $1
          LIMIT 1`,
          [job.id],
        )).rows[0];
        if (existing !== undefined) {
          const target = Object.freeze({
            providerRole: 'primary' as const,
            providerId: existing.connection_id,
            bucketLabel: existing.bucket_label,
            internalLocator: existing.internal_locator,
            normalizedPrefixPattern: existing.prefix_template,
            credentialSecretReferenceId: existing.secret_reference_id,
            capabilityPolicy: Object.freeze({
              checksumVerification: 'required' as const,
              sizeVerification: 'required-when-supported' as const,
              headContentLength: 'required' as const,
              rangeRead: 'optional' as const,
            }),
          } satisfies ResolvedProviderWriteTarget);
          const alreadyVerified =
            existing.registry_state === 'active' &&
            existing.copy_state === 'verified' &&
            existing.verified_byte_length !== null &&
            existing.verified_checksum_sha256 !== null
              ? Object.freeze({
                  storageObjectId: existing.storage_object_id,
                  byteLength: integer(
                    existing.verified_byte_length,
                    'image-derivative-output-length-invalid',
                  ),
                  checksumSha256: existing.verified_checksum_sha256,
                })
              : undefined;
          return this.#authorizeReservation(Object.freeze({
            storageObjectId: existing.storage_object_id,
            storageObjectCopyId: existing.storage_object_copy_id,
            target,
            ...(alreadyVerified === undefined ? {} : { alreadyVerified }),
          }), job);
        }

        const authority = (await client.query<OutputAuthorityRow>(
          `SELECT
             vaults.id AS configuration_vault_id,
             vaults.provider_connection_id,
             connections.connection_id,
             vaults.bucket_label,
             vaults.prefix_template,
             connections.secret_reference_id
           FROM public.storage_control_configuration_vaults AS vaults
           JOIN public.storage_control_provider_connections AS connections
             ON connections.storage_control_client_id = vaults.storage_control_client_id
            AND connections.id = vaults.provider_connection_id
            AND connections.status = 'active'
          WHERE vaults.storage_control_client_id = $1
            AND vaults.configuration_version_id = $2
            AND vaults.id = $3`,
          [job.storageControlClientId, job.configurationVersionId, job.targetConfigurationVaultId],
        )).rows[0];
        if (authority === undefined) {
          throw new ImageDerivativeError(
            'not-ready',
            'image-derivative-target-vault-unavailable',
            true,
          );
        }
        const storageObjectId = this.#createId();
        const storageObjectCopyId = this.#createId();
        const internalLocator = authority.prefix_template.slice(0, -1) + storageObjectId;
        await client.query(
          `INSERT INTO public.storage_objects (
             storage_object_id,
             managed_app_id,
             storage_profile_id,
             storage_profile_fingerprint,
             storage_prefix_class_id,
             storage_control_client_id,
             configuration_version_id,
             configuration_fingerprint,
             configuration_route_id,
             image_derivative_job_id,
             app_correlation_ref,
             source_reference,
             registry_state,
             object_protection_stage,
             expected_checksum_sha256,
             expected_byte_length,
             expected_content_type,
             safe_technical_metadata,
             created_at,
             updated_at,
             row_version
           ) VALUES (
             $1, NULL, NULL, NULL, NULL, $2, $3, $4, $5, $6,
             $7, $8, 'reserved', 'derivative-write-pending', $9, $10, $11,
             jsonb_build_object('derivative_preset_id', $12::text, 'derivative_width', $13::integer, 'derivative_format', $14::text),
             $15, $15, 1
           )`,
          [
            storageObjectId,
            job.storageControlClientId,
            job.configurationVersionId,
            job.configurationFingerprint,
            job.configurationRouteId,
            job.id,
            `image-derivative:${job.id}`,
            `image-derivative-source:${job.sourceStorageObjectId}`,
            output.checksumSha256,
            output.byteLength,
            output.mediaType,
            job.presetId,
            job.requestedWidth,
            job.outputFormat,
            now,
          ],
        );
        await client.query(
          `INSERT INTO public.storage_object_copies (
             storage_object_copy_id,
             storage_object_id,
             storage_profile_provider_binding_id,
             provider_role,
             configuration_route_target_id,
             configuration_vault_id,
             provider_connection_id,
             target_role,
             target_order,
             image_derivative_job_id,
             internal_locator,
             copy_state,
             created_at,
             updated_at,
             row_version
           ) VALUES (
             $1, $2, NULL, NULL, NULL, $3, $4, 'primary', 0, $5,
             $6, 'pending', $7, $7, 1
           )`,
          [
            storageObjectCopyId,
            storageObjectId,
            authority.configuration_vault_id,
            authority.provider_connection_id,
            job.id,
            internalLocator,
            now,
          ],
        );
        return this.#authorizeReservation(Object.freeze({
          storageObjectId,
          storageObjectCopyId,
          target: Object.freeze({
            providerRole: 'primary',
            providerId: authority.connection_id,
            bucketLabel: authority.bucket_label,
            internalLocator,
            normalizedPrefixPattern: authority.prefix_template,
            credentialSecretReferenceId: authority.secret_reference_id,
            capabilityPolicy: Object.freeze({
              checksumVerification: 'required',
              sizeVerification: 'required-when-supported',
              headContentLength: 'required',
              rangeRead: 'optional',
            }),
          } satisfies ResolvedProviderWriteTarget),
        }), job);
      });
    } catch (error) {
      throw storeFailure(error, 'image-derivative-output-reservation-unavailable');
    }
  }

  override async markOutputVerified(
    reservation: Readonly<ImageDerivativeOutputReservation>,
    output: Readonly<{ byteLength: number; checksumSha256: string }>,
    candidateNow?: Date,
  ): Promise<void> {
    const now = this.#operationNow(candidateNow);
    const authority = this.#reservationAuthority.get(reservation);
    if (authority === undefined) {
      throw new ImageDerivativeError(
        'duplicate-conflict',
        'image-derivative-lease-lost',
        false,
      );
    }
    try {
      await transaction(this.#pool, async (client) => {
        await assertActiveLease(client, authority.jobId, authority.leaseToken, now);
        const copy = await client.query(
          `UPDATE public.storage_object_copies
              SET copy_state = 'verified',
                  observed_checksum_sha256 = $3,
                  observed_byte_length = $4,
                  latest_verified_at = $5,
                  updated_at = $5,
                  row_version = row_version + 1
            WHERE storage_object_copy_id = $1
              AND storage_object_id = $2
              AND image_derivative_job_id = $6
              AND copy_state IN ('pending', 'failed', 'verified')`,
          [
            reservation.storageObjectCopyId,
            reservation.storageObjectId,
            output.checksumSha256,
            output.byteLength,
            now,
            authority.jobId,
          ],
        );
        if ((copy.rowCount ?? 0) === 0) {
          throw new ImageDerivativeError(
            'duplicate-conflict',
            'image-derivative-output-copy-conflict',
            false,
          );
        }
        const object = await client.query(
          `UPDATE public.storage_objects
              SET registry_state = 'active',
                  object_protection_stage = 'derivative-verified',
                  verified_checksum_sha256 = $2,
                  verified_byte_length = $3,
                  activated_at = COALESCE(activated_at, $4),
                  updated_at = $4,
                  row_version = row_version + 1
            WHERE storage_object_id = $1
              AND image_derivative_job_id = $5
              AND registry_state IN ('reserved', 'degraded', 'active')`,
          [
            reservation.storageObjectId,
            output.checksumSha256,
            output.byteLength,
            now,
            authority.jobId,
          ],
        );
        if ((object.rowCount ?? 0) === 0) {
          throw new ImageDerivativeError(
            'duplicate-conflict',
            'image-derivative-output-object-conflict',
            false,
          );
        }
      });
    } catch (error) {
      throw storeFailure(error, 'image-derivative-output-verification-unavailable');
    }
  }
}
