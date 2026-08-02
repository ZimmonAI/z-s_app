import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  ConfiguredTargetedRetryCoordinator,
  DualProviderObjectIngestAdapter,
  type ConfiguredProviderAttemptReservation,
  type ConfiguredProviderStorageTruth,
  type ConfiguredTargetedRetryReservation,
  type DualProviderWriteOutcome,
  type DualProviderWriteRegistry,
} from '../src/runtime-dual-provider.js';
import { ObjectIngestRuntimeError, type ObjectIngestInput } from '../src/runtime-ingest.js';
import type { MediaVerificationAdapter } from '../src/runtime-media-verification.js';
import type {
  ProviderObjectWriter,
  ProviderWriteInput,
  ProviderWriteReceipt,
} from '../src/runtime-s3-provider.js';
import type {
  ConfiguredProviderCopyExecutionContext,
} from '../src/runtime-storage-registry-types.js';

const OBJECT_ID = '50000000-0000-4000-8000-000000000001';
const INTENT_ID = '50000000-0000-4000-8000-000000000002';
const CONTENT = new TextEncoder().encode('configured-provider-payload');
const CHECKSUM = createHash('sha256').update(CONTENT).digest('hex');

function configuredCopy(role: 'primary' | 'replica', order: number, suffix: number): ConfiguredProviderCopyExecutionContext {
  return Object.freeze({
    storageObjectCopyId: `51000000-0000-4000-8000-00000000000${suffix}`,
    configurationRouteTargetId: `52000000-0000-4000-8000-00000000000${suffix}`,
    configurationVaultId: `53000000-0000-4000-8000-00000000000${suffix}`,
    providerConnectionId: `54000000-0000-4000-8000-00000000000${suffix}`,
    role,
    order,
    providerType: suffix === 1 ? 'minio' : 'r2',
    bucketLabel: `private-bucket-${suffix}`,
    prefixTemplate: `client/video/${suffix}/*`,
    secretReferenceId: `vault:z-s:${suffix}`,
    internalLocator: `client/video/${suffix}/${OBJECT_ID}`,
    state: 'pending',
    rowVersion: 1,
  });
}

class ConfiguredRegistryHarness {
  beginCalls = 0;
  completeCalls = 0;
  abortCalls = 0;
  outcomes: readonly Readonly<{ configurationRouteTargetId: string; outcome: Readonly<DualProviderWriteOutcome> }>[] = [];

  readonly registry = {
    beginConfiguredProviderWrite: async (input: {
      objectWriteIntentId: string;
      storageObjectId: string;
      expectedIntentRowVersion: number;
      expectedObjectRowVersion: number;
      copies: readonly Readonly<ConfiguredProviderCopyExecutionContext>[];
    }): Promise<Readonly<ConfiguredProviderAttemptReservation>> => {
      this.beginCalls += 1;
      return Object.freeze({
        objectWriteIntentId: input.objectWriteIntentId,
        storageObjectId: input.storageObjectId,
        expectedIntentRowVersion: input.expectedIntentRowVersion,
        expectedObjectRowVersion: input.expectedObjectRowVersion,
        attempts: Object.freeze(input.copies.map((copy, index) => Object.freeze({
          configurationRouteTargetId: copy.configurationRouteTargetId,
          providerAttemptId: `55000000-0000-4000-8000-00000000000${index + 1}`,
          storageObjectCopyId: copy.storageObjectCopyId,
          expectedCopyRowVersion: copy.rowVersion,
        }))),
      });
    },
    completeConfiguredProviderWrite: async (input: {
      reservation: Readonly<ConfiguredProviderAttemptReservation>;
      checksumSha256: string;
      byteLength: number;
      outcomes: readonly Readonly<{ configurationRouteTargetId: string; outcome: Readonly<DualProviderWriteOutcome> }>[];
    }) => {
      this.completeCalls += 1;
      this.outcomes = input.outcomes;
      const primary = input.outcomes[0]?.outcome;
      const replicasReady = input.outcomes.slice(1).every((entry) => entry.outcome.state === 'verified');
      const storageState = primary?.state !== 'verified' ? 'unavailable' : replicasReady ? 'ready' : 'degraded';
      return Object.freeze({
        storageObjectId: input.reservation.storageObjectId,
        writeIntentId: input.reservation.objectWriteIntentId,
        state: 'recorded' as const,
        checksumSha256: input.checksumSha256,
        byteLength: input.byteLength,
        integrityVerification: Object.freeze({
          verified: true as const, checksumVerified: true as const, sizeVerified: true,
          sizeVerificationDisposition: 'matched' as const,
        }),
        objectProtectionStage: storageState === 'ready'
          ? 'configuration-primary-and-replicas-verified'
          : storageState === 'degraded'
            ? 'configuration-replica-repair-required'
            : 'configuration-primary-write-failed',
        storageState,
        verifiedMedia: Object.freeze({ mediaType: 'application/octet-stream', mediaFamily: 'image' as const }),
        targetCopies: Object.freeze(input.outcomes.map((entry, index) => Object.freeze({
          role: index === 0 ? 'primary' as const : 'replica' as const,
          order: index,
          state: entry.outcome.state,
          retryable: entry.outcome.retryable,
        }))),
      });
    },
    abortConfiguredProviderWrite: async () => { this.abortCalls += 1; },
  } as unknown as DualProviderWriteRegistry;
}

