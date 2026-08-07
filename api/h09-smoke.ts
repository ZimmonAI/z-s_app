import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createClientControlComposition } from '../src/client-control-composition.js';
import { createVideoMakerControlRuntimeComposition } from '../src/runtime-control-composition.js';
import {
  ProviderReadExecutionError,
  S3CompatibleProviderObjectReader,
  type ResolvedProviderReadTarget,
} from '../src/runtime-read-delivery.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9h4mZisAAAAASUVORK5CYII=',
  'base64',
);
const CHECKSUM = createHash('sha256').update(PNG).digest('hex');

interface CopyRow {
  target_role: 'primary' | 'replica';
  copy_state: string;
  observed_checksum_sha256: string | null;
  observed_byte_length: string | number | null;
  connection_id: string;
  bucket_label: string;
  internal_locator: string;
  secret_reference_id: string;
  registry_state: string;
  object_protection_stage: string;
}

function json(res: any, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function responseBody(response: Response): Promise<any> {
  return response.json().catch(() => null);
}

async function hashProviderObject(
  reader: S3CompatibleProviderObjectReader,
  target: Readonly<ResolvedProviderReadTarget>,
): Promise<{ readable: boolean; checksumSha256: string | null; byteLength: number | null }> {
  const opened = await reader.get({ target });
  try {
    const hash = createHash('sha256');
    let byteLength = 0;
    for await (const chunk of opened.body) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(Buffer.from(chunk as string));
      byteLength += bytes.byteLength;
      hash.update(bytes);
    }
    return { readable: true, checksumSha256: hash.digest('hex'), byteLength };
  } finally {
    opened.close();
  }
}

