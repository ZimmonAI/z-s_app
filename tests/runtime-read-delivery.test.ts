import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  ObjectReadDeliveryCoordinator,
  ObjectReadDeliveryError,
  ProviderReadExecutionError,
  parseSingleByteRange,
  type ObjectReadDeliveryRegistry,
  type ObjectReadDeliverySnapshot,
  type ProviderObjectReader,
  type ReadGrantDeliveryAuthorization,
} from '../src/runtime-read-delivery.js';

const OBJECT_ID = '10000000-0000-4000-8000-000000000001';
const HOT_COPY_ID = '10000000-0000-4000-8000-000000000002';
const CANONICAL_COPY_ID = '10000000-0000-4000-8000-000000000003';
const GRANT_ID = '10000000-0000-4000-8000-000000000004';
const CHECKSUM = 'a'.repeat(64);
const CONTENT = new TextEncoder().encode('0123456789');

function copy(
  role: 'hot' | 'canonical',
  overrides: Partial<ObjectReadDeliverySnapshot['copies']['hot']> = {},
): ObjectReadDeliverySnapshot['copies']['hot'] {
  return Object.freeze({
    storageObjectCopyId: role === 'hot' ? HOT_COPY_ID : CANONICAL_COPY_ID,
    providerRole: role,
    state: 'verified',
    observedChecksumSha256: CHECKSUM,
    observedByteLength: CONTENT.byteLength,
    latestVerifiedAt: '2026-07-17T00:00:00.000Z',
    target: Object.freeze({
      providerRole: role,
      providerId: role === 'hot' ? 'r2_video_maker_dev_01' : 'minio_zimspace_local_pc_01',
      bucketLabel: role === 'hot' ? 'video-maker-hot' : 'zs-dev-app-video-maker-canon',
      internalLocator: `video-maker/user-resources/${role}/opaque-object`,
      credentialSecretReferenceId: `secret-${role}`,
    }),
    ...overrides,
  });
}

function snapshot(overrides: Partial<ObjectReadDeliverySnapshot> = {}): ObjectReadDeliverySnapshot {
  return Object.freeze({
    storageObjectId: OBJECT_ID,
    callerAppId: 'video-maker_app',
    registryState: 'active',
    objectProtectionStage: 'canonical-and-hot-verified',
    verifiedChecksumSha256: CHECKSUM,
    verifiedByteLength: CONTENT.byteLength,
    verifiedContentType: 'video/mp4',
    copies: Object.freeze({ hot: copy('hot'), canonical: copy('canonical') }),
    ...overrides,
  });
}

const grant: Readonly<ReadGrantDeliveryAuthorization> = Object.freeze({
  objectReadGrantId: GRANT_ID,
  storageObjectId: OBJECT_ID,
  purpose: 'video-playback',
  allowedMethods: Object.freeze(['HEAD', 'GET'] as const),
  allowRange: true,
  disposition: 'inline',
  fileName: 'clip.mp4',
  expiresAt: '2026-07-17T00:05:00.000Z',
});

function registryHarness(value: ObjectReadDeliverySnapshot = snapshot()) {
  const attempts: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  let attemptSequence = 0;
  const registry: ObjectReadDeliveryRegistry = {
    getObjectReadDeliverySnapshot: async () => value,
    beginObjectReadAttempt: async (input) => {
      attemptSequence += 1;
      attempts.push({ phase: 'begin', ...input });
      return { providerAttemptId: `10000000-0000-4000-8000-0000000001${String(attemptSequence).padStart(2, '0')}` };
    },
    finishObjectReadAttempt: async (input) => {
      attempts.push({ phase: 'finish', ...input });
    },
    appendObjectReadEvent: async (input) => {
      events.push({ ...input });
    },
  };
  return { registry, attempts, events };
}

