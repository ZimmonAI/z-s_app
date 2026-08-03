import type { SafeDiagnostic } from './runtime-contract.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryable,
} from './runtime-storage-registry-types.js';
import {
  ImageDerivativeError,
  type ImageDerivativeFit,
  type ImageDerivativeJobSnapshot,
  type ImageDerivativeOutputFormat,
  type ImageDerivativeState,
  type ImageDerivativeStatusSnapshot,
} from './image-derivative.js';

export interface JobRow extends Record<string, unknown> {
  image_derivative_job_id: string;
  source_storage_object_id: string;
  reserved_output_storage_object_id: string | null;
  storage_control_client_id: string;
  environment: 'dev' | 'staging' | 'prod';
  configuration_version_id: string;
  configuration_fingerprint: string;
  configuration_route_id: string;
  configuration_image_preset_id: string;
  preset_id: string;
  target_configuration_vault_id: string;
  requested_width: number;
  output_format: ImageDerivativeOutputFormat;
  quality: number;
  fit_mode: ImageDerivativeFit;
  state: ImageDerivativeState;
  attempt_count: number;
  lease_token: string | null;
  lease_expires_at: Date | string | null;
  safe_diagnostic_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  finished_at: Date | string | null;
}

export interface SourceRow extends Record<string, unknown> {
  storage_object_id: string;
  verified_checksum_sha256: string;
  verified_byte_length: number | string;
  expected_content_type: string;
  storage_object_copy_id: string;
  target_role: 'primary' | 'replica';
  target_order: number;
  provider_connection_id: string;
  provider_type: 'minio' | 'r2' | 's3-compatible';
  bucket_label: string;
  prefix_template: string;
  secret_reference_id: string;
  internal_locator: string;
}

export interface OutputReservationRow extends Record<string, unknown> {
  storage_object_id: string;
  storage_object_copy_id: string;
  copy_state: 'pending' | 'verified' | 'failed' | 'missing' | 'delete_pending' | 'deleted';
  verified_checksum_sha256: string | null;
  verified_byte_length: number | string | null;
  provider_connection_id: string;
  provider_type: 'minio' | 'r2' | 's3-compatible';
  bucket_label: string;
  prefix_template: string;
  secret_reference_id: string;
  internal_locator: string;
}

export function timestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ImageDerivativeError('internal', 'image-derivative-timestamp-invalid');
  }
  return date.toISOString();
}

export function integer(value: number | string, code: string): number {
  const normalized = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new ImageDerivativeError('internal', code);
  }
  return normalized;
}

export function status(row: Readonly<JobRow>): Readonly<ImageDerivativeStatusSnapshot> {
  const snapshot: ImageDerivativeStatusSnapshot = {
    jobId: row.image_derivative_job_id,
    sourceStorageObjectId: row.source_storage_object_id,
    presetId: row.preset_id,
    width: row.requested_width,
    outputFormat: row.output_format,
    state: row.state,
    attemptCount: row.attempt_count,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
  if (row.reserved_output_storage_object_id !== null) {
    (snapshot as { outputStorageObjectId?: string }).outputStorageObjectId =
      row.reserved_output_storage_object_id;
  }
  if (row.safe_diagnostic_code !== null) {
    (snapshot as { safeDiagnosticCode?: string }).safeDiagnosticCode = row.safe_diagnostic_code;
  }
  if (row.finished_at !== null) {
    (snapshot as { finishedAt?: string }).finishedAt = timestamp(row.finished_at);
  }
  return Object.freeze(snapshot);
}

export function claimedJob(row: Readonly<JobRow>): Readonly<ImageDerivativeJobSnapshot> {
  if (row.lease_token === null || row.lease_expires_at === null) {
    throw new ImageDerivativeError('internal', 'image-derivative-lease-missing');
  }
  return Object.freeze({
    ...status(row),
    storageControlClientId: row.storage_control_client_id,
    environment: row.environment,
    configurationVersionId: row.configuration_version_id,
    configurationFingerprint: row.configuration_fingerprint,
    configurationRouteId: row.configuration_route_id,
    imagePresetId: row.configuration_image_preset_id,
    targetVaultId: row.target_configuration_vault_id,
    quality: row.quality,
    fit: row.fit_mode,
    leaseToken: row.lease_token,
    leaseExpiresAt: timestamp(row.lease_expires_at),
  });
}

export function safeCode(value: string): string {
  return /^[a-z0-9][a-z0-9-]{0,95}$/.test(value)
    ? value
    : 'image-derivative-failed';
}

export function safeCategory(value: SafeDiagnostic['category']): SafeDiagnostic['category'] {
  return value;
}

export function locator(prefixTemplate: string, storageObjectId: string): string {
  if (
    prefixTemplate.length < 2 ||
    !prefixTemplate.endsWith('/*') ||
    prefixTemplate.startsWith('/') ||
    prefixTemplate.includes('..') ||
    prefixTemplate.includes('\\') ||
    prefixTemplate.includes('://')
  ) {
    throw new ImageDerivativeError(
      'dependency-unavailable',
      'image-derivative-vault-prefix-invalid',
      503,
    );
  }
  return `${prefixTemplate.slice(0, -1)}${storageObjectId}`;
}

export async function transaction<T>(pool: PostgresPoolLike, action: (client: PostgresClientLike) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original failure remains authoritative.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function lockedJob(
  queryable: PostgresQueryable,
  job: Readonly<ImageDerivativeJobSnapshot>,
): Promise<JobRow> {
  const result = await queryable.query<JobRow>(`
SELECT job.*, version.environment
FROM public.storage_image_derivative_jobs AS job
JOIN public.storage_control_configuration_versions AS version
  ON version.storage_control_client_id = job.storage_control_client_id
 AND version.id = job.configuration_version_id
WHERE job.image_derivative_job_id = $1
FOR UPDATE OF job
`, [job.jobId]);
  const row = result.rows[0];
  if (row === undefined) {
    throw new ImageDerivativeError('invalid-request', 'image-derivative-job-not-found', 404);
  }
  if (
    row.state !== 'processing' ||
    row.lease_token !== job.leaseToken ||
    row.lease_expires_at === null
  ) {
    throw new ImageDerivativeError('duplicate-conflict', 'image-derivative-lease-lost', 409);
  }
  return row;
}
