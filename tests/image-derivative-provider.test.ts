import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type {
  ImageDerivativeJob,
  ProcessedImageDerivative,
} from '../src/image-derivative.js';
import { ConfiguredImageDerivativeOutputWriter } from '../src/image-derivative-provider.js';
import type { PostgresImageDerivativeStore } from '../src/image-derivative-postgres.js';
import type {
  ProviderObjectWriter,
  ResolvedProviderWriteTarget,
} from '../src/runtime-s3-provider.js';

const JOB: Readonly<ImageDerivativeJob> = Object.freeze({
  id: '00000000-0000-4000-8000-000000000001',
  sourceStorageObjectId: '00000000-0000-4000-8000-000000000002',
  storageControlClientId: '00000000-0000-4000-8000-000000000003',
  environment: 'dev',
  configurationVersionId: '00000000-0000-4000-8000-000000000004',
  configurationFingerprint: 'a'.repeat(64),
  configurationRouteId: '00000000-0000-4000-8000-000000000005',
  configurationImagePresetId: '00000000-0000-4000-8000-000000000006',
  presetId: 'png-preview',
  targetConfigurationVaultId: '00000000-0000-4000-8000-000000000007',
  requestedWidth: 16,
  outputFormat: 'png',
  quality: 80,
  fit: 'inside',
  state: 'processing',
  attemptCount: 1,
  maximumAttempts: 3,
  leaseToken: '00000000-0000-4000-8000-000000000008',
});

test('configured derivative writer preserves the output as one byte chunk', async () => {
  const body = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const checksumSha256 = createHash('sha256').update(body).digest('hex');
  const output: Readonly<ProcessedImageDerivative> = Object.freeze({
    mediaType: 'image/png',
    width: 16,
    height: 8,
    byteLength: body.byteLength,
    checksumSha256,
    body,
  });
  const target = {} as ResolvedProviderWriteTarget;
  const store = {
    async reserveOutput() {
      return {
        storageObjectId: '00000000-0000-4000-8000-000000000009',
        storageObjectCopyId: '00000000-0000-4000-8000-000000000010',
        target,
      };
    },
    async markOutputVerified() {},
    async outputReservation() { return null; },
    async markOutputFailed() {},
  } as unknown as PostgresImageDerivativeStore;
  const observedChunks: Buffer[] = [];
  const providerWriter: ProviderObjectWriter = {
    async write(input) {
      for await (const chunk of input.source) {
        assert.ok(chunk instanceof Uint8Array, 'provider source must emit byte chunks');
        observedChunks.push(Buffer.from(chunk));
      }
      return {
        providerRole: 'primary',
        observed: {
          checksumSha256: input.checksumSha256,
          byteLength: input.byteLength,
        },
        integrityVerification: {
          verified: true,
          checksumVerified: true,
          sizeVerified: true,
          sizeVerificationDisposition: 'matched',
        },
      };
    },
    async cleanup() {
      return { deleted: true };
    },
  };

  const writer = new ConfiguredImageDerivativeOutputWriter({
    store,
    writer: providerWriter,
  });
  const verified = await writer.write(JOB, output);

  assert.equal(observedChunks.length, 1);
  assert.deepEqual(observedChunks[0], body);
  assert.equal(verified.byteLength, body.byteLength);
  assert.equal(verified.checksumSha256, checksumSha256);
});
