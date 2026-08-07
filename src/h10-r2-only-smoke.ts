import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { HttpStorageRuntime } from './runtime-contract.js';
import {
  S3CompatibleProviderObjectReader,
  ProviderReadExecutionError,
  type ResolvedProviderReadTarget,
} from './runtime-read-delivery.js';
import {
  S3CompatibleProviderObjectWriter,
  type ResolvedProviderWriteTarget,
} from './runtime-s3-provider.js';
import { createRuntimeProviderCredentialResolver } from './runtime-local-composition.js';

const ROUTE = '/__h10/r2-only';
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
});

interface PrimaryRow {
  storage_object_id: string;
  registry_state: string;
  object_protection_stage: string;
  verified_checksum_sha256: string;
  verified_byte_length: string | number;
  copy_state: string;
  observed_checksum_sha256: string;
  observed_byte_length: string | number;
  latest_verified_at: Date | string;
  target_role: string;
  target_order: number;
  internal_locator: string;
  connection_id: string;
  provider_type: string;
  secret_reference_id: string;
  bucket_label: string;
  prefix_template: string;
  retention_mode: string;
  delete_after_days: number | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function u32(value: number): Uint8Array {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from([...value].map((entry) => entry.charCodeAt(0)));
}

function box(type: string, payload: Uint8Array): Uint8Array {
  return concat([u32(8 + payload.byteLength), ascii(type), payload]);
}

function fixtureMp4(): Uint8Array {
  const ftyp = box('ftyp', concat([ascii('isom'), u32(0)]));
  const mvhdPayload = concat([
    Uint8Array.of(0, 0, 0, 0),
    u32(0),
    u32(0),
    u32(1000),
    u32(1000),
  ]);
  const moov = box('moov', box('mvhd', mvhdPayload));
  return concat([ftyp, moov]);
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`invalid-${name}`);
  return value;
}

function numberField(value: unknown, name: string): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`invalid-${name}`);
  return result;
}

async function bodyResult(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('invalid-runtime-response');
  }
  if (!response.ok) {
    const error = (body as Record<string, unknown>).error;
    if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
      const diagnostic = (error as Record<string, unknown>).diagnostic;
      if (diagnostic !== null && typeof diagnostic === 'object' && !Array.isArray(diagnostic)) {
        const code = (diagnostic as Record<string, unknown>).code;
        if (typeof code === 'string' && /^[a-z0-9][a-z0-9-]{0,95}$/.test(code)) {
          throw new Error(code);
        }
      }
      const code = (error as Record<string, unknown>).code;
      if (typeof code === 'string' && /^[a-z0-9][a-z0-9-]{0,95}$/.test(code)) {
        throw new Error(code);
      }
    }
    throw new Error(`runtime-status-${response.status}`);
  }
  const result = (body as Record<string, unknown>).result;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('invalid-runtime-result');
  }
  return result as Record<string, unknown>;
}

function baseHeaders(token: string, correlation: string, idempotencyKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'x-zs-contract-version': '1.0',
    'x-zs-caller-app': 'video-maker_app',
    'x-app-correlation-reference': correlation,
    'idempotency-key': idempotencyKey,
  };
}

async function createIntent(
  runtime: HttpStorageRuntime,
  token: string,
  correlation: string,
  idempotencyKey: string,
  bytes: Uint8Array,
  checksumSha256: string,
): Promise<Record<string, unknown>> {
  return bodyResult(await runtime.handle(new Request('https://h10.internal/v1/object-write-intents', {
    method: 'POST',
    headers: {
      ...baseHeaders(token, correlation, idempotencyKey),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      storageProfile: {
        profileId: 'video-maker-dev-default',
        profileVersion: 1,
        environment: 'dev',
      },
      mediaType: 'video/mp4',
      byteLength: bytes.byteLength,
      checksumSha256,
      sourceReference: `h10-r2-only-${correlation}`,
    }),
  })));
}

