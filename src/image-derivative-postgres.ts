import { randomUUID } from 'node:crypto';
import type { ClientStorageEnvironment } from './client-storage-configuration.js';
import {
  IMAGE_DERIVATIVE_LIMITS,
  ImageDerivativeError,
  type ImageDerivativeClaimInput,
  type ImageDerivativeFailureInput,
  type ImageDerivativeJob,
  type ImageDerivativeOutputFormat,
  type ImageDerivativeStatus,
  type ImageDerivativeStore,
  type VerifiedImageDerivativeOutput,
} from './image-derivative.js';
import type { ResolvedProviderReadTarget } from './runtime-read-delivery.js';
import type { ResolvedProviderWriteTarget } from './runtime-s3-provider.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryable,
} from './runtime-storage-registry-types.js';

interface ImageDerivativePostgresPool extends PostgresPoolLike, PostgresQueryable {}

interface EnqueueRow extends Record<string, unknown> {
  storage_object_id: string;
  storage_control_client_id: string;
  environment: ClientStorageEnvironment;
  configuration_version_id: string;
  configuration_fingerprint: string;
  configuration_route_id: string;
  configuration_image_preset_id: string;
  preset_id: string;
  target_configuration_vault_id: string;
  resize_widths: unknown;
  output_format: ImageDerivativeOutputFormat;
  quality: number;
  fit_mode: ImageDerivativeJob['fit'];
}

interface JobRow extends Record<string, unknown> {
  image_derivative_job_id: string;
  source_storage_object_id: string;
  storage_control_client_id: string;
  environment: ClientStorageEnvironment;
  configuration_version_id: string;
  configuration_fingerprint: string;
  configuration_route_id: string;
  configuration_image_preset_id: string;
  preset_id: string;
  target_configuration_vault_id: string;
  requested_width: number;
  output_format: ImageDerivativeOutputFormat;
  quality: number;
  fit_mode: ImageDerivativeJob['fit'];
  state: ImageDerivativeJob['state'];
  attempt_count: number;
  maximum_attempts: number;
  lease_token: string;
}

interface StatusRow extends Record<string, unknown> {
  image_derivative_job_id: string;
  source_storage_object_id: string;
  output_storage_object_id: string | null;
  preset_id: string;
  requested_width: number;
  output_format: ImageDerivativeOutputFormat;
  state: ImageDerivativeJob['state'];
  attempt_count: number;
  safe_diagnostic_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  finished_at: Date | string | null;
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

export interface ImageDerivativeSourceAuthority {
  readonly mediaType: string;
  readonly byteLength: number;
  readonly checksumSha256: string;
  readonly target: Readonly<ResolvedProviderReadTarget>;
}

export interface ImageDerivativeOutputReservation {
  readonly storageObjectId: string;
  readonly storageObjectCopyId: string;
  readonly target: Readonly<ResolvedProviderWriteTarget>;
  readonly alreadyVerified?: Readonly<VerifiedImageDerivativeOutput>;
}

const ENQUEUE_SOURCE_QUERY = `
SELECT
  objects.storage_object_id,
  objects.storage_control_client_id,
  versions.environment,
  objects.configuration_version_id,
  objects.configuration_fingerprint,
  objects.configuration_route_id,
  presets.id AS configuration_image_preset_id,
  presets.preset_id,
  presets.target_vault_id AS target_configuration_vault_id,
  presets.resize_widths,
  presets.output_format,
  presets.quality,
  presets.fit_mode
FROM public.storage_objects AS objects
JOIN public.storage_control_configuration_versions AS versions
  ON versions.storage_control_client_id = objects.storage_control_client_id
 AND versions.id = objects.configuration_version_id
JOIN public.storage_control_configuration_routes AS routes
  ON routes.storage_control_client_id = objects.storage_control_client_id
 AND routes.configuration_version_id = objects.configuration_version_id
 AND routes.id = objects.configuration_route_id
JOIN public.storage_control_configuration_image_presets AS presets
  ON presets.storage_control_client_id = objects.storage_control_client_id
 AND presets.configuration_version_id = objects.configuration_version_id
 AND presets.id = routes.image_preset_id
WHERE objects.storage_object_id = $1
  AND objects.registry_state = 'active'
  AND objects.verified_checksum_sha256 IS NOT NULL
  AND objects.verified_byte_length IS NOT NULL
  AND objects.expected_content_type LIKE 'image/%'
  AND routes.asset_class = 'image';
`;

const STATUS_QUERY = `
SELECT
  jobs.image_derivative_job_id,
  jobs.source_storage_object_id,
  outputs.output_storage_object_id,
  jobs.preset_id,
  jobs.requested_width,
  jobs.output_format,
  jobs.state,
  jobs.attempt_count,
  jobs.safe_diagnostic_code,
  jobs.created_at,
  jobs.updated_at,
  jobs.finished_at
FROM public.storage_image_derivative_jobs AS jobs
JOIN public.storage_control_clients AS clients
  ON clients.id = jobs.storage_control_client_id
LEFT JOIN public.storage_image_derivative_outputs AS outputs
  ON outputs.image_derivative_job_id = jobs.image_derivative_job_id
WHERE clients.client_id = $1
  AND jobs.environment = $2
ORDER BY jobs.created_at DESC, jobs.image_derivative_job_id DESC
LIMIT $3;
`;

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ImageDerivativeError('dependency-unavailable', 'image-derivative-store-invalid-time', true);
  }
  return date.toISOString();
}

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