function readerHarness(input: {
  hot?: 'success' | 'fail';
  canonical?: 'success' | 'fail';
} = {}) {
  const calls: Array<{ role: string; operation: 'head' | 'get'; range?: string }> = [];
  const providerReader: ProviderObjectReader = {
    head: async ({ target }) => {
      calls.push({ role: target.providerRole, operation: 'head' });
      if ((target.providerRole === 'hot' ? input.hot : input.canonical) === 'fail') {
        throw new ProviderReadExecutionError('provider-read-failed');
      }
      return { byteLength: CONTENT.byteLength };
    },
    get: async ({ target, range }) => {
      calls.push({
        role: target.providerRole,
        operation: 'get',
        ...(range === undefined ? {} : { range }),
      });
      if ((target.providerRole === 'hot' ? input.hot : input.canonical) === 'fail') {
        throw new ProviderReadExecutionError('provider-read-failed');
      }
      let bytes = CONTENT;
      if (range !== undefined) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        if (match === null) throw new Error('invalid-test-range');
        bytes = CONTENT.slice(Number(match[1]), Number(match[2]) + 1);
      }
      let closed = false;
      return {
        byteLength: bytes.byteLength,
        body: Readable.from([bytes]),
        close: () => {
          closed = true;
        },
        get closed() {
          return closed;
        },
      };
    },
  };
  return { providerReader, calls };
}

function deliveryInput(overrides: Partial<Parameters<ObjectReadDeliveryCoordinator['deliver']>[0]> = {}) {
  return {
    grant,
    caller: Object.freeze({ appId: 'video-maker_app', serviceId: 'api' }),
    method: 'GET' as const,
    appCorrelationReference: 'resource-01',
    requestId: '10000000-0000-4000-8000-000000000099',
    signal: new AbortController().signal,
    ...overrides,
  };
}

test('single Range parsing supports closed, open-ended and suffix forms', () => {
  assert.deepEqual(parseSingleByteRange('bytes=2-5', 10), {
    start: 2,
    end: 5,
    byteLength: 4,
    providerRange: 'bytes=2-5',
    contentRange: 'bytes 2-5/10',
  });
  assert.deepEqual(parseSingleByteRange('bytes=7-', 10), {
    start: 7,
    end: 9,
    byteLength: 3,
    providerRange: 'bytes=7-9',
    contentRange: 'bytes 7-9/10',
  });
  assert.deepEqual(parseSingleByteRange('bytes=-4', 10), {
    start: 6,
    end: 9,
    byteLength: 4,
    providerRange: 'bytes=6-9',
    contentRange: 'bytes 6-9/10',
  });
});

test('malformed, multiple and unsatisfiable ranges fail with safe 416 metadata', () => {
  for (const value of ['bytes=1-2,4-5', 'items=1-2', 'bytes=-0', 'bytes=20-']) {
    assert.throws(
      () => parseSingleByteRange(value, 10),
      (error: unknown) =>
        error instanceof ObjectReadDeliveryError &&
        error.status === 416 &&
        error.headers?.['content-range'] === 'bytes */10',
    );
  }
});

test('verified hot copy is used first and canonical is untouched', async () => {
  const registry = registryHarness();
  const reader = readerHarness();
  const coordinator = new ObjectReadDeliveryCoordinator({
    registry: registry.registry,
    providerReader: reader.providerReader,
    now: () => new Date('2026-07-17T00:01:00.000Z'),
    createId: () => '10000000-0000-4000-8000-000000000090',
  });
  const result = await coordinator.deliver(deliveryInput());
  assert.equal(result.status, 200);
  assert.equal(result.deliveryState, 'hot');
  assert.equal(result.headers['content-type'], 'video/mp4');
  assert.equal(result.headers.etag, `"${CHECKSUM}"`);
  assert.equal(result.headers['content-disposition'], 'inline; filename="clip.mp4"');
  assert.equal(await new Response(result.body).text(), '0123456789');
  assert.deepEqual(reader.calls, [{ role: 'hot', operation: 'get' }]);
  assert.equal(registry.attempts.filter((entry) => entry.phase === 'finish').length, 1);
  assert.equal(registry.events.length, 1);
});

test('hot provider failure falls back once to verified canonical copy', async () => {
  const registry = registryHarness();
  const reader = readerHarness({ hot: 'fail' });
  const coordinator = new ObjectReadDeliveryCoordinator({
    registry: registry.registry,
    providerReader: reader.providerReader,
    now: () => new Date('2026-07-17T00:01:00.000Z'),
  });
  const result = await coordinator.deliver(deliveryInput({ rangeHeader: 'bytes=2-5' }));
  assert.equal(result.status, 206);
  assert.equal(result.deliveryState, 'canonical-fallback');
  assert.equal(result.headers['content-range'], 'bytes 2-5/10');
  assert.equal(result.headers['content-length'], '4');
  assert.equal(await new Response(result.body).text(), '2345');
  assert.deepEqual(reader.calls, [
    { role: 'hot', operation: 'get', range: 'bytes=2-5' },
    { role: 'canonical', operation: 'get', range: 'bytes=2-5' },
  ]);
  const finishes = registry.attempts.filter((entry) => entry.phase === 'finish');
  assert.equal(finishes.length, 2);
  assert.equal(finishes[0]?.nextState, 'failed');
  assert.equal(finishes[1]?.nextState, 'succeeded');
});

