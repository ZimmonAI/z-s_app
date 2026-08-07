import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  ReplicaProtectionApplicationService,
  type ReplicaProtectionRepairJob,
  type ReplicaProtectionRetentionJob,
  type ReplicaProtectionStore,
} from '../src/runtime-replica-protection.js';
import {
  ProviderReadExecutionError,
  type ProviderObjectReader,
  type ResolvedProviderReadTarget,
} from '../src/runtime-read-delivery.js';
import {
  ProviderExecutionError,
  type ProviderObjectWriter,
  type ProviderWriteInput,
  type ProviderWriteReceipt,
  type ResolvedProviderWriteTarget,
} from '../src/runtime-s3-provider.js';

const PRIMARY_BYTES = new TextEncoder().encode('verified-r2-primary-payload');
const CHECKSUM = createHash('sha256').update(PRIMARY_BYTES).digest('hex');

function objectKey(target: { providerId: string; internalLocator: string }): string {
  return `${target.providerId}:${target.internalLocator}`;
}

function readTarget(role: 'primary' | 'replica', providerId: string): Readonly<ResolvedProviderReadTarget> {
  return Object.freeze({
    providerRole: role,
    providerId,
    bucketLabel: `${providerId}-bucket`,
    internalLocator: `video-maker/${providerId}/object-1`,
    credentialSecretReferenceId: `vault:z-s:${providerId}`,
  });
}

function writeTarget(role: 'primary' | 'replica', providerId: string): Readonly<ResolvedProviderWriteTarget> {
  return Object.freeze({
    providerRole: role,
    providerId,
    bucketLabel: `${providerId}-bucket`,
    internalLocator: `video-maker/${providerId}/object-1`,
    normalizedPrefixPattern: `video-maker/${providerId}/*`,
    capabilityPolicy: Object.freeze({
      checksumVerification: 'required' as const,
      sizeVerification: 'required-when-supported' as const,
      headContentLength: 'required' as const,
      rangeRead: 'optional' as const,
    }),
    credentialSecretReferenceId: `vault:z-s:${providerId}`,
  });
}

class MemoryProvider implements ProviderObjectReader, ProviderObjectWriter {
  readonly objects = new Map<string, Uint8Array>();
  readonly unavailable = new Set<string>();
  writes: string[] = [];
  deletes: string[] = [];

  async head(input: { target: Readonly<ResolvedProviderReadTarget> }) {
    const bytes = this.objects.get(objectKey(input.target));
    if (bytes === undefined) throw new ProviderReadExecutionError('provider-read-missing', false);
    return Object.freeze({ byteLength: bytes.byteLength });
  }

  async get(input: { target: Readonly<ResolvedProviderReadTarget> }) {
    if (this.unavailable.has(input.target.providerId)) {
      throw new ProviderReadExecutionError('provider-read-failed', true);
    }
    const bytes = this.objects.get(objectKey(input.target));
    if (bytes === undefined) throw new ProviderReadExecutionError('provider-read-missing', false);
    return Object.freeze({
      byteLength: bytes.byteLength,
      body: Readable.from([bytes]),
      close() {},
    });
  }

  async write(input: Readonly<ProviderWriteInput>): Promise<Readonly<ProviderWriteReceipt>> {
    this.writes.push(input.target.providerId);
    if (this.unavailable.has(input.target.providerId)) {
      throw new ProviderExecutionError('dependency-unavailable', 'provider-write-failed', true);
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of input.source) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(Buffer.from(chunk as string)));
    }
    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    this.objects.set(objectKey(input.target), new Uint8Array(body));
    return Object.freeze({
      providerRole: input.target.providerRole,
      observed: Object.freeze({ checksumSha256: input.checksumSha256, byteLength: body.byteLength }),
      integrityVerification: Object.freeze({
        verified: true as const,
        checksumVerified: true as const,
        sizeVerified: true,
        sizeVerificationDisposition: 'matched' as const,
      }),
    });
  }

  async cleanup(input: { target: Readonly<ResolvedProviderWriteTarget> }) {
    this.deletes.push(input.target.providerId);
    if (this.unavailable.has(input.target.providerId)) {
      return Object.freeze({
        deleted: false,
        diagnostic: Object.freeze({
          category: 'dependency-unavailable' as const,
          code: 'provider-cleanup-failed',
          retryable: true,
        }),
      });
    }
    this.objects.delete(objectKey(input.target));
    return Object.freeze({ deleted: true });
  }
}

