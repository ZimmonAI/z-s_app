import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import {
  ImageDerivativeApplicationService,
  ImageDerivativeError,
  type ImageDerivativeJob,
  type ImageDerivativeStore,
} from '../src/image-derivative.js';
import { PngImageDerivativeProcessor } from '../src/image-derivative-png.js';

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

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const value of input) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

function rgbaPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const offset = y * (1 + width * 4);
    scanlines[offset] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = offset + 1 + x * 4;
      scanlines[pixel] = x * 20;
      scanlines[pixel + 1] = y * 20;
      scanlines[pixel + 2] = 120;
      scanlines[pixel + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('bounded PNG processor verifies, resizes, and returns a separate encoded object', async () => {
  const sourceBytes = rgbaPng(4, 2);
  const source = {
    mediaType: 'image/png',
    byteLength: sourceBytes.length,
    checksumSha256: createHash('sha256').update(sourceBytes).digest('hex'),
    body: Readable.from(sourceBytes),
    close() {},
  };
  const result = await new PngImageDerivativeProcessor().process(JOB, source);
  assert.equal(result.width, 16);
  assert.equal(result.height, 8);
  assert.equal(result.mediaType, 'image/png');
  assert.equal(result.body[0], 137);
  assert.equal(createHash('sha256').update(result.body).digest('hex'), result.checksumSha256);
});

test('processor rejects unsupported configured output formats without producing a partial result', async () => {
  const sourceBytes = rgbaPng(2, 2);
  await assert.rejects(
    new PngImageDerivativeProcessor().process(
      { ...JOB, outputFormat: 'webp' },
      {
        mediaType: 'image/png',
        byteLength: sourceBytes.length,
        checksumSha256: createHash('sha256').update(sourceBytes).digest('hex'),
        body: Readable.from(sourceBytes),
        close() {},
      },
    ),
    (error: unknown) => error instanceof ImageDerivativeError &&
      error.code === 'image-derivative-output-format-unsupported',
  );
});

test('application service completes only after verified output persistence', async () => {
  const calls: string[] = [];
  const body = Buffer.from('bounded-output');
  const checksum = createHash('sha256').update(body).digest('hex');
  const store: ImageDerivativeStore = {
    configured: true,
    async enqueueVerifiedSource() { return 0; },
    async listStatus() { return []; },
    async claimNext() { calls.push('claim'); return JOB; },
    async complete(_job, output) {
      calls.push(`complete:${output.storageObjectId}`);
      assert.equal(output.checksumSha256, checksum);
    },
    async fail() { calls.push('fail'); },
  };
  const service = new ImageDerivativeApplicationService({
    store,
    sourceReader: {
      async read() {
        calls.push('read');
        return {
          mediaType: 'image/png',
          byteLength: 4,
          checksumSha256: 'b'.repeat(64),
          body: Readable.from('test'),
          close() { calls.push('close'); },
        };
      },
    },
    processor: {
      async process() {
        calls.push('process');
        return {
          mediaType: 'image/png',
          width: 16,
          height: 8,
          byteLength: body.length,
          checksumSha256: checksum,
          body,
        };
      },
    },
    outputWriter: {
      async write() {
        calls.push('write');
        return {
          storageObjectId: '00000000-0000-4000-8000-000000000009',
          byteLength: body.length,
          checksumSha256: checksum,
        };
      },
      async cleanup() { calls.push('cleanup'); },
    },
  });
  assert.equal(await service.processNext('worker-1'), 'processed');
  assert.deepEqual(calls, [
    'claim', 'read', 'process', 'write',
    'complete:00000000-0000-4000-8000-000000000009', 'close',
  ]);
});
