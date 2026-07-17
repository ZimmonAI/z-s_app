import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  ObjectReadDeliveryCoordinator,
  ProviderReadExecutionError,
  createDeterministicObjectReadGrantTokenService,
  objectReadGrantTokenDigest,
  parseSingleByteRange,
} from '../dist/index.js';

const content = new TextEncoder().encode('0123456789');
const checksum = 'a'.repeat(64);
const objectId = '10000000-0000-4000-8000-000000000001';
const grantId = '10000000-0000-4000-8000-000000000002';
const attempts = [];
const events = [];
const providerCalls = [];
let attemptSequence = 0;
const snapshot = Object.freeze({
  storageObjectId: objectId,
  callerAppId: 'video-maker_app',
  registryState: 'active',
  objectProtectionStage: 'canonical-and-hot-verified',
  verifiedChecksumSha256: checksum,
  verifiedByteLength: content.byteLength,
  verifiedContentType: 'video/mp4',
  copies: Object.freeze({
    hot: Object.freeze({
      storageObjectCopyId: '10000000-0000-4000-8000-000000000003',
      providerRole: 'hot',
      state: 'verified',
      observedChecksumSha256: checksum,
      observedByteLength: content.byteLength,
      latestVerifiedAt: '2026-07-17T00:00:00.000Z',
      target: Object.freeze({
        providerRole: 'hot',
        providerId: 'r2_video_maker_dev_01',
        bucketLabel: 'video-maker-hot',
        internalLocator: 'video-maker/user-resources/hot/opaque-object',
        credentialSecretReferenceId: 'secret-hot',
      }),
    }),
    canonical: Object.freeze({
      storageObjectCopyId: '10000000-0000-4000-8000-000000000004',
      providerRole: 'canonical',
      state: 'verified',
      observedChecksumSha256: checksum,
      observedByteLength: content.byteLength,
      latestVerifiedAt: '2026-07-17T00:00:00.000Z',
      target: Object.freeze({
        providerRole: 'canonical',
        providerId: 'minio_zimspace_local_pc_01',
        bucketLabel: 'zs-dev-app-video-maker-canon',
        internalLocator: 'video-maker/user-resources/canonical/opaque-object',
        credentialSecretReferenceId: 'secret-canonical',
      }),
    }),
  }),
});
const registry = {
  getObjectReadDeliverySnapshot: async () => snapshot,
  beginObjectReadAttempt: async (input) => {
    attemptSequence += 1;
    attempts.push({ phase: 'begin', role: input.storageObjectCopyId });
    return { providerAttemptId: `10000000-0000-4000-8000-0000000001${String(attemptSequence).padStart(2, '0')}` };
  },
  finishObjectReadAttempt: async (input) => attempts.push({ phase: 'finish', state: input.nextState }),
  appendObjectReadEvent: async (input) => events.push(input.eventType),
};
const providerReader = {
  head: async ({ target }) => {
    providerCalls.push({ role: target.providerRole, operation: 'head' });
    return { byteLength: content.byteLength };
  },
  get: async ({ target, range }) => {
    providerCalls.push({ role: target.providerRole, operation: 'get', range: range ?? null });
    if (target.providerRole === 'hot') throw new ProviderReadExecutionError('provider-read-failed');
    const parsed = range === undefined ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
    const bytes = parsed === null
      ? content
      : content.slice(Number(parsed[1]), Number(parsed[2]) + 1);
    return { byteLength: bytes.byteLength, body: Readable.from([bytes]), close: () => undefined };
  },
};

const tokenService = createDeterministicObjectReadGrantTokenService({
  signingKey: 'deterministic-read-token-key',
  now: () => new Date('2026-07-17T00:00:00.000Z'),
});
const claims = Object.freeze({
  tokenPurpose: 'object-read-grant',
  objectReadGrantId: grantId,
  storageObjectId: objectId,
  callerAppId: 'video-maker_app',
  callerServiceId: 'api',
  purpose: 'video-playback',
  allowedMethods: Object.freeze(['HEAD', 'GET']),
  allowRange: true,
  contractVersion: '1.0',
  expiresAt: '2026-07-17T00:02:00.000Z',
});
const token = tokenService.issue(claims);
assert.equal(tokenService.issue(claims), token);
assert.equal(objectReadGrantTokenDigest(token).length, 64);
assert.deepEqual(parseSingleByteRange('bytes=-4', content.byteLength), {
  start: 6,
  end: 9,
  byteLength: 4,
  providerRange: 'bytes=6-9',
  contentRange: 'bytes 6-9/10',
});

const coordinator = new ObjectReadDeliveryCoordinator({
  registry,
  providerReader,
  now: () => new Date('2026-07-17T00:00:00.000Z'),
  createId: () => '10000000-0000-4000-8000-000000000099',
});
const delivered = await coordinator.deliver({
  grant: Object.freeze({
    objectReadGrantId: grantId,
    storageObjectId: objectId,
    purpose: 'video-playback',
    allowedMethods: Object.freeze(['HEAD', 'GET']),
    allowRange: true,
    disposition: 'inline',
    fileName: 'clip.mp4',
    expiresAt: claims.expiresAt,
  }),
  caller: Object.freeze({ appId: 'video-maker_app', serviceId: 'api' }),
  method: 'GET',
  rangeHeader: 'bytes=2-5',
  appCorrelationReference: 'resource-01',
  requestId: '10000000-0000-4000-8000-000000000098',
  signal: new AbortController().signal,
});
assert.equal(delivered.status, 206);
assert.equal(delivered.deliveryState, 'canonical-fallback');
assert.equal(delivered.headers['content-range'], 'bytes 2-5/10');
assert.equal(await new Response(delivered.body).text(), '2345');
assert.deepEqual(providerCalls, [
  { role: 'hot', operation: 'get', range: 'bytes=2-5' },
  { role: 'canonical', operation: 'get', range: 'bytes=2-5' },
]);
assert.deepEqual(attempts.filter((entry) => entry.phase === 'finish').map((entry) => entry.state), [
  'failed',
  'succeeded',
]);
assert.deepEqual(events, ['object-read-delivered']);

const evidence = Object.freeze({
  schemaVersion: 1,
  packageVersion: '0.5.0',
  contractVersion: '1.0',
  tokenDigestOnly: true,
  rangeFormsVerified: ['closed', 'open-ended', 'suffix'],
  hotFirst: true,
  canonicalFallback: true,
  providerAuthorityExposed: false,
  liveProviderActionsPerformed: false,
  databaseActionsPerformed: false,
});
console.log(JSON.stringify(evidence));