function writerHarness(failProviderIds: readonly string[] = []) {
  const writes: string[] = [];
  const writer: ProviderObjectWriter = {
    write: async (input: Readonly<ProviderWriteInput>): Promise<Readonly<ProviderWriteReceipt>> => {
      writes.push(input.target.providerId);
      if (failProviderIds.includes(input.target.providerId)) throw new Error('provider-failed');
      return Object.freeze({
        providerRole: input.target.providerRole,
        observed: Object.freeze({ checksumSha256: input.checksumSha256, byteLength: input.byteLength }),
        integrityVerification: Object.freeze({
          verified: true as const,
          checksumVerified: true as const,
          sizeVerified: true,
          sizeVerificationDisposition: 'matched' as const,
        }),
      });
    },
    cleanup: async () => Object.freeze({ deleted: true }),
  };
  return { writer, writes };
}

const mediaVerifier: MediaVerificationAdapter = {
  verify: async () => Object.freeze({ mediaType: 'application/octet-stream', mediaFamily: 'image' }),
};

function ingestInput(copies: readonly Readonly<ConfiguredProviderCopyExecutionContext>[]): ObjectIngestInput {
  return Object.freeze({
    objectWriteIntentId: INTENT_ID,
    storageObjectId: OBJECT_ID,
    mediaType: 'application/octet-stream',
    declaredByteLength: CONTENT.byteLength,
    declaredChecksumSha256: CHECKSUM,
    body: Readable.from([CONTENT]),
    internalLocators: Object.freeze({ hot: copies[1]?.internalLocator ?? copies[0]!.internalLocator, canonical: copies[0]!.internalLocator }),
    configuredCopies: copies,
    intentRowVersion: 1,
    objectRowVersion: 1,
  });
}

test('configured execution writes primary first and replicas in ascending persisted order', async () => {
  const registry = new ConfiguredRegistryHarness();
  const { writer, writes } = writerHarness();
  const copies = [configuredCopy('replica', 2, 3), configuredCopy('primary', 0, 1), configuredCopy('replica', 1, 2)];
  const adapter = new DualProviderObjectIngestAdapter({ registry: registry.registry, writer, mediaVerifier, resolveTarget: { resolve: () => { throw new Error('legacy resolver must not run'); } } });
  const receipt = await adapter.ingest(ingestInput(copies));
  assert.deepEqual(writes, [
    '54000000-0000-4000-8000-000000000001',
    '54000000-0000-4000-8000-000000000002',
    '54000000-0000-4000-8000-000000000003',
  ]);
  assert.equal(receipt.completionResult?.storageState, 'ready');
  assert.deepEqual(receipt.completionResult?.targetCopies?.map((copy) => [copy.role, copy.order]), [
    ['primary', 0], ['replica', 1], ['replica', 2],
  ]);
  assert.equal(JSON.stringify(receipt).includes('private-bucket'), false);
  assert.equal(JSON.stringify(receipt).includes('vault:z-s'), false);
});

test('primary failure fails upload before any replica write', async () => {
  const registry = new ConfiguredRegistryHarness();
  const { writer, writes } = writerHarness(['54000000-0000-4000-8000-000000000001']);
  const copies = [configuredCopy('primary', 0, 1), configuredCopy('replica', 1, 2)];
  const adapter = new DualProviderObjectIngestAdapter({ registry: registry.registry, writer, mediaVerifier, resolveTarget: { resolve: () => { throw new Error('legacy resolver must not run'); } } });
  await assert.rejects(
    adapter.ingest(ingestInput(copies)),
    (error: unknown) => error instanceof ObjectIngestRuntimeError && error.code === 'configuration-primary-write-failed',
  );
  assert.deepEqual(writes, ['54000000-0000-4000-8000-000000000001']);
  assert.equal(registry.completeCalls, 1);
  assert.equal(registry.abortCalls, 0);
});

