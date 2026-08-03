import type { SafeDiagnostic } from './runtime-contract.js';
import {
  IMAGE_DERIVATIVE_LIMITS,
  ImageDerivativeError,
  type ImageDerivativeJobSnapshot,
  type ImageDerivativeOutputReservation,
  type ImageDerivativeStatusSnapshot,
} from './image-derivative.js';
import {
  integer,
  locator,
  lockedJob,
  safeCategory,
  safeCode,
  status,
  transaction,
  type JobRow,
  type OutputReservationRow,
} from './image-derivative-postgres-helpers.js';
import type { PostgresImageDerivativeContext } from './image-derivative-postgres-types.js';

export async function reserveOutput(context: PostgresImageDerivativeContext, input: {
  job: Readonly<ImageDerivativeJobSnapshot>;
  checksumSha256: string;
  byteLength: number;
  contentType: string;
  now?: Date;
}): Promise<Readonly<ImageDerivativeOutputReservation>> {
  const now = input.now ?? context.now();
  return transaction(context.pool, async (client) => {
    const row = await lockedJob(client, input.job);
    const existing = await client.query<OutputReservationRow>(`
SELECT object.storage_object_id,
     copy.storage_object_copy_id,
     copy.copy_state,
     object.verified_checksum_sha256,
     object.verified_byte_length,
     copy.provider_connection_id,
     connection.provider_type,
     vault.bucket_label,
     vault.prefix_template,
     connection.secret_reference_id,
     copy.internal_locator
FROM public.storage_objects AS object
JOIN public.storage_object_copies AS copy
ON copy.storage_object_id = object.storage_object_id
 AND copy.image_derivative_job_id = $1
JOIN public.storage_control_configuration_vaults AS vault
ON vault.storage_control_client_id = object.storage_control_client_id
 AND vault.configuration_version_id = object.configuration_version_id
 AND vault.id = copy.configuration_vault_id
JOIN public.storage_control_provider_connections AS connection
ON connection.storage_control_client_id = object.storage_control_client_id
 AND connection.id = copy.provider_connection_id
WHERE object.storage_object_id = $2
FOR UPDATE OF object, copy
`, [row.image_derivative_job_id, row.reserved_output_storage_object_id]);
    let reservation = existing.rows[0];
    let reusedPendingReservation = reservation !== undefined;
    if (reservation === undefined) {
      const targetAuthority = await client.query<{
        provider_connection_id: string;
        provider_type: 'minio' | 'r2' | 's3-compatible';
        bucket_label: string;
        prefix_template: string;
        secret_reference_id: string;
      }>(`
SELECT vault.provider_connection_id,
     connection.provider_type,
     vault.bucket_label,
     vault.prefix_template,
     connection.secret_reference_id
FROM public.storage_control_configuration_vaults AS vault
JOIN public.storage_control_provider_connections AS connection
ON connection.storage_control_client_id = vault.storage_control_client_id
 AND connection.id = vault.provider_connection_id
WHERE vault.storage_control_client_id = $1
AND vault.configuration_version_id = $2
AND vault.id = $3
AND connection.status = 'active'
`, [row.storage_control_client_id, row.configuration_version_id, row.target_configuration_vault_id]);
      const target = targetAuthority.rows[0];
      if (target === undefined) {
        throw new ImageDerivativeError(
          'dependency-unavailable',
          'image-derivative-target-vault-unavailable',
          503,
          true,
        );
      }
      const storageObjectId = context.createId();
      const storageObjectCopyId = context.createId();
      const internalLocator = locator(target.prefix_template, storageObjectId);
      await client.query(`
INSERT INTO public.storage_objects (
storage_object_id,
managed_app_id,
storage_profile_id,
storage_profile_fingerprint,
storage_prefix_class_id,
storage_control_client_id,
configuration_version_id,
configuration_fingerprint,
configuration_route_id,
app_correlation_ref,
source_reference,
registry_state,
object_protection_stage,
expected_checksum_sha256,
expected_byte_length,
expected_content_type,
safe_technical_metadata,
created_at,
updated_at
) VALUES (
$1, NULL, NULL, NULL, NULL, $2, $3, $4, $5,
$6, $7, 'reserved', 'image-derivative-write-pending',
$8, $9, $10, $11::jsonb, $12, $12
)
`, [
        storageObjectId,
        row.storage_control_client_id,
        row.configuration_version_id,
        row.configuration_fingerprint,
        row.configuration_route_id,
        `image-derivative:${row.image_derivative_job_id}`,
        `source:${row.source_storage_object_id}`,
        input.checksumSha256,
        input.byteLength,
        input.contentType,
        JSON.stringify({
          image_derivative_job_id: row.image_derivative_job_id,
          preset_id: row.preset_id,
          width: row.requested_width,
          output_format: row.output_format,
        }),
        now,
      ]);
      await client.query(`
UPDATE public.storage_image_derivative_jobs
 SET reserved_output_storage_object_id = $2,
     updated_at = $3,
     row_version = row_version + 1
 WHERE image_derivative_job_id = $1
`, [row.image_derivative_job_id, storageObjectId, now]);
      await client.query(`
INSERT INTO public.storage_object_copies (
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
updated_at
) VALUES (
$1, $2, NULL, NULL, NULL, $3, $4, NULL, NULL, $5,
$6, 'pending', $7, $7
)
`, [
        storageObjectCopyId,
        storageObjectId,
        row.target_configuration_vault_id,
        target.provider_connection_id,
        row.image_derivative_job_id,
        internalLocator,
        now,
      ]);
      reservation = {
        storage_object_id: storageObjectId,
        storage_object_copy_id: storageObjectCopyId,
        copy_state: 'pending',
        verified_checksum_sha256: null,
        verified_byte_length: null,
        provider_connection_id: target.provider_connection_id,
        provider_type: target.provider_type,
        bucket_label: target.bucket_label,
        prefix_template: target.prefix_template,
        secret_reference_id: target.secret_reference_id,
        internal_locator: internalLocator,
      };
      reusedPendingReservation = false;
    }
    const alreadyVerified =
      reservation.copy_state === 'verified' &&
      reservation.verified_checksum_sha256 === input.checksumSha256 &&
      reservation.verified_byte_length !== null &&
      integer(reservation.verified_byte_length, 'image-derivative-output-byte-length-invalid') === input.byteLength;
    if (reservation.copy_state === 'verified' && !alreadyVerified) {
      throw new ImageDerivativeError('duplicate-conflict', 'image-derivative-output-conflict', 409);
    }
    return Object.freeze({
      storageObjectId: reservation.storage_object_id,
      storageObjectCopyId: reservation.storage_object_copy_id,
      target: Object.freeze({
        providerRole: 'primary',
        providerId: reservation.provider_connection_id,
        bucketLabel: reservation.bucket_label,
        internalLocator: reservation.internal_locator,
        normalizedPrefixPattern: reservation.prefix_template,
        capabilityPolicy: Object.freeze({
          checksumVerification: 'required',
          sizeVerification: 'required-when-supported',
          headContentLength: 'required',
          rangeRead: 'optional',
        }),
        credentialSecretReferenceId: reservation.secret_reference_id,
      }),
      reusedPendingReservation,
      alreadyVerified,
    });
  });
}

