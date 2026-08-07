import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ObjectReadDeliveryCoordinator,
  ProviderReadExecutionError,
  type ConfiguredObjectReadProviderCopySnapshot,
  type ObjectReadDeliveryRegistry,
  type ObjectReadDeliverySnapshot,
  type ProviderObjectReader,
} from '../src/runtime-read-delivery.js';

const OBJECT_ID = '60000000-0000-4000-8000-000000000001';
const CHECKSUM = 'b'.repeat(64);
const NOW = new Date('2026-08-02T00:00:00.000Z');

function configuredCopy(
  role: 'primary' | 'replica',
  order: number,
  suffix: number,
  state: ConfiguredObjectReadProviderCopySnapshot['state'] = 'verified',
): ConfiguredObjectReadProviderCopySnapshot {
  return Object.freeze({
    storageObjectCopyId: `61000000-0000-4000-8000-00000000000${suffix}`,
    role,
    order,
    state,
    observedChecksumSha256: CHECKSUM,
    observedByteLength: 10,
    latestVerifiedAt: '2026-08-01T00:00:00.000Z',
    target: Object.freeze({
      providerRole: role,
      providerId: `connection-${suffix}`,
      bucketLabel: `private-bucket-${suffix}`,
      internalLocator: `client/object/${suffix}`,
      credentialSecretReferenceId: `secret-${suffix}`,
    }),
  });
}

function snapshot(
  configuredCopies: readonly Readonly<ConfiguredObjectReadProviderCopySnapshot>[],
  state: Pick<ObjectReadDeliverySnapshot, 'registryState' | 'objectProtectionStage'> = {
    registryState: 'active',
    objectProtectionStage: 'configuration-primary-and-replicas-verified',
  },
): ObjectReadDeliverySnapshot {
  const primary = configuredCopies.find((copy) => copy.role === 'primary')!;
  const firstReplica = configuredCopies.find((copy) => copy.role === 'replica') ?? primary;
  const compatibility = (copy: ConfiguredObjectReadProviderCopySnapshot, role: 'hot' | 'canonical') => Object.freeze({
    storageObjectCopyId: copy.storageObjectCopyId,
    providerRole: role,
    state: copy.state,
    observedChecksumSha256: copy.observedChecksumSha256 ?? CHECKSUM,
    observedByteLength: copy.observedByteLength ?? 10,
    latestVerifiedAt: copy.latestVerifiedAt ?? '2026-08-01T00:00:00.000Z',
    target: Object.freeze({ ...copy.target, providerRole: role }),
  });
  return Object.freeze({
    storageObjectId: OBJECT_ID,
    callerAppId: 'client-a',
    registryState: state.registryState,
    objectProtectionStage: state.objectProtectionStage,
    verifiedChecksumSha256: CHECKSUM,
    verifiedByteLength: 10,
    verifiedContentType: 'video/mp4',
    copies: Object.freeze({
      hot: compatibility(firstReplica, 'hot'),
      canonical: compatibility(primary, 'canonical'),
    }),
    configuredCopies: Object.freeze([...configuredCopies]),
  });
}

function harness(value: ObjectReadDeliverySnapshot, failingProviders: readonly string[] = []) {
  const calls: string[] = [];
  const registry: ObjectReadDeliveryRegistry = {
    getObjectReadDeliverySnapshot: async () => value,
    beginObjectReadAttempt: async () => Object.freeze({ providerAttemptId: '62000000-0000-4000-8000-000000000001' }),
    finishObjectReadAttempt: async () => undefined,
    appendObjectReadEvent: async () => undefined,
  };
  const reader: ProviderObjectReader = {
    head: async ({ target }) => {
      calls.push(target.providerId);
      if (failingProviders.includes(target.providerId)) throw new ProviderReadExecutionError('provider-read-failed');
      return Object.freeze({ byteLength: 10 });
    },
    get: async () => { throw new Error('not used'); },
  };
  return {
    calls,
    coordinator: new ObjectReadDeliveryCoordinator({ registry, providerReader: reader, now: () => NOW }),
  };
}

const grant = Object.freeze({
  objectReadGrantId: '63000000-0000-4000-8000-000000000001',
  storageObjectId: OBJECT_ID,
  purpose: 'playback',
  allowedMethods: Object.freeze(['HEAD'] as const),
  allowRange: false,
  disposition: 'inline' as const,
  expiresAt: '2026-08-02T00:05:00.000Z',
});

function input() {
  return {
    grant,
    caller: Object.freeze({ appId: 'client-a', serviceId: 'integration-token' }),
    method: 'HEAD' as const,
    appCorrelationReference: 'resource-1',
    requestId: '64000000-0000-4000-8000-000000000001',
    signal: new AbortController().signal,
  };
}

test('configured reads try verified replicas by order before primary', async () => {
  const copies = [configuredCopy('primary', 0, 1), configuredCopy('replica', 2, 3), configuredCopy('replica', 1, 2)];
  const { coordinator, calls } = harness(snapshot(copies), ['connection-2']);
  const result = await coordinator.deliver(input());
  assert.deepEqual(calls, ['connection-2', 'connection-3']);
  assert.equal(result.deliveryState, 'replica');
  assert.equal(result.headers['x-zs-delivery-state'], 'replica');
  assert.equal(JSON.stringify(result).includes('private-bucket'), false);
});

test('configured read falls back to primary only after replicas are unavailable', async () => {
  const copies = [configuredCopy('primary', 0, 1), configuredCopy('replica', 1, 2)];
  const { coordinator, calls } = harness(snapshot(copies), ['connection-2']);
  const result = await coordinator.deliver(input());
  assert.deepEqual(calls, ['connection-2', 'connection-1']);
  assert.equal(result.deliveryState, 'primary');
});

test('degraded object remains readable from the verified R2 primary while replica protection is pending', async () => {
  const copies = [
    configuredCopy('primary', 0, 1),
    configuredCopy('replica', 1, 2, 'failed'),
  ];
  const value = snapshot(copies, {
    registryState: 'degraded',
    objectProtectionStage: 'configuration-replica-repair-required',
  });
  const { coordinator, calls } = harness(value);
  const result = await coordinator.deliver(input());
  assert.deepEqual(calls, ['connection-1']);
  assert.equal(result.deliveryState, 'primary');
});

test('post-retention object is readable from verified MinIO protection after the primary is deleted', async () => {
  const copies = [
    configuredCopy('primary', 0, 1, 'deleted'),
    configuredCopy('replica', 1, 2),
  ];
  const value = snapshot(copies, {
    registryState: 'active',
    objectProtectionStage: 'configuration-primary-retention-cleaned',
  });
  const { coordinator, calls } = harness(value);
  const result = await coordinator.deliver(input());
  assert.deepEqual(calls, ['connection-2']);
  assert.equal(result.deliveryState, 'replica');
});

test('zero-replica configured read uses the persisted primary', async () => {
  const copies = [configuredCopy('primary', 0, 1)];
  const { coordinator, calls } = harness(snapshot(copies));
  const result = await coordinator.deliver(input());
  assert.deepEqual(calls, ['connection-1']);
  assert.equal(result.deliveryState, 'primary');
});
