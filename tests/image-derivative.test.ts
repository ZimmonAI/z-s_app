import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import {
  ImageDerivativeApplicationService,
  ImageDerivativeError,
  type ImageDerivativeFailureInput,
  type ImageDerivativeJob,
  type ImageDerivativeStore,
  type ProcessedImageDerivative,
} from '../src/image-derivative.js';
import {
  PngImageDerivativeProcessor,
  type PngImageDerivativeProcessorOptions,
} from '../src/image-derivative-png-recovery.js';
import { ConfiguredImageDerivativeOutputWriter } from '../src/image-derivative-provider.js';
import type { PostgresImageDerivativeStore } from '../src/image-derivative-postgres-recovery.js';
import { BoundedImageDerivativeWorker } from '../src/image-derivative-worker.js';
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
  leaseToken: ['00000000-0000-4000', '8000-000000000008'].join('-'),
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

function controlledTimer(): Readonly<{
  timer: NonNullable<PngImageDerivativeProcessorOptions['timer']>;
  fire(): void;
  readonly cleared: number;
}> {
  let callback: (() => void) | undefined;
  let cleared = 0;
  const handle = Object.freeze({ unref() {} }) as unknown as ReturnType<typeof setTimeout>;
  return {
    timer: Object.freeze({
      setTimeout: ((next: () => void) => {
        callback = next;
        return handle;
      }) as typeof setTimeout,
      clearTimeout: (() => { cleared += 1; }) as typeof clearTimeout,
    }),
    fire() {
      assert.ok(callback, 'source deadline callback must be registered');
      callback();
    },
    get cleared() { return cleared; },
  };
}

function sourceFrom(body: Readable, bytes: Buffer): Readonly<{
  mediaType: 'image/png';
  byteLength: number;
  checksumSha256: string;
  body: Readable;
  close(): void;
}> {
  return Object.freeze({
    mediaType: 'image/png',
    byteLength: bytes.byteLength,
    checksumSha256: createHash('sha256').update(bytes).digest('hex'),
    body,
    close() {},
  });
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
      for await (const value of input.source) {
        assert.ok(value instanceof Uint8Array, 'provider source must emit byte chunks');
        observedChunks.push(Buffer.from(value));
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

test('source read deadline rejects a stream that emits neither data nor end and releases resources', async () => {
  const sourceBytes = rgbaPng(2, 2);
  const body = new PassThrough();
  const timer = controlledTimer();
  const promise = new PngImageDerivativeProcessor({
    sourceReadDeadlineMs: 10,
    timer: timer.timer,
  }).process(JOB, sourceFrom(body, sourceBytes));

  timer.fire();
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ImageDerivativeError &&
      error.category === 'dependency-unavailable' &&
      error.code === 'image-derivative-source-read-timeout' &&
      error.retryable,
  );
  assert.equal(body.destroyed, true);
  assert.equal(timer.cleared, 1);
  for (const event of ['data', 'error', 'end', 'close', 'aborted']) {
    assert.equal(body.listenerCount(event), 0, `${event} listeners must be cleared`);
  }
});

test('source read deadline rejects complete declared bytes when the provider never emits end', async () => {
  const sourceBytes = rgbaPng(2, 2);
  const body = new PassThrough();
  const timer = controlledTimer();
  const promise = new PngImageDerivativeProcessor({
    sourceReadDeadlineMs: 10,
    timer: timer.timer,
  }).process(JOB, sourceFrom(body, sourceBytes));

  body.write(sourceBytes);
  timer.fire();
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ImageDerivativeError &&
      error.code === 'image-derivative-source-read-timeout',
  );
  assert.equal(body.destroyed, true);
  assert.equal(timer.cleared, 1);
});

test('provider stream errors settle before the deadline and clear the timer', async () => {
  const sourceBytes = rgbaPng(2, 2);
  const body = new PassThrough();
  const timer = controlledTimer();
  const providerFailure = new Error('fixture-provider-stream-failure');
  const promise = new PngImageDerivativeProcessor({
    sourceReadDeadlineMs: 10,
    timer: timer.timer,
  }).process(JOB, sourceFrom(body, sourceBytes));

  body.destroy(providerFailure);
  await assert.rejects(promise, (error: unknown) => error === providerFailure);
  assert.equal(timer.cleared, 1);
});