class StoreHarness implements ReplicaProtectionStore {
  completedRepairs = 0;
  failedRepairs: { code: string; retryable: boolean }[] = [];
  completedRetention = 0;
  failedRetention: { code: string; invalidateReplicaCopyId?: string }[] = [];

  async claimRepair(): Promise<Readonly<ReplicaProtectionRepairJob> | null> { return null; }
  async claimRetention() { return Object.freeze({ kind: 'idle' as const }); }
  async completeRepair(): Promise<void> { this.completedRepairs += 1; }
  async failRepair(input: { code: string; retryable: boolean }): Promise<void> {
    this.failedRepairs.push({ code: input.code, retryable: input.retryable });
  }
  async completeRetention(): Promise<void> { this.completedRetention += 1; }
  async failRetention(input: { code: string; invalidateReplicaCopyId?: string }): Promise<void> {
    this.failedRetention.push({
      code: input.code,
      ...(input.invalidateReplicaCopyId === undefined ? {} : { invalidateReplicaCopyId: input.invalidateReplicaCopyId }),
    });
  }
}

function repairJob(): Readonly<ReplicaProtectionRepairJob> {
  return Object.freeze({
    providerAttemptId: '60000000-0000-4000-8000-000000000001',
    attemptNumber: 1,
    leaseToken: '60000000-0000-4000-8000-000000000002',
    storageObjectId: '60000000-0000-4000-8000-000000000003',
    sourceStorageObjectCopyId: '60000000-0000-4000-8000-000000000004',
    targetStorageObjectCopyId: '60000000-0000-4000-8000-000000000005',
    expectedChecksumSha256: CHECKSUM,
    expectedByteLength: PRIMARY_BYTES.byteLength,
    sourceTarget: readTarget('primary', 'r2-primary'),
    targetReadTarget: readTarget('replica', 'minio-replica'),
    targetWriteTarget: writeTarget('replica', 'minio-replica'),
  });
}

function retentionJob(): Readonly<ReplicaProtectionRetentionJob> {
  return Object.freeze({
    providerAttemptId: '61000000-0000-4000-8000-000000000001',
    attemptNumber: 1,
    leaseToken: '61000000-0000-4000-8000-000000000002',
    storageObjectId: '61000000-0000-4000-8000-000000000003',
    primaryStorageObjectCopyId: '61000000-0000-4000-8000-000000000004',
    expectedChecksumSha256: CHECKSUM,
    expectedByteLength: PRIMARY_BYTES.byteLength,
    primaryTarget: writeTarget('primary', 'r2-primary'),
    protectionCopies: Object.freeze([
      Object.freeze({
        storageObjectCopyId: '61000000-0000-4000-8000-000000000005',
        target: readTarget('replica', 'minio-replica'),
      }),
    ]),
  });
}

test('repair copies verified R2 source to MinIO and promotes only after full target verification', async () => {
  const provider = new MemoryProvider();
  const store = new StoreHarness();
  const job = repairJob();
  provider.objects.set(objectKey(job.sourceTarget), PRIMARY_BYTES);
  const service = new ReplicaProtectionApplicationService({ store, reader: provider, writer: provider });
  await service.processRepair(job, new Date('2026-08-07T00:00:00.000Z'));
  assert.deepEqual(provider.writes, ['minio-replica']);
  assert.equal(store.completedRepairs, 1);
  assert.deepEqual(store.failedRepairs, []);
  assert.deepEqual(provider.objects.get(objectKey(job.targetReadTarget)), PRIMARY_BYTES);
});

