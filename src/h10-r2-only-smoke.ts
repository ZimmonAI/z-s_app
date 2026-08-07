import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { HttpStorageRuntime } from './runtime-contract.js';
import {
  ProviderReadExecutionError,
  S3CompatibleProviderObjectReader,
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
  registry_state: string;
  object_protection_stage: string;
  copy_state: string;
  observed_checksum_sha256: string;
  observed_byte_length: string | number;
  latest_verified_at: Date | string;
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
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

function u32(value: number): Uint8Array {
  return Uint8Array.of((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from([...value].map((c) => c.charCodeAt(0)));
}

function box(type: string, payload: Uint8Array): Uint8Array {
  return concat([u32(8 + payload.byteLength), ascii(type), payload]);
}

function fixtureMp4(): Uint8Array {
  const ftyp = box('ftyp', concat([ascii('isom'), u32(0)]));
  const mvhd = box('mvhd', concat([Uint8Array.of(0, 0, 0, 0), u32(0), u32(0), u32(1000), u32(1000)]));
  return concat([ftyp, box('moov', mvhd)]);
}

function requireString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
}

function requireInteger(value: unknown, code: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(code);
  return n;
}

function safeCode(error: unknown): string {
  if (error instanceof ProviderReadExecutionError) return error.code;
  if (error instanceof Error && /^[a-z0-9][a-z0-9-]{0,95}$/.test(error.message)) return error.message;
  return 'h10-r2-smoke-failed';
}

async function resultOf(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid-runtime-response');
  const record = body as Record<string, unknown>;
  if (!response.ok) {
    const error = record.error;
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const e = error as Record<string, unknown>;
      const diagnostic = e.diagnostic;
      if (diagnostic && typeof diagnostic === 'object' && !Array.isArray(diagnostic)) {
        const code = (diagnostic as Record<string, unknown>).code;
        if (typeof code === 'string') throw new Error(code);
      }
      if (typeof e.code === 'string') throw new Error(e.code);
    }
    throw new Error('runtime-request-failed');
  }
  const result = record.result;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid-runtime-result');
  return result as Record<string, unknown>;
}

function authHeaders(token: string, correlation: string, key: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'x-zs-contract-version': '1.0',
    'x-zs-caller-app': 'video-maker_app',
    'x-app-correlation-reference': correlation,
    'idempotency-key': key,
  };
}

async function createIntent(runtime: HttpStorageRuntime, token: string, correlation: string, key: string, bytes: Uint8Array, checksum: string) {
  return resultOf(await runtime.handle(new Request('https://h10.internal/v1/object-write-intents', {
    method: 'POST',
    headers: { ...authHeaders(token, correlation, key), 'content-type': 'application/json' },
    body: JSON.stringify({
      storageProfile: { profileId: 'video-maker-dev-default', profileVersion: 1, environment: 'dev' },
      mediaType: 'video/mp4',
      byteLength: bytes.byteLength,
      checksumSha256: checksum,
      sourceReference: `h10-r2-only-${correlation}`,
    }),
  })));
}

async function upload(runtime: HttpStorageRuntime, token: string, correlation: string, key: string, intentId: string, completionToken: string, bytes: Uint8Array, checksum: string) {
  return resultOf(await runtime.handle(new Request(`https://h10.internal/v1/object-write-intents/${intentId}/content`, {
    method: 'PUT',
    headers: {
      ...authHeaders(token, correlation, key),
      'x-zs-upload-completion-token': completionToken,
      'x-content-sha256': checksum,
      'content-type': 'video/mp4',
      'content-length': String(bytes.byteLength),
    },
    body: Uint8Array.from(bytes).buffer,
  })));
}

async function fullHash(reader: S3CompatibleProviderObjectReader, target: Readonly<ResolvedProviderReadTarget>) {
  const read = await reader.get({ target });
  try {
    const hash = createHash('sha256');
    let length = 0;
    for await (const chunk of read.body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      length += bytes.byteLength;
    }
    return { checksum: hash.digest('hex'), length };
  } finally {
    read.close();
  }
}