function widths(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > IMAGE_DERIVATIVE_LIMITS.maximumWidthsPerPreset) {
    throw new ImageDerivativeError('dependency-unavailable', 'image-derivative-preset-widths-invalid', false);
  }
  const result = value.map((entry) => {
    if (
      !Number.isSafeInteger(entry) ||
      (entry as number) < IMAGE_DERIVATIVE_LIMITS.minimumWidth ||
      (entry as number) > IMAGE_DERIVATIVE_LIMITS.maximumWidth
    ) {
      throw new ImageDerivativeError('dependency-unavailable', 'image-derivative-preset-widths-invalid', false);
    }
    return entry as number;
  });
  if (new Set(result).size !== result.length) {
    throw new ImageDerivativeError('dependency-unavailable', 'image-derivative-preset-widths-invalid', false);
  }
  return Object.freeze(result);
}

async function transaction<T>(pool: ImageDerivativePostgresPool, operation: (client: PostgresClientLike) => Promise<T>): Promise<T> {
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

export class PostgresImageDerivativeStore implements ImageDerivativeStore {
  readonly configured = true;
  readonly #pool: ImageDerivativePostgresPool;
  readonly #createId: () => string;

  constructor(pool: ImageDerivativePostgresPool, createId: () => string = randomUUID) {
    this.#pool = pool;
    this.#createId = createId;
  }

  async enqueueVerifiedSource(storageObjectId: string, now = new Date()): Promise<number> {
    try {
      return await transaction(this.#pool, async (client) => {
        const authority = (await client.query<EnqueueRow>(ENQUEUE_SOURCE_QUERY, [storageObjectId])).rows[0];
        if (authority === undefined) return 0;
        let created = 0;
        for (const width of widths(authority.resize_widths)) {
          const result = await client.query(
            `INSERT INTO public.storage_image_derivative_jobs (
              image_derivative_job_id,
              source_storage_object_id,
              storage_control_client_id,
              environment,
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
              maximum_attempts,
              created_at,
              updated_at,
              row_version
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
              $11, $12, $13, $14, 'queued', 0, $15, $16, $16, 1
            )
            ON CONFLICT (
              source_storage_object_id,
              configuration_version_id,
              configuration_image_preset_id,
              requested_width,
              output_format
            ) DO NOTHING`,
            [
              this.#createId(),
              authority.storage_object_id,
              authority.storage_control_client_id,
              authority.environment,
              authority.configuration_version_id,
              authority.configuration_fingerprint,
              authority.configuration_route_id,
              authority.configuration_image_preset_id,
              authority.preset_id,
              authority.target_configuration_vault_id,
              width,
              authority.output_format,
              authority.quality,
              authority.fit_mode,
              IMAGE_DERIVATIVE_LIMITS.maximumAttempts,
              now,
            ],
          );
          created += result.rowCount ?? 0;
        }
        return created;
      });
    } catch (error) {
      throw storeFailure(error, 'image-derivative-enqueue-unavailable');
    }
  }

  async listStatus(
    clientId: string,
    environment: ClientStorageEnvironment,
    limit: number,
  ): Promise<readonly Readonly<ImageDerivativeStatus>[]> {
    const boundedLimit = Math.max(1, Math.min(IMAGE_DERIVATIVE_LIMITS.statusResultLimit, limit));
    try {
      const rows = (await this.#pool.query<StatusRow>(STATUS_QUERY, [clientId, environment, boundedLimit])).rows;
      return Object.freeze(rows.map((row) => Object.freeze({
        jobId: row.image_derivative_job_id,
        sourceStorageObjectId: row.source_storage_object_id,
        ...(row.output_storage_object_id === null ? {} : { outputStorageObjectId: row.output_storage_object_id }),
        presetId: row.preset_id,
        width: row.requested_width,
        format: row.output_format,
        state: row.state,
        attemptCount: row.attempt_count,
        ...(row.safe_diagnostic_code === null ? {} : { safeDiagnosticCode: row.safe_diagnostic_code }),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        ...(row.finished_at === null ? {} : { finishedAt: iso(row.finished_at) }),
      })));
    } catch (error) {
      throw storeFailure(error, 'image-derivative-status-unavailable');
    }
  }

  async claimNext(input: Readonly<ImageDerivativeClaimInput>): Promise<Readonly<ImageDerivativeJob> | null> {
    const now = input.now ?? new Date();
    const leaseToken = this.#createId();
    try {
      return await transaction(this.#pool, async (client) => {
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

  async complete(
    job: Readonly<ImageDerivativeJob>,
    output: Readonly<VerifiedImageDerivativeOutput>,
    now = new Date(),
  ): Promise<void> {
    try {
      await transaction(this.#pool, async (client) => {
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
           ON CONFLICT (image_derivative_job_id) DO NOTHING`,
          [this.#createId(), job.id, output.storageObjectId, output.byteLength, output.checksumSha256, now, job.leaseToken],
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
            throw new ImageDerivativeError('duplicate-conflict', 'image-derivative-completion-conflict', false);
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
              AND state IN ('processing', 'succeeded')
              AND (lease_token = $3 OR state = 'succeeded')`,
          [job.id, now, job.leaseToken],
        );
        if ((updated.rowCount ?? 0) === 0) {
          throw new ImageDerivativeError('duplicate-conflict', 'image-derivative-lease-lost', false);
        }
      });
    } catch (error) {
      throw storeFailure(error, 'image-derivative-completion-unavailable');
    }
  }

  async fail(input: Readonly<ImageDerivativeFailureInput>): Promise<void> {
    const now = input.now ?? new Date();
    const retry = input.retryable && input.job.attemptCount < input.job.maximumAttempts;
    try {
      const result = await this.#pool.query(
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
            AND lease_token = $3`,
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
        throw new ImageDerivativeError('duplicate-conflict', 'image-derivative-lease-lost', false);
      }
    } catch (error) {
      throw storeFailure(error, 'image-derivative-failure-recording-unavailable');
    }
  }

  async sourceAuthority(job: Readonly<ImageDerivativeJob>): Promise<Readonly<ImageDerivativeSourceAuthority>> {
    try {
      const row = (await this.#pool.query<SourceTargetRow>(
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
        throw new ImageDerivativeError('not-ready', 'image-derivative-source-copy-unavailable', true);
      }
      return Object.freeze({
        mediaType: row.expected_content_type,
        byteLength: integer(row.verified_byte_length, 'image-derivative-source-length-invalid'),
        checksumSha256: row.verified_checksum_sha256,
        target: Object.freeze({
          providerRole: 'replica',
          providerId: row.connection_id,
          bucketLabel: row.bucket_label,
          internalLocator: row.internal_locator,
          credentialSecretReferenceId: row.secret_reference_id,
        }),
      });
    } catch (error) {
      throw storeFailure(error, 'image-derivative-source-authority-unavailable');
    }
  }

  async reserveOutput(
    job: Readonly<ImageDerivativeJob>,
    output: Readonly<{ mediaType: string; byteLength: number; checksumSha256: string }>,
    now = new Date(),
  ): Promise<Readonly<ImageDerivativeOutputReservation>> {
    try {
      return await transaction(this.#pool, async (client) => {
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
          });
          const alreadyVerified =
            existing.registry_state === 'active' &&
            existing.copy_state === 'verified' &&
            existing.verified_byte_length !== null &&
            existing.verified_checksum_sha256 !== null
              ? Object.freeze({
                  storageObjectId: existing.storage_object_id,
                  byteLength: integer(existing.verified_byte_length, 'image-derivative-output-length-invalid'),
                  checksumSha256: existing.verified_checksum_sha256,
                })
              : undefined;
          return Object.freeze({
            storageObjectId: existing.storage_object_id,
            storageObjectCopyId: existing.storage_object_copy_id,
            target,
            ...(alreadyVerified === undefined ? {} : { alreadyVerified }),
          });
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
          throw new ImageDerivativeError('not-ready', 'image-derivative-target-vault-unavailable', true);
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
        return Object.freeze({
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
          }),
        });
      });
    } catch (error) {
      throw storeFailure(error, 'image-derivative-output-reservation-unavailable');
    }
  }

  async markOutputVerified(
    reservation: Readonly<ImageDerivativeOutputReservation>,
    output: Readonly<{ byteLength: number; checksumSha256: string }>,
    now = new Date(),
  ): Promise<void> {
    try {
      await transaction(this.#pool, async (client) => {
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
              AND copy_state IN ('pending', 'failed', 'verified')`,
          [
            reservation.storageObjectCopyId,
            reservation.storageObjectId,
            output.checksumSha256,
            output.byteLength,
            now,
          ],
        );
        if ((copy.rowCount ?? 0) === 0) {
          throw new ImageDerivativeError('duplicate-conflict', 'image-derivative-output-copy-conflict', false);
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
              AND registry_state IN ('reserved', 'degraded', 'active')`,
          [reservation.storageObjectId, output.checksumSha256, output.byteLength, now],
        );
        if ((object.rowCount ?? 0) === 0) {
          throw new ImageDerivativeError('duplicate-conflict', 'image-derivative-output-object-conflict', false);
        }
      });
    } catch (error) {
      throw storeFailure(error, 'image-derivative-output-verification-unavailable');
    }
  }

  async markOutputFailed(
    reservation: Readonly<ImageDerivativeOutputReservation>,
    now = new Date(),
  ): Promise<void> {
    try {
      await transaction(this.#pool, async (client) => {
        await client.query(
          `UPDATE public.storage_object_copies
              SET copy_state = 'failed', updated_at = $3, row_version = row_version + 1
            WHERE storage_object_copy_id = $1 AND storage_object_id = $2 AND copy_state <> 'verified'`,
          [reservation.storageObjectCopyId, reservation.storageObjectId, now],
        );
        await client.query(
          `UPDATE public.storage_objects
              SET registry_state = 'degraded', object_protection_stage = 'derivative-write-failed',
                  updated_at = $2, row_version = row_version + 1
            WHERE storage_object_id = $1 AND registry_state <> 'active'`,
          [reservation.storageObjectId, now],
        );
      });
    } catch (error) {
      throw storeFailure(error, 'image-derivative-output-failure-unavailable');
    }
  }

  async outputReservation(job: Readonly<ImageDerivativeJob>): Promise<Readonly<ImageDerivativeOutputReservation> | null> {
    try {
      const row = (await this.#pool.query<ExistingOutputRow>(
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
         JOIN public.storage_control_configuration_vaults AS vaults ON vaults.id = copies.configuration_vault_id
         JOIN public.storage_control_provider_connections AS connections ON connections.id = copies.provider_connection_id
        WHERE objects.image_derivative_job_id = $1
        LIMIT 1`,
        [job.id],
      )).rows[0];
      if (row === undefined) return null;
      return Object.freeze({
        storageObjectId: row.storage_object_id,
        storageObjectCopyId: row.storage_object_copy_id,
        target: Object.freeze({
          providerRole: 'primary',
          providerId: row.connection_id,
          bucketLabel: row.bucket_label,
          internalLocator: row.internal_locator,
          normalizedPrefixPattern: row.prefix_template,
          credentialSecretReferenceId: row.secret_reference_id,
          capabilityPolicy: Object.freeze({
            checksumVerification: 'required',
            sizeVerification: 'required-when-supported',
            headContentLength: 'required',
            rangeRead: 'optional',
          }),
        }),
      });
    } catch (error) {
      throw storeFailure(error, 'image-derivative-output-authority-unavailable');
    }
  }
}