export default async function handler(req: any, res: any): Promise<void> {
  const requestUrl = new URL(req.url ?? '/', 'https://preview.invalid');
  if (
    process.env.VERCEL_ENV !== 'preview' ||
    req.method !== 'GET' ||
    requestUrl.searchParams.get('execute') !== 'h09'
  ) {
    json(res, 404, { error: { code: 'not-found' } });
    return;
  }

  const bearer = process.env.Z_S_VIDEO_MAKER_BEARER_TOKEN?.trim();
  const postgresUrl = process.env.Z_S_POSTGRES_URL?.trim();
  if (!bearer || !postgresUrl) {
    json(res, 503, { error: { code: 'h09-preview-prerequisite-unavailable' } });
    return;
  }

  const runtimeComposition = createVideoMakerControlRuntimeComposition(process.env);
  const clientControl = createClientControlComposition(process.env);
  const pool = new Pool({ connectionString: postgresUrl, max: 1, application_name: 'z-s-h09-preview-proof' });
  const reader = new S3CompatibleProviderObjectReader({
    credentialResolver: clientControl.credentialResolver,
  });
  const correlation = `h09-live-${randomUUID().slice(0, 12)}`;
  let storageObjectId: string | null = null;

  try {
    const readiness = await runtimeComposition.runtime.readiness();
    if (readiness.status !== 'ready') {
      json(res, 503, { error: { code: 'h09-runtime-not-ready' }, readiness: { status: readiness.status } });
      return;
    }

    const intentResponse = await runtimeComposition.runtime.handle(new Request(
      'https://preview.invalid/v1/object-write-intents',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          'x-zs-contract-version': '1.0',
          'x-zs-caller-app': 'video-maker_app',
          'idempotency-key': `${correlation}-intent`,
          'x-app-correlation-reference': correlation,
        },
        body: JSON.stringify({
          storageProfile: {
            profileId: 'video-maker-dev-default',
            profileVersion: 1,
            environment: 'dev',
          },
          mediaType: 'image/png',
          byteLength: PNG.byteLength,
          checksumSha256: CHECKSUM,
          sourceReference: correlation,
        }),
      },
    ));
    const intentBody = await responseBody(intentResponse);
    const writeIntentId = intentBody?.result?.writeIntentId;
    storageObjectId = intentBody?.result?.storageObjectId ?? null;
    const uploadCompletionToken = intentBody?.result?.uploadCompletionToken;
    if (
      intentResponse.status !== 200 ||
      typeof writeIntentId !== 'string' ||
      typeof storageObjectId !== 'string' ||
      typeof uploadCompletionToken !== 'string'
    ) {
      json(res, 502, {
        error: { code: intentBody?.error?.code ?? 'h09-write-intent-failed' },
        proof: { writeIntentStatus: intentResponse.status },
      });
      return;
    }

    const uploadResponse = await runtimeComposition.runtime.handle(new Request(
      `https://preview.invalid/v1/object-write-intents/${encodeURIComponent(writeIntentId)}/content`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'image/png',
          'content-length': String(PNG.byteLength),
          'x-content-sha256': CHECKSUM,
          'x-zs-contract-version': '1.0',
          'x-zs-caller-app': 'video-maker_app',
          'x-zs-upload-completion-token': uploadCompletionToken,
          'idempotency-key': `${correlation}-upload`,
          'x-app-correlation-reference': correlation,
        },
        body: PNG,
      },
    ));
    const uploadBody = await responseBody(uploadResponse);
    const uploadResult = uploadBody?.result;

    const copies = await pool.query<CopyRow>(
      `SELECT
         copy.target_role,
         copy.copy_state,
         copy.observed_checksum_sha256,
         copy.observed_byte_length,
         connection.connection_id,
         vault.bucket_label,
         copy.internal_locator,
         connection.secret_reference_id,
         object_record.registry_state,
         object_record.object_protection_stage
       FROM public.storage_object_copies AS copy
       JOIN public.storage_objects AS object_record
         ON object_record.storage_object_id = copy.storage_object_id
       JOIN public.storage_control_configuration_vaults AS vault
         ON vault.id = copy.configuration_vault_id
       JOIN public.storage_control_provider_connections AS connection
         ON connection.id = copy.provider_connection_id
      WHERE copy.storage_object_id = $1
        AND copy.configuration_route_target_id IS NOT NULL
      ORDER BY copy.target_order`,
      [storageObjectId],
    );
    const primary = copies.rows.find((copy) => copy.target_role === 'primary');
    const replicas = copies.rows.filter((copy) => copy.target_role === 'replica');
    if (primary === undefined || replicas.length === 0) {
      json(res, 502, { error: { code: 'h09-copy-authority-missing' } });
      return;
    }

    const primaryTarget: Readonly<ResolvedProviderReadTarget> = Object.freeze({
      providerRole: 'primary',
      providerId: primary.connection_id,
      bucketLabel: primary.bucket_label,
      internalLocator: primary.internal_locator,
      credentialSecretReferenceId: primary.secret_reference_id,
    });
    const primaryRead = await hashProviderObject(reader, primaryTarget);

    let minioReachable = false;
    let minioDiagnosticCode: string | null = null;
    try {
      const replica = replicas[0]!;
      await reader.head({
        target: Object.freeze({
          providerRole: 'replica',
          providerId: replica.connection_id,
          bucketLabel: replica.bucket_label,
          internalLocator: replica.internal_locator,
          credentialSecretReferenceId: replica.secret_reference_id,
        }),
      });
      minioReachable = true;
    } catch (error) {
      minioDiagnosticCode = error instanceof ProviderReadExecutionError
        ? error.code
        : 'provider-read-failed';
    }

    const targetCopies = Array.isArray(uploadResult?.targetCopies)
      ? uploadResult.targetCopies.map((copy: any) => ({
          role: copy?.role ?? null,
          order: copy?.order ?? null,
          state: copy?.state ?? null,
          retryable: copy?.retryable ?? null,
        }))
      : [];
    const primarySafe = targetCopies.find((copy: any) => copy.role === 'primary');
    const replicaSafe = targetCopies.filter((copy: any) => copy.role === 'replica');
    const passed =
      uploadResponse.status === 200 &&
      uploadResult?.state === 'recorded' &&
      uploadResult?.storageState === 'degraded' &&
      uploadResult?.objectProtectionStage === 'configuration-replica-repair-required' &&
      primarySafe?.state === 'verified' &&
      replicaSafe.length > 0 &&
      replicaSafe.every((copy: any) => copy.state !== 'verified') &&
      primary.copy_state === 'verified' &&
      primary.observed_checksum_sha256 === CHECKSUM &&
      Number(primary.observed_byte_length) === PNG.byteLength &&
      replicas.every((copy) => copy.copy_state !== 'verified') &&
      primaryRead.readable &&
      primaryRead.checksumSha256 === CHECKSUM &&
      primaryRead.byteLength === PNG.byteLength &&
      !minioReachable;

    json(res, passed ? 200 : 409, {
      proof: {
        passed,
        readiness: readiness.status,
        writeIntentStatus: intentResponse.status,
        uploadStatus: uploadResponse.status,
        uploadState: uploadResult?.state ?? null,
        storageState: uploadResult?.storageState ?? primary.registry_state,
        objectProtectionStage: uploadResult?.objectProtectionStage ?? primary.object_protection_stage,
        targetCopies,
        primaryAuthority: {
          copyState: primary.copy_state,
          checksumMatch: primary.observed_checksum_sha256 === CHECKSUM,
          byteLengthMatch: Number(primary.observed_byte_length) === PNG.byteLength,
        },
        r2Read: {
          readable: primaryRead.readable,
          checksumMatch: primaryRead.checksumSha256 === CHECKSUM,
          byteLengthMatch: primaryRead.byteLength === PNG.byteLength,
        },
        replicaAuthority: replicas.map((copy) => ({ state: copy.copy_state })),
        minioReachable,
        minioDiagnosticCode,
      },
    });
  } catch (error) {
    json(res, 502, {
      error: {
        code: error instanceof ProviderReadExecutionError
          ? error.code
          : 'h09-preview-proof-failed',
      },
      proof: { storageObjectCreated: storageObjectId !== null },
    });
  } finally {
    await Promise.allSettled([
      runtimeComposition.close(),
      clientControl.close(),
      pool.end(),
    ]);
  }
}
