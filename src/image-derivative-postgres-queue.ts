import {
  IMAGE_DERIVATIVE_LIMITS,
  ImageDerivativeError,
  type ImageDerivativeJobSnapshot,
  type ImageDerivativeSourceSnapshot,
  type ImageDerivativeStatusSnapshot,
} from './image-derivative.js';
import {
  claimedJob,
  integer,
  status,
  transaction,
  type JobRow,
  type SourceRow,
} from './image-derivative-postgres-helpers.js';
import type { PostgresImageDerivativeContext } from './image-derivative-postgres-types.js';

export async function enqueueVerifiedSource(context: PostgresImageDerivativeContext, storageObjectId: string, now = context.now()): Promise<number> {
  const result = await context.queryable.query<{ image_derivative_job_id: string }>(`
WITH source AS (
SELECT object.storage_object_id,
       object.storage_control_client_id,
       object.configuration_version_id,
       object.configuration_fingerprint,
       object.configuration_route_id,
       route.image_preset_id,
       preset.preset_id,
       preset.target_vault_id,
       preset.resize_widths,
       preset.output_format,
       preset.quality,
       preset.fit_mode
FROM public.storage_objects AS object
JOIN public.storage_control_configuration_routes AS route
  ON route.storage_control_client_id = object.storage_control_client_id
 AND route.configuration_version_id = object.configuration_version_id
 AND route.id = object.configuration_route_id
JOIN public.storage_control_configuration_image_presets AS preset
  ON preset.storage_control_client_id = route.storage_control_client_id
 AND preset.configuration_version_id = route.configuration_version_id
 AND preset.id = route.image_preset_id
WHERE object.storage_object_id = $1
  AND object.storage_control_client_id IS NOT NULL
  AND object.registry_state = 'active'
  AND object.verified_checksum_sha256 IS NOT NULL
  AND object.verified_byte_length IS NOT NULL
  AND object.expected_content_type LIKE 'image/%'
  AND route.asset_class = 'image'
  AND NOT (object.safe_technical_metadata ? 'image_derivative_job_id')
), widths AS (
SELECT source.*, width.value::text::integer AS requested_width
FROM source
CROSS JOIN LATERAL jsonb_array_elements(source.resize_widths) AS width(value)
), inserted AS (
INSERT INTO public.storage_image_derivative_jobs (
  image_derivative_job_id,
  source_storage_object_id,
  storage_control_client_id,
  configuration_version_id,
  configuration_fingerprint,
  configuration_route_id,
  configuration_image_preset_id,
  preset_id,
  target_configuration_vault_id,
  requested_width,
  output_format,
  quality,
  fit_mode,
  state,
  attempt_count,
  created_at,
  updated_at
)
SELECT gen_random_uuid(),
       storage_object_id,
       storage_control_client_id,
       configuration_version_id,
       configuration_fingerprint,
       configuration_route_id,
       image_preset_id,
       preset_id,
       target_vault_id,
       requested_width,
       output_format,
       quality,
       fit_mode,
       'queued',
       0,
       $2,
       $2
FROM widths
ON CONFLICT (
  source_storage_object_id,
  configuration_version_id,
  configuration_image_preset_id,
  requested_width,
  output_format
) DO NOTHING
RETURNING image_derivative_job_id
)
SELECT image_derivative_job_id FROM inserted
`, [storageObjectId, now]);
  return result.rows.length;
}

export async function listStatus(
  context: PostgresImageDerivativeContext,
  clientId: string,
  environment: 'dev' | 'staging' | 'prod',
  limit: number = IMAGE_DERIVATIVE_LIMITS.maximumStatusRows,
): Promise<readonly Readonly<ImageDerivativeStatusSnapshot>[]> {
  const boundedLimit = Math.min(
    IMAGE_DERIVATIVE_LIMITS.maximumStatusRows,
    Math.max(1, Number.isSafeInteger(limit) ? limit : IMAGE_DERIVATIVE_LIMITS.maximumStatusRows),
  );
  const result = await context.queryable.query<JobRow>(`
SELECT job.*, version.environment
FROM public.storage_image_derivative_jobs AS job
JOIN public.storage_control_clients AS client
ON client.id = job.storage_control_client_id
JOIN public.storage_control_configuration_versions AS version
ON version.storage_control_client_id = job.storage_control_client_id
 AND version.id = job.configuration_version_id
WHERE client.client_id = $1
AND version.environment = $2
ORDER BY job.created_at DESC, job.image_derivative_job_id DESC
LIMIT $3
`, [clientId, environment, boundedLimit]);
  return Object.freeze(result.rows.map(status));
}