test('source timeout closes once, records a retryable safe failure, and never invokes the output writer', async () => {
  const sourceBytes = rgbaPng(2, 2);
  const body = new PassThrough();
  const timer = controlledTimer();
  let closeCount = 0;
  let outputWrites = 0;
  let failure: Readonly<ImageDerivativeFailureInput> | undefined;
  const store: ImageDerivativeStore = {
    configured: true,
    async enqueueVerifiedSource() { return 0; },
    async listStatus() { return []; },
    async claimNext() { return JOB; },
    async complete() { throw new Error('completion must not be reached'); },
    async fail(input) { failure = input; },
  };
  const service = new ImageDerivativeApplicationService({
    store,
    sourceReader: {
      async read() {
        return {
          ...sourceFrom(body, sourceBytes),
          close() { closeCount += 1; },
        };
      },
    },
    processor: new PngImageDerivativeProcessor({
      sourceReadDeadlineMs: 10,
      timer: timer.timer,
    }),
    outputWriter: {
      async write() {
        outputWrites += 1;
        throw new Error('output writer must not be reached');
      },
      async cleanup() {},
    },
  });

  const processing = service.processNext('worker-timeout');
  await new Promise<void>((resolve) => setImmediate(resolve));
  timer.fire();
  assert.equal(await processing, 'processed');
  assert.equal(closeCount, 1);
  assert.equal(outputWrites, 0);
  assert.equal(failure?.category, 'dependency-unavailable');
  assert.equal(failure?.code, 'image-derivative-source-read-timeout');
  assert.equal(failure?.retryable, true);
});

test('worker capacity is released after a source timeout so a later queued job can succeed', async () => {
  const sourceBytes = rgbaPng(2, 2);
  const timer = controlledTimer();
  const stalledBody = new PassThrough();
  const jobs = [
    JOB,
    Object.freeze({
      ...JOB,
      id: '00000000-0000-4000-8000-000000000011',
      sourceStorageObjectId: '00000000-0000-4000-8000-000000000012',
      leaseToken: ['00000000-0000-4000', '8000-000000000013'].join('-'),
    }),
  ];
  const completed: string[] = [];
  const failed: string[] = [];
  const store: ImageDerivativeStore = {
    configured: true,
    async enqueueVerifiedSource() { return 0; },
    async listStatus() { return []; },
    async claimNext() { return jobs.shift() ?? null; },
    async complete(job) { completed.push(job.id); },
    async fail(input) { failed.push(input.job.id); },
  };
  const service = new ImageDerivativeApplicationService({
    store,
    sourceReader: {
      async read(job) {
        return sourceFrom(
          job.id === JOB.id ? stalledBody : Readable.from(sourceBytes),
          sourceBytes,
        );
      },
    },
    processor: new PngImageDerivativeProcessor({
      sourceReadDeadlineMs: 10,
      timer: timer.timer,
    }),
    outputWriter: {
      async write(_job, output) {
        return {
          storageObjectId: '00000000-0000-4000-8000-000000000014',
          byteLength: output.byteLength,
          checksumSha256: output.checksumSha256,
        };
      },
      async cleanup() {},
    },
  });
  const worker = new BoundedImageDerivativeWorker(service, 1);

  const firstBatch = worker.runBatch('worker-live');
  await new Promise<void>((resolve) => setImmediate(resolve));
  timer.fire();
  assert.deepEqual(await firstBatch, { processed: 1, idleWorkers: 0 });
  assert.deepEqual(await worker.runBatch('worker-live'), { processed: 1, idleWorkers: 0 });
  assert.deepEqual(failed, [JOB.id]);
  assert.deepEqual(completed, ['00000000-0000-4000-8000-000000000011']);
});