async function upload(
  runtime: HttpStorageRuntime,
  token: string,
  correlation: string,
  idempotencyKey: string,
  objectWriteIntentId: string,
  uploadCompletionToken: string,
  bytes: Uint8Array,
  checksumSha256: string,
): Promise<Record<string, unknown>> {
  return bodyResult(await runtime.handle(new Request(
    `https://h10.internal/v1/object-write-intents/${objectWriteIntentId}/content`,
    {
      method: 'PUT',
      headers: {
        ...baseHeaders(token, correlation, idempotencyKey),
        'x-zs-upload-completion-token': uploadCompletionToken,
        'x-content-sha256': checksumSha256,
        'content-type': 'video/mp4',
        'content-length': String(bytes.byteLength),
      },
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    },
  )));
}

async function hashRead(
  reader: S3CompatibleProviderObjectReader,
  target: Readonly<ResolvedProviderReadTarget>,
): Promise<Readonly<{ checksumSha256: string; byteLength: number }>> {
  const result = await reader.get({ target });
  try {
    const hash = createHash('sha256');
    let byteLength = 0;
    for await (const chunk of result.body) {
      const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk as never);
      hash.update(bytes);
      byteLength += bytes.byteLength;
    }
    return Object.freeze({ checksumSha256: hash.digest('hex'), byteLength });
  } finally {
    result.close();
  }
}