export async function claimNext(context: PostgresImageDerivativeContext, workerId: string, now = context.now()): Promise<Readonly<ImageDerivativeJobSnapshot> | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workerId)) {
    throw new ImageDerivativeError('invalid-request', 'image-derivative-worker-id-invalid', 400);
  }
  return transaction(context.pool, async (client) => {
    const leaseToken = context.createLeaseToken();
    const leaseExpiresAt = new Date(now.getTime() + IMAGE_DERIVATIVE_LIMITS.leaseDurationMs);
    const result = await client.query<JobRow>(`
WITH candidate AS (
SELECT job.image_derivative_job_id
FROM public.storage_image_derivative_jobs AS job
WHERE (
    job.state = 'queued'
    OR (
      job.state = 'failed'
      AND job.attempt_count < $1
      AND job.next_attempt_at IS NOT NULL
      AND job.next_attempt_at <= $2
    )
    OR (
      job.state = 'processing'
      AND job.lease_expires_at IS NOT NULL
      AND job.lease_expires_at <= $2
      AND job.attempt_count < $1
    )
  )
ORDER BY COALESCE(job.next_attempt_at, job.created_at), job.created_at
FOR UPDATE SKIP LOCKED
LIMIT 1
), claimed AS (
UPDATE public.storage_image_derivative_jobs AS job
   SET state = 'processing',
       attempt_count = job.attempt_count + 1,
       lease_owner = $3,
       lease_token = $4,
       lease_expires_at = $5,
       started_at = COALESCE(job.started_at, $2),
       finished_at = NULL,
       next_attempt_at = NULL,
       safe_diagnostic_category = NULL,
       safe_diagnostic_code = NULL,
       updated_at = $2,
       row_version = job.row_version + 1
  FROM candidate
 WHERE job.image_derivative_job_id = candidate.image_derivative_job_id
RETURNING job.*
)
SELECT claimed.*, version.environment
FROM claimed
JOIN public.storage_control_configuration_versions AS version
ON version.storage_control_client_id = claimed.storage_control_client_id
 AND version.id = claimed.configuration_version_id
`, [IMAGE_DERIVATIVE_LIMITS.maximumAttempts, now, workerId, leaseToken, leaseExpiresAt]);
    const row = result.rows[0];
    return row === undefined ? null : claimedJob(row);
  });
}

export async function readSource(context: PostgresImageDerivativeContext, job: Readonly<ImageDerivativeJobSnapshot>): Promise<Readonly<ImageDerivativeSourceSnapshot>> {
  const result = await context.queryable.query<SourceRow>(`
SELECT object.storage_object_id,
     object.verified_checksum_sha256,
     object.verified_byte_length,
     object.expected_content_type,
     copy.storage_object_copy_id,
     copy.target_role,
     copy.target_order,
     copy.provider_connection_id,
     connection.provider_type,
     vault.bucket_label,
     vault.prefix_template,
     connection.secret_reference_id,
     copy.internal_locator
FROM public.storage_objects AS object
JOIN public.storage_object_copies AS copy
ON copy.storage_object_id = object.storage_object_id
 AND copy.copy_state = 'verified'
 AND copy.configuration_route_target_id IS NOT NULL
JOIN public.storage_control_configuration_vaults AS vault
ON vault.storage_control_client_id = object.storage_control_client_id
 AND vault.configuration_version_id = object.configuration_version_id
 AND vault.id = copy.configuration_vault_id
JOIN public.storage_control_provider_connections AS connection
ON connection.storage_control_client_id = object.storage_control_client_id
 AND connection.id = copy.provider_connection_id
WHERE object.storage_object_id = $1
AND object.storage_control_client_id = $2
AND object.configuration_version_id = $3
AND object.configuration_fingerprint = $4
AND object.configuration_route_id = $5
AND object.registry_state = 'active'
AND object.verified_checksum_sha256 IS NOT NULL
AND object.verified_byte_length IS NOT NULL
ORDER BY CASE copy.target_role WHEN 'primary' THEN 0 ELSE 1 END, copy.target_order
`, [
    job.sourceStorageObjectId,
    job.storageControlClientId,
    job.configurationVersionId,
    job.configurationFingerprint,
    job.configurationRouteId,
  ]);
  const first = result.rows[0];
  if (first === undefined) {
    throw new ImageDerivativeError(
      'dependency-unavailable',
      'image-derivative-source-unavailable',
      503,
      true,
    );
  }
  return Object.freeze({
    storageObjectId: first.storage_object_id,
    checksumSha256: first.verified_checksum_sha256,
    byteLength: integer(first.verified_byte_length, 'image-derivative-source-byte-length-invalid'),
    contentType: first.expected_content_type,
    copies: Object.freeze(result.rows.map((row) => Object.freeze({
      storageObjectCopyId: row.storage_object_copy_id,
      target: Object.freeze({
        providerRole: row.target_role,
        providerId: row.provider_connection_id,
        bucketLabel: row.bucket_label,
        internalLocator: row.internal_locator,
        credentialSecretReferenceId: row.secret_reference_id,
      }),
    }))),
  });
}