test('duplicate repair delivery accepts an already exact target without a second provider write', async () => {
  const provider = new MemoryProvider();
  const store = new StoreHarness();
  const job = repairJob();
  provider.objects.set(objectKey(job.sourceTarget), PRIMARY_BYTES);
  provider.objects.set(objectKey(job.targetReadTarget), PRIMARY_BYTES);
  const service = new ReplicaProtectionApplicationService({ store, reader: provider, writer: provider });
  await service.processRepair(job);
  assert.deepEqual(provider.writes, []);
  assert.equal(store.completedRepairs, 1);
  assert.deepEqual(store.failedRepairs, []);
});

test('replica provider unavailable records retryable repair failure without deleting the verified primary', async () => {
  const provider = new MemoryProvider();
  const store = new StoreHarness();
  const job = repairJob();
  provider.objects.set(objectKey(job.sourceTarget), PRIMARY_BYTES);
  provider.unavailable.add('minio-replica');
  const service = new ReplicaProtectionApplicationService({ store, reader: provider, writer: provider });
  await service.processRepair(job);
  assert.equal(store.completedRepairs, 0);
  assert.equal(store.failedRepairs.length, 1);
  assert.equal(store.failedRepairs[0]?.retryable, true);
  assert.deepEqual(provider.objects.get(objectKey(job.sourceTarget)), PRIMARY_BYTES);
  assert.equal(provider.deletes.includes('r2-primary'), false);
});

test('mismatched existing replica is cleaned and rewritten from the verified primary', async () => {
  const provider = new MemoryProvider();
  const store = new StoreHarness();
  const job = repairJob();
  provider.objects.set(objectKey(job.sourceTarget), PRIMARY_BYTES);
  provider.objects.set(objectKey(job.targetReadTarget), new TextEncoder().encode('wrong'));
  const service = new ReplicaProtectionApplicationService({ store, reader: provider, writer: provider });
  await service.processRepair(job);
  assert.deepEqual(provider.deletes, ['minio-replica']);
  assert.deepEqual(provider.writes, ['minio-replica']);
  assert.equal(store.completedRepairs, 1);
  assert.deepEqual(provider.objects.get(objectKey(job.targetReadTarget)), PRIMARY_BYTES);
});

test('retention is blocked without a verified protection claim and never calls primary delete', async () => {
  const provider = new MemoryProvider();
  const store = new StoreHarness();
  const service = new ReplicaProtectionApplicationService({ store, reader: provider, writer: provider });
  const result = await service.processRetention(Object.freeze({ kind: 'blocked' }));
  assert.equal(result, 'blocked');
  assert.deepEqual(provider.deletes, []);
  assert.equal(store.completedRetention, 0);
});

test('retention deletes primary only after protection copy is live-verified with exact integrity', async () => {
  const provider = new MemoryProvider();
  const store = new StoreHarness();
  const job = retentionJob();
  provider.objects.set(objectKey(job.primaryTarget), PRIMARY_BYTES);
  provider.objects.set(objectKey(job.protectionCopies[0]!.target), PRIMARY_BYTES);
  const service = new ReplicaProtectionApplicationService({ store, reader: provider, writer: provider });
  const result = await service.processRetention(Object.freeze({ kind: 'job', job }));
  assert.equal(result, 'processed');
  assert.deepEqual(provider.deletes, ['r2-primary']);
  assert.equal(store.completedRetention, 1);
  assert.deepEqual(store.failedRetention, []);
});

test('retention integrity mismatch blocks primary deletion and invalidates the bad replica authority', async () => {
  const provider = new MemoryProvider();
  const store = new StoreHarness();
  const job = retentionJob();
  provider.objects.set(objectKey(job.primaryTarget), PRIMARY_BYTES);
  provider.objects.set(
    objectKey(job.protectionCopies[0]!.target),
    new TextEncoder().encode('wrong-protection-bytes'),
  );
  const service = new ReplicaProtectionApplicationService({ store, reader: provider, writer: provider });
  const result = await service.processRetention(Object.freeze({ kind: 'job', job }));
  assert.equal(result, 'blocked');
  assert.equal(provider.deletes.includes('r2-primary'), false);
  assert.deepEqual(store.failedRetention, [{
    code: 'storage-retention-protection-integrity-mismatch',
    invalidateReplicaCopyId: job.protectionCopies[0]!.storageObjectCopyId,
  }]);
});