export async function completeOutput(context: PostgresImageDerivativeContext, input: {
  job: Readonly<ImageDerivativeJobSnapshot>;
  reservation: Readonly<ImageDerivativeOutputReservation>;
  checksumSha256: string;
  byteLength: number;
  now?: Date;
}): Promise<Readonly<ImageDerivativeStatusSnapshot>> {
  const now = input.now ?? context.now();
  return transaction(context.pool, async (client) => {
    const row = await lockedJob(client, input.job);
    if (row.reserved_output_storage_object_id !== input.reservation.storageObjectId) {
      throw new ImageDerivativeError('duplicate-conflict', 'image-derivative-output-reservation-mismatch', 409);
    }
    const updatedCopy = await client.query(`
UPDATE public.storage_object_copies
 SET copy_state = 'verified',
     observed_checksum_sha256 = $4,
     observed_byte_length = $5,
     latest_verified_at = $6,
     updated_at = $6,
     row_version = row_version + 1
 WHERE storage_object_copy_id = $1
 AND storage_object_id = $2
 AND image_derivative_job_id = $3
 AND copy_state IN ('pending', 'verified')
`, [
      input.reservation.storageObjectCopyId,
      input.reservation.storageObjectId,
      row.image_derivative_job_id,
      input.checksumSha256,
      input.byteLength,
      now,
    ]);
    if (updatedCopy.rowCount !== 1) {
      throw new ImageDerivativeError('duplicate-conflict', 'image-derivative-output-copy-conflict', 409);
    }
    await client.query(`
UPDATE public.storage_objects
 SET registry_state = 'active',
     object_protection_stage = 'image-derivative-verified',
     verified_checksum_sha256 = $2,
     verified_byte_length = $3,
     activated_at = COALESCE(activated_at, $4),
     updated_at = $4,
     row_version = row_version + 1
 WHERE storage_object_id = $1
 AND expected_checksum_sha256 = $2
 AND expected_byte_length = $3
 AND registry_state IN ('reserved', 'active')
`, [input.reservation.storageObjectId, input.checksumSha256, input.byteLength, now]);
    await client.query(`
INSERT INTO public.storage_image_derivative_outputs (
image_derivative_output_id,
image_derivative_job_id,
storage_control_client_id,
configuration_version_id,
source_storage_object_id,
output_storage_object_id,
width,
output_format,
verified_byte_length,
verified_checksum_sha256,
created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
ON CONFLICT (image_derivative_job_id) DO NOTHING
`, [
      context.createId(),
      row.image_derivative_job_id,
      row.storage_control_client_id,
      row.configuration_version_id,
      row.source_storage_object_id,
      input.reservation.storageObjectId,
      row.requested_width,
      row.output_format,
      input.byteLength,
      input.checksumSha256,
      now,
    ]);
    const completed = await client.query<JobRow>(`
UPDATE public.storage_image_derivative_jobs AS job
 SET state = 'succeeded',
     finished_at = $2,
     lease_owner = NULL,
     lease_token = NULL,
     lease_expires_at = NULL,
     next_attempt_at = NULL,
     safe_diagnostic_category = NULL,
     safe_diagnostic_code = NULL,
     updated_at = $2,
     row_version = row_version + 1
 WHERE job.image_derivative_job_id = $1
RETURNING job.*, (
SELECT version.environment
FROM public.storage_control_configuration_versions AS version
WHERE version.storage_control_client_id = job.storage_control_client_id
  AND version.id = job.configuration_version_id
) AS environment
`, [row.image_derivative_job_id, now]);
    const completedRow = completed.rows[0];
    if (completedRow === undefined) {
      throw new ImageDerivativeError('internal', 'image-derivative-completion-failed');
    }
    return status(completedRow);
  });
}

