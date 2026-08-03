import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import {
  BoundedPngImageDerivativeProcessor,
  ImageDerivativeError,
  ImageDerivativeWorker,
  type ImageDerivativeJobSnapshot,
  type ImageDerivativeOutputReservation,
  type ImageDerivativeSourceSnapshot,
  type ImageDerivativeStatusSnapshot,
  type ImageDerivativeStore,
} from '../src/image-derivative.js';
import { createImageDerivativeControlRuntime } from '../src/image-derivative-control.js';
import { createImageDerivativeEnqueueRuntime } from '../src/image-derivative-runtime.js';
import { issueSignedSession } from '../src/control-plane-session.js';
import type { HttpStorageRuntime } from '../src/runtime-contract.js';
import type { ProviderObjectReader } from '../src/runtime-read-delivery.js';
import type { ProviderObjectWriter } from '../src/runtime-s3-provider.js';

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([...type].map((value) => value.charCodeAt(0)));
  return concat([uint32(data.byteLength), typeBytes, data, uint32(crc32(concat([typeBytes, data])))]);
}

function png(width: number, height: number): Uint8Array {
  const header = new Uint8Array(13);
  header.set(uint32(width), 0);
  header.set(uint32(height), 4);
  header[8] = 8;
  header[9] = 6;
  const rows = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    rows[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      rows[offset] = x % 2 === 0 ? 255 : 0;
      rows[offset + 1] = y % 2 === 0 ? 128 : 32;
      rows[offset + 2] = 64;
      rows[offset + 3] = 255;
    }
  }
  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', new Uint8Array()),
  ]);
}

function pngDimensions(bytes: Uint8Array): readonly [number, number] {
  return [
    ((bytes[16] ?? 0) * 0x1000000) + ((bytes[17] ?? 0) << 16) + ((bytes[18] ?? 0) << 8) + (bytes[19] ?? 0),
    ((bytes[20] ?? 0) * 0x1000000) + ((bytes[21] ?? 0) << 16) + ((bytes[22] ?? 0) << 8) + (bytes[23] ?? 0),
  ];
}

test('bounded PNG processor validates and deterministically resizes an image', () => {
  const processor = new BoundedPngImageDerivativeProcessor();
  const first = processor.process({
    bytes: png(4, 2),
    declaredContentType: 'image/png',
    width: 16,
    outputFormat: 'png',
    quality: 80,
    fit: 'inside',
  });
  const second = processor.process({
    bytes: png(4, 2),
    declaredContentType: 'image/png',
    width: 16,
    outputFormat: 'png',
    quality: 80,
    fit: 'inside',
  });
  assert.deepEqual(pngDimensions(first.bytes), [16, 8]);
  assert.equal(first.contentType, 'image/png');
  assert.equal(createHash('sha256').update(first.bytes).digest('hex'),
    createHash('sha256').update(second.bytes).digest('hex'));
});

test('bounded PNG processor rejects malformed, MIME-mismatched, and unsupported output', () => {
  const processor = new BoundedPngImageDerivativeProcessor();
  const malformed = png(4, 2).slice();
  malformed[malformed.byteLength - 1] ^= 1;
  assert.throws(() => processor.process({
    bytes: malformed,
    declaredContentType: 'image/png',
    width: 16,
    outputFormat: 'png',
    quality: 80,
    fit: 'inside',
  }), (error: unknown) => error instanceof ImageDerivativeError && error.code === 'image-png-crc-mismatch');
  assert.throws(() => processor.process({
    bytes: png(4, 2),
    declaredContentType: 'image/jpeg',
    width: 16,
    outputFormat: 'png',
    quality: 80,
    fit: 'inside',
  }), /image-input-mime-unsupported/);
  assert.throws(() => processor.process({
    bytes: png(4, 2),
    declaredContentType: 'image/png',
    width: 16,
    outputFormat: 'webp',
    quality: 80,
    fit: 'inside',
  }), /image-output-format-unsupported/);
});