async function cleanupRows(pool: Pool, objectId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM public.storage_reconciliation_issues WHERE storage_object_id = $1', [objectId]);
    await client.query('DELETE FROM public.storage_operation_events WHERE storage_object_id = $1', [objectId]);
    await client.query('DELETE FROM public.storage_provider_attempts WHERE storage_object_id = $1', [objectId]);
    await client.query('DELETE FROM public.storage_idempotency_records WHERE result_storage_object_id = $1', [objectId]);
    await client.query('DELETE FROM public.object_write_intents WHERE storage_object_id = $1', [objectId]);
    await client.query('DELETE FROM public.storage_object_copies WHERE storage_object_id = $1', [objectId]);
    await client.query('DELETE FROM public.storage_objects WHERE storage_object_id = $1', [objectId]);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
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
  if (!postgresUrl || !token || !bindings) return json({ error: { code: 'h10-r2-runtime-input-unavailable' } }, 503);

  const pool = new Pool({ connectionString: postgresUrl, max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, application_name: 'z-s-h10-r2-only-smoke' });
  const resolver = createRuntimeProviderCredentialResolver(bindings);
  const reader = new S3CompatibleProviderObjectReader({ credentialResolver: resolver });
  const writer = new S3CompatibleProviderObjectWriter({ credentialResolver: resolver });
  const correlation = `h10-r2-${randomUUID()}`;
  const bytes = fixtureMp4();
  const checksum = createHash('sha256').update(bytes).digest('hex');
  let objectId: string | undefined;
  let writeTarget: Readonly<ResolvedProviderWriteTarget> | undefined;
  let providerDeleted = false;
  let databaseCleaned = false;

  try {
    const intentKey = `h10-r2-intent-${randomUUID()}`;
    const first = await createIntent(input.runtime, token, correlation, intentKey, bytes, checksum);
    const replay = await createIntent(input.runtime, token, correlation, intentKey, bytes, checksum);
    const intentId = requireString(first.writeIntentId, 'invalid-write-intent-id');
    objectId = requireString(first.storageObjectId, 'invalid-storage-object-id');
    const completionToken = requireString(first.uploadCompletionToken, 'invalid-upload-completion-token');
    if (replay.writeIntentId !== intentId || replay.storageObjectId !== objectId) throw new Error('idempotent-replay-mismatch');

    const uploadResult = await upload(input.runtime, token, correlation, `h10-r2-upload-${randomUUID()}`, intentId, completionToken, bytes, checksum);
    const primary = (await pool.query<PrimaryRow>(
      `SELECT object_record.registry_state, object_record.object_protection_stage,
              copy.copy_state, copy.observed_checksum_sha256, copy.observed_byte_length,
              copy.latest_verified_at, copy.internal_locator,
              connection.connection_id, connection.provider_type, connection.secret_reference_id,
              vault.bucket_label, vault.prefix_template, vault.retention_mode, vault.delete_after_days
         FROM public.storage_objects AS object_record
         JOIN public.storage_object_copies AS copy
           ON copy.storage_object_id = object_record.storage_object_id
          AND copy.target_role = 'primary' AND copy.target_order = 0
         JOIN public.storage_control_provider_connections AS connection ON connection.id = copy.provider_connection_id
         JOIN public.storage_control_configuration_vaults AS vault ON vault.id = copy.configuration_vault_id
        WHERE object_record.storage_object_id = $1`,
      [objectId],
    )).rows[0];
    if (!primary) throw new Error('r2-primary-authority-missing');
    if (primary.provider_type !== 'r2') throw new Error('r2-primary-not-selected');
    if (primary.copy_state !== 'verified') throw new Error('r2-primary-not-verified');
    if (primary.observed_checksum_sha256 !== checksum || requireInteger(primary.observed_byte_length, 'r2-primary-length-invalid') !== bytes.byteLength) {
      throw new Error('r2-primary-integrity-mismatch');
    }

    const readTarget: Readonly<ResolvedProviderReadTarget> = Object.freeze({
      providerRole: 'primary', providerId: primary.connection_id, bucketLabel: primary.bucket_label,
      internalLocator: primary.internal_locator, credentialSecretReferenceId: primary.secret_reference_id,
    });
    writeTarget = Object.freeze({
      providerRole: 'primary', providerId: primary.connection_id, bucketLabel: primary.bucket_label,
      internalLocator: primary.internal_locator, normalizedPrefixPattern: primary.prefix_template,
      capabilityPolicy: Object.freeze({ checksumVerification: 'required' as const, sizeVerification: 'required-when-supported' as const, headContentLength: 'required' as const, rangeRead: 'optional' as const }),
      credentialSecretReferenceId: primary.secret_reference_id,
    });

    const direct = await fullHash(reader, readTarget);
    if (direct.checksum !== checksum || direct.length !== bytes.byteLength) throw new Error('r2-direct-read-integrity-mismatch');
    if ((await reader.head({ target: readTarget })).byteLength !== bytes.byteLength) throw new Error('r2-head-length-mismatch');

    let safeCredentialFailureCode = '';
    try {
      await reader.head({ target: Object.freeze({ ...readTarget, credentialSecretReferenceId: `h10-missing-${randomUUID()}` }) });
      throw new Error('r2-missing-credential-unexpected-success');
    } catch (error) {
      safeCredentialFailureCode = safeCode(error);
    }
    if ((await reader.head({ target: readTarget })).byteLength !== bytes.byteLength) throw new Error('r2-not-preserved-after-safe-failure');

    const verifiedAt = new Date(primary.latest_verified_at);
    if (!Number.isFinite(verifiedAt.getTime())) throw new Error('r2-verified-at-invalid');
    let retention: Record<string, unknown>;
    if (primary.retention_mode === 'delete-after-days' && primary.delete_after_days !== null) {
      const days = requireInteger(primary.delete_after_days, 'r2-delete-after-days-invalid');
      const eligibleAt = new Date(verifiedAt.getTime() + days * 86_400_000);
      retention = { mode: 'delete-after-days', deleteAfterDays: days, latestVerifiedAt: verifiedAt.toISOString(), eligibleAt: eligibleAt.toISOString(), eligibleNow: Date.now() >= eligibleAt.getTime(), eligibleAtBoundary: true };
    } else if (primary.retention_mode === 'permanent') {
      retention = { mode: 'permanent', eligibleNow: false, eligibleAtBoundary: false };
    } else {
      throw new Error('r2-retention-policy-invalid');
    }

    const deleted = await writer.cleanup({ target: writeTarget });
    if (!deleted.deleted) throw new Error(deleted.diagnostic?.code ?? 'r2-delete-failed');
    providerDeleted = true;
    let absenceCode = '';
    try {
      await reader.head({ target: readTarget });
      throw new Error('r2-delete-absence-failed');
    } catch (error) {
      absenceCode = safeCode(error);
      if (absenceCode !== 'provider-read-missing') throw error;
    }

    await cleanupRows(pool, objectId);
    databaseCleaned = true;
    return json({ result: {
      scope: 'h10-r2-only', minio: 'skipped-by-user', runtimeRevision: input.environment.VERCEL_GIT_COMMIT_SHA ?? null,
      governedUpload: true, idempotentIntentReplay: true, providerType: 'r2', primaryCopyState: primary.copy_state,
      registryStateAfterUpload: primary.registry_state, objectProtectionStageAfterUpload: primary.object_protection_stage,
      uploadStorageState: typeof uploadResult.storageState === 'string' ? uploadResult.storageState : null,
      directReadChecksumVerified: true, directReadByteLengthVerified: true,
      safeCredentialFailureCode, objectPreservedAfterCredentialFailure: true,
      retention, retentionWorkerInvoked: false, retentionWorkerReason: 'minio-protection-explicitly-skipped',
      exactR2DeleteVerified: true, postDeleteAbsenceCode: absenceCode,
      cleanup: { providerDeleted, databaseCleaned },
    } });
  } catch (error) {
    return json({ error: { code: safeCode(error), scope: 'h10-r2-only', minio: 'skipped-by-user', cleanup: { providerDeleted, databaseCleaned } } }, 500);
  } finally {
    if (writeTarget && !providerDeleted) {
      try { providerDeleted = (await writer.cleanup({ target: writeTarget })).deleted; } catch {}
    }
    if (objectId && !databaseCleaned) {
      try { await cleanupRows(pool, objectId); databaseCleaned = true; } catch {}
    }
    await pool.end();
  }
}