test('replica failure records degraded result and leaves primary verified', async () => {
  const registry = new ConfiguredRegistryHarness();
  const { writer } = writerHarness(['54000000-0000-4000-8000-000000000002']);
  const copies = [configuredCopy('primary', 0, 1), configuredCopy('replica', 1, 2)];
  const adapter = new DualProviderObjectIngestAdapter({ registry: registry.registry, writer, mediaVerifier, resolveTarget: { resolve: () => { throw new Error('legacy resolver must not run'); } } });
  const receipt = await adapter.ingest(ingestInput(copies));
  assert.equal(receipt.completionResult?.storageState, 'degraded');
  assert.deepEqual(receipt.completionResult?.targetCopies?.map((copy) => copy.state), ['verified', 'failed']);
});

test('configured targeted retry addresses only the selected persisted route target', async () => {
  const selected = configuredCopy('replica', 2, 3);
  let reservedTargetId = '';
  let reservedClientId = '';
  let completedTargetId = '';
  const registry = {
    reserveConfiguredTargetRetry: async (input: { clientId: string; configurationRouteTargetId: string }): Promise<Readonly<ConfiguredTargetedRetryReservation>> => {
      reservedClientId = input.clientId;
      reservedTargetId = input.configurationRouteTargetId;
      return Object.freeze({
        storageObjectId: OBJECT_ID,
        target: selected,
        providerAttemptId: '56000000-0000-4000-8000-000000000001',
        expectedPendingCopyVersion: 2,
        expectedObjectRowVersion: 4,
        checksumSha256: CHECKSUM,
        byteLength: CONTENT.byteLength,
      });
    },
    completeConfiguredTargetRetry: async (input: { reservation: Readonly<ConfiguredTargetedRetryReservation> }): Promise<Readonly<ConfiguredProviderStorageTruth>> => {
      completedTargetId = input.reservation.target.configurationRouteTargetId;
      return Object.freeze({
        storageObjectId: OBJECT_ID,
        storageState: 'ready',
        objectProtectionStage: 'configuration-primary-and-replicas-verified',
        targetCopies: Object.freeze([
          Object.freeze({ role: 'primary', order: 0, state: 'verified', retryable: false }),
          Object.freeze({ role: 'replica', order: 1, state: 'verified', retryable: false }),
          Object.freeze({ role: 'replica', order: 2, state: 'verified', retryable: false }),
        ]),
      });
    },
  } as unknown as DualProviderWriteRegistry;
  const { writer, writes } = writerHarness();
  const coordinator = new ConfiguredTargetedRetryCoordinator({ registry, writer });
  await coordinator.retry({
    principal: Object.freeze({
      clientId: 'client-a', environment: 'dev', tokenId: 'manage-token',
      scopes: Object.freeze(['object:manage'] as const),
    }),
    storageObjectId: OBJECT_ID,
    configurationRouteTargetId: selected.configurationRouteTargetId,
    expectedFailedCopyVersion: 1,
    verifiedSource: { open: () => Readable.from([CONTENT]) },
  });
  assert.equal(reservedClientId, 'client-a');
  assert.equal(reservedTargetId, selected.configurationRouteTargetId);
  assert.equal(completedTargetId, selected.configurationRouteTargetId);
  assert.deepEqual(writes, [selected.providerConnectionId]);
});

test('configured targeted retry requires object:manage scope before registry access', async () => {
  let reserveCalls = 0;
  const registry = {
    reserveConfiguredTargetRetry: async () => {
      reserveCalls += 1;
      throw new Error('must not reserve without scope');
    },
  } as unknown as DualProviderWriteRegistry;
  const { writer } = writerHarness();
  const coordinator = new ConfiguredTargetedRetryCoordinator({ registry, writer });
  await assert.rejects(
    coordinator.retry({
      principal: Object.freeze({
        clientId: 'client-a', environment: 'dev', tokenId: 'write-token',
        scopes: Object.freeze(['object:write'] as const),
      }),
      storageObjectId: OBJECT_ID,
      configurationRouteTargetId: '52000000-0000-4000-8000-000000000003',
      expectedFailedCopyVersion: 1,
      verifiedSource: { open: () => Readable.from([CONTENT]) },
    }),
    (error: unknown) => error instanceof Error && error.message === 'integration-token-scope-denied',
  );
  assert.equal(reserveCalls, 0);
});