function job(): ImageDerivativeJobSnapshot {
  return Object.freeze({
    jobId: '00000000-0000-4000-8000-000000000001',
    sourceStorageObjectId: '00000000-0000-4000-8000-000000000002',
    presetId: 'thumb',
    width: 16,
    outputFormat: 'png',
    state: 'processing',
    attemptCount: 1,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:01.000Z',
    storageControlClientId: '00000000-0000-4000-8000-000000000003',
    environment: 'dev',
    configurationVersionId: '00000000-0000-4000-8000-000000000004',
    configurationFingerprint: 'a'.repeat(64),
    configurationRouteId: '00000000-0000-4000-8000-000000000005',
    imagePresetId: '00000000-0000-4000-8000-000000000006',
    targetVaultId: '00000000-0000-4000-8000-000000000007',
    quality: 80,
    fit: 'inside',
    leaseToken: 'b'.repeat(64),
    leaseExpiresAt: '2026-08-03T00:02:00.000Z',
  });
}

test('worker reads verified source, writes one output, and completes lineage', async () => {
  const sourceBytes = png(4, 2);
  const claimed = job();
  const completed: ImageDerivativeStatusSnapshot = Object.freeze({
    ...claimed,
    outputStorageObjectId: '00000000-0000-4000-8000-000000000008',
    state: 'succeeded',
    finishedAt: '2026-08-03T00:00:02.000Z',
  });
  let completedInput: unknown;
  const reservation: ImageDerivativeOutputReservation = Object.freeze({
    storageObjectId: '00000000-0000-4000-8000-000000000008',
    storageObjectCopyId: '00000000-0000-4000-8000-000000000009',
    target: Object.freeze({
      providerRole: 'primary',
      providerId: 'provider',
      bucketLabel: 'bucket',
      internalLocator: 'derivatives/output',
      normalizedPrefixPattern: 'derivatives/*',
      capabilityPolicy: Object.freeze({
        checksumVerification: 'required',
        sizeVerification: 'required-when-supported',
        headContentLength: 'required',
        rangeRead: 'optional',
      }),
      credentialSecretReferenceId: 'provider-reference',
    }),
    reusedPendingReservation: false,
    alreadyVerified: false,
  });
  const store = {
    configured: true,
    enqueueVerifiedSource: async () => 0,
    listStatus: async () => [],
    claimNext: async () => claimed,
    readSource: async (): Promise<ImageDerivativeSourceSnapshot> => Object.freeze({
      storageObjectId: claimed.sourceStorageObjectId,
      checksumSha256: createHash('sha256').update(sourceBytes).digest('hex'),
      byteLength: sourceBytes.byteLength,
      contentType: 'image/png',
      copies: Object.freeze([Object.freeze({
        storageObjectCopyId: 'source-copy',
        target: Object.freeze({
          providerRole: 'primary',
          providerId: 'provider',
          bucketLabel: 'bucket',
          internalLocator: 'source/input',
          credentialSecretReferenceId: 'provider-reference',
        }),
      })]),
    }),
    reserveOutput: async () => reservation,
    completeOutput: async (input: unknown) => {
      completedInput = input;
      return completed;
    },
    failJob: async () => { throw new Error('unexpected-failure'); },
  } satisfies ImageDerivativeStore;
  const reader = {
    get: async () => Object.freeze({
      byteLength: sourceBytes.byteLength,
      body: Readable.from(sourceBytes),
      close() {},
    }),
  } as unknown as ProviderObjectReader;
  const writer = {
    cleanup: async () => Object.freeze({ deleted: true }),
    write: async (input: { checksumSha256: string; byteLength: number }) => Object.freeze({
      providerRole: 'primary' as const,
      observed: Object.freeze({ checksumSha256: input.checksumSha256, byteLength: input.byteLength }),
      integrityVerification: Object.freeze({
        verified: true,
        checksumVerified: true,
        sizeVerified: true,
        sizeVerificationDisposition: 'matched' as const,
      }),
    }),
  } as unknown as ProviderObjectWriter;
  const result = await new ImageDerivativeWorker({ store, providerReader: reader, providerWriter: writer })
    .runOnce('worker-1');
  assert.equal(result?.state, 'succeeded');
  assert.ok(completedInput !== undefined);
});