export async function failJob(context: PostgresImageDerivativeContext, input: {
  job: Readonly<ImageDerivativeJobSnapshot>;
  diagnostic: Readonly<SafeDiagnostic>;
  retryable: boolean;
  clearReservedOutput: boolean;
  now?: Date;
}): Promise<Readonly<ImageDerivativeStatusSnapshot>> {
  const now = input.now ?? context.now();
  return transaction(context.pool, async (client) => {
    const row = await lockedJob(client, input.job);
    if (input.clearReservedOutput && row.reserved_output_storage_object_id !== null) {
      const deletedCopy = await client.query(`
DELETE FROM public.storage_object_copies
 WHERE storage_object_id = $1
 AND image_derivative_job_id = $2
 AND copy_state <> 'verified'
`, [row.reserved_output_storage_object_id, row.image_derivative_job_id]);
      if ((deletedCopy.rowCount ?? 0) > 0) {
        await client.query(`
DELETE FROM public.storage_objects
 WHERE storage_object_id = $1
 AND registry_state = 'reserved'
`, [row.reserved_output_storage_object_id]);
        await client.query(`
UPDATE public.storage_image_derivative_jobs
 SET reserved_output_storage_object_id = NULL
 WHERE image_derivative_job_id = $1
`, [row.image_derivative_job_id]);
      }
    }
    const retry = input.retryable && row.attempt_count < IMAGE_DERIVATIVE_LIMITS.maximumAttempts;
    const nextAttemptAt = retry
      ? new Date(now.getTime() + IMAGE_DERIVATIVE_LIMITS.retryDelayMs)
      : null;
    const failed = await client.query<JobRow>(`
UPDATE public.storage_image_derivative_jobs AS job
 SET state = 'failed',
     next_attempt_at = $2,
     finished_at = CASE WHEN $2::timestamptz IS NULL THEN $3 ELSE NULL END,
     lease_owner = NULL,
     lease_token = NULL,
     lease_expires_at = NULL,
     safe_diagnostic_category = $4,
     safe_diagnostic_code = $5,
     updated_at = $3,
     row_version = row_version + 1
 WHERE job.image_derivative_job_id = $1
RETURNING job.*, (
SELECT version.environment
FROM public.storage_control_configuration_versions AS version
WHERE version.storage_control_client_id = job.storage_control_client_id
  AND version.id = job.configuration_version_id
) AS environment
`, [
      row.image_derivative_job_id,
      nextAttemptAt,
      now,
      safeCategory(input.diagnostic.category),
      safeCode(input.diagnostic.code),
    ]);
    const failedRow = failed.rows[0];
    if (failedRow === undefined) {
      throw new ImageDerivativeError('internal', 'image-derivative-failure-recording-failed');
    }
    return status(failedRow);
  });
}