test('an unverified hot copy is skipped without provider contact', async () => {
  const { latestVerifiedAt: _latestVerifiedAt, ...failedHot } = copy('hot');
  const value = snapshot({
    registryState: 'degraded',
    copies: Object.freeze({
      hot: Object.freeze({ ...failedHot, state: 'failed' as const }),
      canonical: copy('canonical'),
    }),
  });
  const registry = registryHarness(value);
  const reader = readerHarness();
  const coordinator = new ObjectReadDeliveryCoordinator({
    registry: registry.registry,
    providerReader: reader.providerReader,
    now: () => new Date('2026-07-17T00:01:00.000Z'),
  });
  const result = await coordinator.deliver(deliveryInput({ method: 'HEAD' }));
  assert.equal(result.status, 200);
  assert.equal(result.body, null);
  assert.equal(result.deliveryState, 'canonical-fallback');
  assert.deepEqual(reader.calls, [{ role: 'canonical', operation: 'head' }]);
});

test('conflicting verified copy metadata fails closed before provider access', async () => {
  const value = snapshot({
    copies: Object.freeze({
      hot: copy('hot', { observedChecksumSha256: 'b'.repeat(64) }),
      canonical: copy('canonical'),
    }),
  });
  const registry = registryHarness(value);
  const reader = readerHarness();
  const coordinator = new ObjectReadDeliveryCoordinator({
    registry: registry.registry,
    providerReader: reader.providerReader,
    now: () => new Date('2026-07-17T00:01:00.000Z'),
  });
  await assert.rejects(
    coordinator.deliver(deliveryInput()),
    (error: unknown) =>
      error instanceof ObjectReadDeliveryError && error.code === 'storage-object-copy-state-conflict',
  );
  assert.deepEqual(reader.calls, []);
});

test('both provider failures return one safe dependency error without authority leakage', async () => {
  const registry = registryHarness();
  const reader = readerHarness({ hot: 'fail', canonical: 'fail' });
  const coordinator = new ObjectReadDeliveryCoordinator({
    registry: registry.registry,
    providerReader: reader.providerReader,
    now: () => new Date('2026-07-17T00:01:00.000Z'),
  });
  await assert.rejects(
    coordinator.deliver(deliveryInput()),
    (error: unknown) => {
      if (!(error instanceof ObjectReadDeliveryError)) return false;
      assert.equal(error.status, 503);
      assert.equal(error.code, 'object-content-unavailable');
      const serialized = JSON.stringify(error);
      assert.equal(serialized.includes('bucket'), false);
      assert.equal(serialized.includes('secret'), false);
      assert.equal(serialized.includes('locator'), false);
      return true;
    },
  );
});

test('consumer cancellation closes the source and records a failed attempt', async () => {
  const registry = registryHarness();
  let closed = false;
  const providerReader: ProviderObjectReader = {
    head: async () => ({ byteLength: CONTENT.byteLength }),
    get: async () => ({
      byteLength: CONTENT.byteLength,
      body: Readable.from((async function* () {
        yield CONTENT.slice(0, 5);
        await new Promise<void>(() => undefined);
      })()),
      close: () => {
        closed = true;
      },
    }),
  };
  const coordinator = new ObjectReadDeliveryCoordinator({
    registry: registry.registry,
    providerReader,
    now: () => new Date('2026-07-17T00:01:00.000Z'),
  });
  const result = await coordinator.deliver(deliveryInput());
  if (result.body === null) throw new Error('expected-stream-body');
  const reader = result.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  await reader.cancel();
  assert.equal(closed, true);
  const finish = registry.attempts.find(
    (entry) => entry.phase === 'finish' && entry.nextState === 'failed',
  );
  assert.equal(finish?.diagnostic !== undefined, true);
});