test('upload completion enqueue is duplicate-safe and never changes the completed response', async () => {
  let enqueued: string | undefined;
  const store = {
    configured: true,
    enqueueVerifiedSource: async (storageObjectId: string) => { enqueued = storageObjectId; return 1; },
  } as unknown as ImageDerivativeStore;
  const base: HttpStorageRuntime = {
    handle: async () => new Response(JSON.stringify({ result: {
      state: 'recorded', storageObjectId: '00000000-0000-4000-8000-000000000010',
    } }), { status: 200, headers: { 'content-type': 'application/json' } }),
    health: () => ({ status: 'ok' }),
    readiness: () => ({ status: 'ready' }),
  };
  const response = await createImageDerivativeEnqueueRuntime(base, store).handle(new Request(
    'https://example.test/v1/object-write-intents/00000000-0000-4000-8000-000000000011/content',
    { method: 'PUT', body: 'payload' },
  ));
  assert.equal(response.status, 200);
  assert.equal(enqueued, '00000000-0000-4000-8000-000000000010');
});

test('status API requires a browser client session and workspace injection exposes safe fields only', async () => {
  const signingKey = 'test-session-signing-key-material';
  const now = new Date('2026-08-03T00:00:00.000Z');
  const token = issueSignedSession({
    cookieName: 'zs_client_session',
    subject: 'z-s-client:video-maker_app',
    ttlSeconds: 3600,
    signingKey,
  }, now);
  const rows: readonly ImageDerivativeStatusSnapshot[] = [Object.freeze({
    jobId: '00000000-0000-4000-8000-000000000012',
    sourceStorageObjectId: '00000000-0000-4000-8000-000000000013',
    outputStorageObjectId: '00000000-0000-4000-8000-000000000014',
    presetId: 'thumb',
    width: 320,
    outputFormat: 'png',
    state: 'succeeded',
    attemptCount: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    finishedAt: now.toISOString(),
  })];
  const store = {
    configured: true,
    listStatus: async () => rows,
  } as unknown as ImageDerivativeStore;
  const base: HttpStorageRuntime = {
    handle: async () => new Response(
      '<main><section class="panel stack" aria-labelledby="activity-title">activity</section></main>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    ),
    health: () => ({ status: 'ok' }),
    readiness: () => ({ status: 'ready' }),
  };
  const runtime = createImageDerivativeControlRuntime(base, {
    store,
    sessionSigningKey: signingKey,
    now: () => now,
  });
  const unauthorized = await runtime.handle(new Request(
    'https://example.test/client/storage/image-derivatives?environment=dev',
    { headers: { authorization: 'Bearer integration-token' } },
  ));
  assert.equal(unauthorized.status, 401);
  const headers = { cookie: `zs_client_session=${token}` };
  const api = await runtime.handle(new Request(
    'https://example.test/client/storage/image-derivatives?environment=dev',
    { headers },
  ));
  assert.equal(api.status, 200);
  const payload = await api.text();
  assert.match(payload, /"presetId":"thumb"/);
  assert.doesNotMatch(payload, /bucket|locator|checksum|secret|token/i);
  const workspace = await runtime.handle(new Request(
    'https://example.test/client/storage/configuration?environment=dev',
    { headers },
  ));
  const html = await workspace.text();
  assert.match(html, /Image derivative status/);
  assert.match(html, /thumb/);
  assert.doesNotMatch(html, /sourceStorageObjectId|outputStorageObjectId/);
});