async function cleanupRows(pool: Pool, storageObjectId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM public.storage_reconciliation_issues WHERE storage_object_id = $1', [storageObjectId]);
    await client.query('DELETE FROM public.storage_operation_events WHERE storage_object_id = $1', [storageObjectId]);
    await client.query('DELETE FROM public.storage_provider_attempts WHERE storage_object_id = $1', [storageObjectId]);
    await client.query('DELETE FROM public.storage_idempotency_records WHERE result_storage_object_id = $1', [storageObjectId]);
    await client.query('DELETE FROM public.object_write_intents WHERE storage_object_id = $1', [storageObjectId]);
    await client.query('DELETE FROM public.storage_object_copies WHERE storage_object_id = $1', [storageObjectId]);
    await client.query('DELETE FROM public.storage_objects WHERE storage_object_id = $1', [storageObjectId]);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

function safeCode(error: unknown): string {
  if (error instanceof ProviderReadExecutionError) return error.code;
  if (error instanceof Error && /^[a-z0-9][a-z0-9-]{0,95}$/.test(error.message)) return error.message;
  return 'h10-r2-smoke-failed';
}

export async function maybeRunH10R2OnlySmoke(input: Readonly<{
  request: Request;
  runtime: HttpStorageRuntime;
  environment: NodeJS.ProcessEnv;
}>): Promise<Response | null> {
  const url = new URL(input.request.url);
  if (url.pathname !== ROUTE) return null;
  if (input.request.method !== 'GET') return json({ error: { code: 'method-not-allowed' } }, 405);
  if (input.environment.VERCEL_ENV !== 'preview') return json({ error: { code: 'preview-only' } }, 404);

  const postgresUrl = input.environment.Z_S_POSTGRES_URL?.trim();
  const token = input.environment.Z_S_VIDEO_MAKER_BEARER_TOKEN?.trim();
  const bindings = input.environment.Z_S_PROVIDER_CREDENTIAL_BINDINGS_JSON?.trim();
  if (!postgresUrl || !token || !bindings) {
    return json({ error: { code: 'h10-r2-runtime-input-unavailable' } }, 503);
  }

  const pool = new Pool({
    connectionString: postgresUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: false,
    application_name: 'z-s-h10-r2-only-smoke',
  });
  const resolver = createRuntimeProviderCredentialResolver(bindings);
  const reader = new S3CompatibleProviderObjectReader({ credentialResolver: resolver });
  const writer = new S3CompatibleProviderObjectWriter({ credentialResolver: resolver });
  const correlation = `h10-r2-${randomUUID()}`;
  const intentKey = `h10-r2-intent-${randomUUID()}`;
  const uploadKey = `h10-r2-upload-${randomUUID()}`;
  const bytes = fixtureMp4();
  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
  let storageObjectId: string | undefined;
  let writeTarget: Readonly<ResolvedProviderWriteTarget> | undefined;
  let providerDeleted = false;
  let databaseCleaned = false;

  try {
    const firstIntent = await createIntent(
      input.runtime, token, correlation, intentKey, bytes, checksumSha256,
    );
    const replayIntent = await createIntent(
      input.runtime, token, correlation, intentKey, bytes, checksumSha256,
    );
    const writeIntentId = stringField(firstIntent.writeIntentId, 'write-intent-id');
    storageObjectId = stringField(firstIntent.storageObjectId, 'storage-object-id');
    const completionToken = stringField(firstIntent.uploadCompletionToken, 'upload-completion-token');
    if (stringField(replayIntent.writeIntentId, 'replay-write-intent-id') !== writeIntentId) {
      throw new Error('idempotent-replay-mismatch');
    }
    if (stringField(replayIntent.storageObjectId, 'replay-storage-object-id') !== storageObjectId) {
      throw new Error('idempotent-replay-mismatch');
    }

    const uploadResult = await upload(
      input.runtime,
      token,
      correlation,
      uploadKey,
      writeIntentId,
      completionToken,
      bytes,
      checksumSha256,
    );

    const primary = (await pool.query<PrimaryRow>(
      `SELECT
         object_record.storage_object_id,
         object_record.registry_state,
         object_record.object_protection_stage,
         object_record.verified_checksum_sha256,
         object_record.verified_byte_length,
         copy.copy_state,
         copy.observed_checksum_sha256,
         copy.observed_byte_length,
         copy.latest_verified_at,
         copy.target_role,
         copy.target_order,
         copy.internal_locator,
         connection.connection_id,
         connection.provider_type,
         connection.secret_reference_id,
         vault.bucket_label,
         vault.prefix_template,
         vault.retention_mode,
         vault.delete_after_days
       FROM public.storage_objects AS object_record
       JOIN public.storage_object_copies AS copy
         ON copy.storage_object_id = object_record.storage_object_id
        AND copy.target_role = 'primary'
        AND copy.target_order = 0
       JOIN public.storage_control_provider_connections AS connection
         ON connection.id = copy.provider_connection_id
       JOIN public.storage_control_configuration_vaults AS vault
         ON vault.id = copy.configuration_vault_id
      WHERE object_record.storage_object_id = $1`,
      [storageObjectId],
    )).rows[0];
    if (primary === undefined) throw new Error('r2-primary-authority-missing');
    if (primary.provider_type !== 'r2') throw new Error('r2-primary-not-selected');
    if (primary.copy_state !== 'verified') throw new Error('r2-primary-not-verified');
    if (primary.observed_checksum_sha256 !== checksumSha256) throw new Error('r2-primary-checksum-mismatch');
    if (numberField(primary.observed_byte_length, 'observed-byte-length') !== bytes.byteLength) {
      throw new Error('r2-primary-length-mismatch');
    }

    const readTarget: Readonly<ResolvedProviderReadTarget> = Object.freeze({
      providerRole: 'primary',
      providerId: primary.connection_id,
      bucketLabel: primary.bucket_label,
      internalLocator: primary.internal_locator,
      credentialSecretReferenceId: primary.secret_reference_id,
    });
    writeTarget = Object.freeze({
      providerRole: 'primary',
      providerId: primary.connection_id,
      bucketLabel: primary.bucket_label,
      internalLocator: primary.internal_locator,
      normalizedPrefixPattern: primary.prefix_template,
      capabilityPolicy: Object.freeze({
        checksumVerification: 'required' as const,
        sizeVerification: 'required-when-supported' as const,
        headContentLength: 'required' as const,
        rangeRead: 'optional' as const,
      }),
      credentialSecretReferenceId: primary.secret_reference_id,
    });

    const direct = await hashRead(reader, readTarget);
    if (direct.checksumSha256 !== checksumSha256 || direct.byteLength !== bytes.byteLength) {
      throw new Error('r2-direct-read-integrity-mismatch');
    }
    const head = await reader.head({ target: readTarget });
    if (head.byteLength !== bytes.byteLength) throw new Error('r2-head-length-mismatch');

    let safeFailureCode = '';
    try {
      await reader.head({
        target: Object.freeze({
          ...readTarget,
          credentialSecretReferenceId: `h10-missing-${randomUUID()}`,
        }),
      });
      throw new Error('r2-missing-credential-unexpected-success');
    } catch (error) {
      safeFailureCode = safeCode(error);
    }
    const afterFailure = await reader.head({ target: readTarget });
    if (afterFailure.byteLength !== bytes.byteLength) throw new Error('r2-not-preserved-after-safe-failure');

    const latestVerifiedAt = new Date(primary.latest_verified_at);
    if (!Number.isFinite(latestVerifiedAt.getTime())) throw new Error('r2-verified-at-invalid');
    let retention: Record<string, unknown>;
    if (primary.retention_mode === 'delete-after-days' && primary.delete_after_days !== null) {
      const deleteAfterDays = numberField(primary.delete_after_days, 'delete-after-days');
      const eligibleAt = new Date(latestVerifiedAt.getTime() + deleteAfterDays * 86_400_000);
      retention = {
        mode: 'delete-after-days',
        deleteAfterDays,
        latestVerifiedAt: latestVerifiedAt.toISOString(),
        eligibleAt: eligibleAt.toISOString(),
        eligibleNow: Date.now() >= eligibleAt.getTime(),
        eligibleAtBoundary: eligibleAt.getTime() >= latestVerifiedAt.getTime(),
      };
    } else if (primary.retention_mode === 'permanent') {
      retention = { mode: 'permanent', eligibleNow: false, eligibleAtBoundary: false };
    } else {
      throw new Error('r2-retention-policy-invalid');
    }

    const cleanup = await writer.cleanup({ target: writeTarget });
    if (!cleanup.deleted) throw new Error(cleanup.diagnostic?.code ?? 'r2-delete-failed');
    providerDeleted = true;
    let absenceCode = '';
    try {
      await reader.head({ target: readTarget });
      throw new Error('r2-delete-absence-failed');
    } catch (error) {
      absenceCode = safeCode(error);
      if (absenceCode !== 'provider-read-missing') throw error;
    }

    await cleanupRows(pool, storageObjectId);
    databaseCleaned = true;

    return json({
      result: {
        scope: 'h10-r2-only',
        minio: 'skipped-by-user',
        runtimeRevision: input.environment.VERCEL_GIT_COMMIT_SHA ?? null,
        governedUpload: true,
        idempotentIntentReplay: true,
        providerType: primary.provider_type,
        primaryCopyState: primary.copy_state,
        registryStateAfterUpload: primary.registry_state,
        objectProtectionStageAfterUpload: primary.object_protection_stage,
        uploadStorageState: typeof uploadResult.storageState === 'string' ? uploadResult.storageState : null,
        directReadChecksumVerified: true,
        directReadByteLengthVerified: true,
        safeCredentialFailureCode: safeFailureCode,
        objectPreservedAfterCredentialFailure: true,
        retention,
        retentionWorkerInvoked: false,
        retentionWorkerReason: 'minio-protection-explicitly-skipped',
        exactR2DeleteVerified: true,
        postDeleteAbsenceCode: absenceCode,
        cleanup: {
          providerDeleted,
          databaseCleaned,
        },
      },
    });
  } catch (error) {
    return json({
      error: {
        code: safeCode(error),
        scope: 'h10-r2-only',
        minio: 'skipped-by-user',
        cleanup: { providerDeleted, databaseCleaned },
      },
    }, 500);
  } finally {
    if (writeTarget !== undefined && !providerDeleted) {
      try {
        const cleanup = await writer.cleanup({ target: writeTarget });
        providerDeleted = cleanup.deleted;
      } catch {}
    }
    if (storageObjectId !== undefined && !databaseCleaned) {
      try {
        await cleanupRows(pool, storageObjectId);
        databaseCleaned = true;
      } catch {}
    }
    await pool.end();
  }
}
