import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  DualProviderObjectIngestAdapter,
  TargetedProviderRetryCoordinator,
  type DualProviderAttemptReservation,
  type DualProviderStorageTruth,
  type DualProviderWriteOutcome,
  type DualProviderWriteRegistry,
  type TargetedProviderRetryReservation,
} from '../src/runtime-dual-provider.js';
import { BoundedMediaVerifier } from '../src/runtime-media-verification.js';
import {
  ProviderExecutionError,
  S3CompatibleProviderObjectWriter,
  type ProviderObjectWriter,
  type ProviderWriteInput,
  type ProviderWriteReceipt,
  type ProviderWriteRole,
  type ResolvedProviderWriteTarget,
} from '../src/runtime-s3-provider.js';
import type {
  ObjectUploadCompletionOperationResult,
  SafeProviderCopyResult,
  StorageObjectResultState,
  VerifiedMediaMetadata,
} from '../src/runtime-contract.js';
import type { ObjectIngestInput } from '../src/runtime-ingest.js';

const HOT_COPY_ID = '40000000-0000-4000-8000-000000000001';
const CANONICAL_COPY_ID = '40000000-0000-4000-8000-000000000002';
const STORAGE_OBJECT_ID = '40000000-0000-4000-8000-000000000003';
const WRITE_INTENT_ID = '40000000-0000-4000-8000-000000000004';
const HOT_BINDING_ID = '40000000-0000-4000-8000-000000000005';
const CANONICAL_BINDING_ID = '40000000-0000-4000-8000-000000000006';

function u32(value: number): Uint8Array {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from([...value].map((entry) => entry.charCodeAt(0)));
}

function join(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function png(width = 2, height = 3): Uint8Array {
  const data = join(u32(width), u32(height), Uint8Array.of(8, 6, 0, 0, 0));
  return join(
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    u32(data.byteLength),
    ascii('IHDR'),
    data,
    new Uint8Array(4),
    u32(0),
    ascii('IEND'),
    new Uint8Array(4),
  );
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function target(role: 'hot' | 'canonical'): Readonly<ResolvedProviderWriteTarget> {
  return Object.freeze({
    providerRole: role,
    providerId: role === 'hot' ? 'r2-provider' : 'minio-provider',
    bucketLabel: role === 'hot' ? 'hot-assets' : 'canonical-assets',
    internalLocator: `apps/test/object/${role}`,
    normalizedPrefixPattern: 'apps/test/*',
    capabilityPolicy: Object.freeze({
      checksumVerification: 'required',
      sizeVerification: 'required-when-supported',
      headContentLength: role === 'hot' ? 'optional-with-checksum' : 'required',
      rangeRead: 'optional',
    }),
    credentialSecretReferenceId: `${role}-secret-ref`,
  });
}

function storageMapping(outcomes: Readonly<Record<'hot' | 'canonical', Readonly<DualProviderWriteOutcome>>>): {
  storageState: StorageObjectResultState;
  objectProtectionStage: string;
} {
  if (outcomes.hot.state === 'verified' && outcomes.canonical.state === 'verified') {
    return { storageState: 'ready', objectProtectionStage: 'canonical-and-hot-verified' };
  }
  if (outcomes.hot.state === 'failed' && outcomes.canonical.state === 'verified') {
    return {
      storageState: 'degraded',
      objectProtectionStage: 'canonical-verified-hot-repair-required',
    };
  }
  if (outcomes.hot.state === 'verified' && outcomes.canonical.state === 'failed') {
    return {
      storageState: 'degraded',
      objectProtectionStage: 'hot-verified-canonical-repair-required',
    };
  }
  return { storageState: 'unavailable', objectProtectionStage: 'provider-write-failed' };
}

function copyResult(outcome: Readonly<DualProviderWriteOutcome>): Readonly<SafeProviderCopyResult> {
  return Object.freeze({ state: outcome.state, retryable: outcome.retryable });
}

class FakeRegistry implements DualProviderWriteRegistry {
  beginCalls = 0;
  completeCalls = 0;
  abortCalls = 0;
  retryReserveCalls = 0;
  retryCompleteCalls = 0;
  lastOutcomes: Readonly<Record<'hot' | 'canonical', Readonly<DualProviderWriteOutcome>>> | null = null;
  retryPeerState: 'verified' | 'failed' = 'verified';

  async beginDualProviderWrite(input: {
    objectWriteIntentId: string;
    storageObjectId: string;
    expectedIntentRowVersion: number;
    expectedObjectRowVersion: number;
  }): Promise<Readonly<DualProviderAttemptReservation>> {
    this.beginCalls += 1;
    return Object.freeze({
      objectWriteIntentId: input.objectWriteIntentId,
      storageObjectId: input.storageObjectId,
      expectedIntentRowVersion: input.expectedIntentRowVersion,
      expectedObjectRowVersion: input.expectedObjectRowVersion,
      attempts: Object.freeze({
        hot: Object.freeze({
          providerAttemptId: '50000000-0000-4000-8000-000000000001',
          storageObjectCopyId: HOT_COPY_ID,
          expectedCopyRowVersion: 1,
        }),
        canonical: Object.freeze({
          providerAttemptId: '50000000-0000-4000-8000-000000000002',
          storageObjectCopyId: CANONICAL_COPY_ID,
          expectedCopyRowVersion: 1,
        }),
      }),
    });
  }

  async completeDualProviderWrite(input: {
    reservation: Readonly<DualProviderAttemptReservation>;
    checksumSha256: string;
    byteLength: number;
    verifiedMedia: Readonly<VerifiedMediaMetadata>;
    outcomes: Readonly<Record<'hot' | 'canonical', Readonly<DualProviderWriteOutcome>>>;
  }): Promise<Readonly<ObjectUploadCompletionOperationResult>> {
    this.completeCalls += 1;
    this.lastOutcomes = input.outcomes;
    const mapping = storageMapping(input.outcomes);
    return Object.freeze({
      storageObjectId: input.reservation.storageObjectId,
      writeIntentId: input.reservation.objectWriteIntentId,
      state: 'recorded',
      checksumSha256: input.checksumSha256,
      byteLength: input.byteLength,
      integrityVerification: Object.freeze({
        verified: true,
        checksumVerified: true,
        sizeVerified: true,
        sizeVerificationDisposition: 'matched',
      }),
      objectProtectionStage: mapping.objectProtectionStage,
      storageState: mapping.storageState,
      verifiedMedia: input.verifiedMedia,
      copies: Object.freeze({
        hot: copyResult(input.outcomes.hot),
        canonical: copyResult(input.outcomes.canonical),
      }),
      ...(mapping.storageState === 'ready'
        ? {}
        : {
            safeDiagnostic: Object.freeze({
              category: 'dependency-unavailable' as const,
              code: 'provider-write-degraded',
              retryable: true,
            }),
          }),
    });
  }

  async abortDualProviderWrite(): Promise<void> {
    this.abortCalls += 1;
  }

  async reserveTargetedProviderRetry(input: {
    storageObjectId: string;
    providerRole: 'hot' | 'canonical';
  }): Promise<Readonly<TargetedProviderRetryReservation>> {
    this.retryReserveCalls += 1;
    return Object.freeze({
      storageObjectId: input.storageObjectId,
      providerRole: input.providerRole,
      providerBindingId: input.providerRole === 'hot' ? HOT_BINDING_ID : CANONICAL_BINDING_ID,
      internalLocator: target(input.providerRole).internalLocator,
      providerAttemptId: '50000000-0000-4000-8000-000000000003',
      storageObjectCopyId: input.providerRole === 'hot' ? HOT_COPY_ID : CANONICAL_COPY_ID,
      expectedPendingCopyVersion: 3,
      expectedObjectRowVersion: 2,
      checksumSha256: sha256(png()),
      byteLength: png().byteLength,
    });
  }

  async completeTargetedProviderRetry(input: {
    reservation: Readonly<TargetedProviderRetryReservation>;
    outcome: Readonly<DualProviderWriteOutcome>;
  }): Promise<Readonly<DualProviderStorageTruth>> {
    this.retryCompleteCalls += 1;
    const states = input.reservation.providerRole === 'hot'
      ? { hot: input.outcome.state, canonical: this.retryPeerState }
      : { hot: this.retryPeerState, canonical: input.outcome.state };
    const mapping = storageMapping({
      hot: Object.freeze({ state: states.hot, retryable: states.hot === 'failed' }),
      canonical: Object.freeze({ state: states.canonical, retryable: states.canonical === 'failed' }),
    });
    return Object.freeze({
      storageObjectId: input.reservation.storageObjectId,
      storageState: mapping.storageState,
      objectProtectionStage: mapping.objectProtectionStage,
      copies: Object.freeze({
        hot: Object.freeze({ state: states.hot, retryable: states.hot === 'failed' }),
        canonical: Object.freeze({
          state: states.canonical,
          retryable: states.canonical === 'failed',
        }),
      }),
    });
  }
}

class FakeWriter implements ProviderObjectWriter {
  readonly failRoles = new Set<ProviderWriteRole>();
  readonly writes: Array<{ role: ProviderWriteRole; bytes: Uint8Array }> = [];
  readonly cleanups: ProviderWriteRole[] = [];

  async write(input: Readonly<ProviderWriteInput>): Promise<Readonly<ProviderWriteReceipt>> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of input.source) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
    const bytes = join(...chunks);
    this.writes.push({ role: input.target.providerRole, bytes });
    if (this.failRoles.has(input.target.providerRole)) {
      throw new ProviderExecutionError(
        'dependency-unavailable',
        `${input.target.providerRole}-provider-write-failed`,
        true,
        { cleanupRequired: true },
      );
    }
    return Object.freeze({
      providerRole: input.target.providerRole,
      observed: Object.freeze({
        checksumSha256: input.checksumSha256,
        byteLength: input.byteLength,
      }),
      integrityVerification: Object.freeze({
        verified: true,
        checksumVerified: true,
        sizeVerified: true,
        sizeVerificationDisposition: 'matched',
      }),
    });
  }

  async cleanup(input: { target: Readonly<ResolvedProviderWriteTarget> }) {
    this.cleanups.push(input.target.providerRole);
    return Object.freeze({ deleted: true });
  }
}

function ingestInput(bytes: Uint8Array, readCounter: { count: number }): Readonly<ObjectIngestInput> {
  const body: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      readCounter.count += 1;
      yield bytes.slice(0, 7);
      yield bytes.slice(7);
    },
  };
  return Object.freeze({
    objectWriteIntentId: WRITE_INTENT_ID,
    storageObjectId: STORAGE_OBJECT_ID,
    mediaType: 'image/png',
    declaredByteLength: bytes.byteLength,
    declaredChecksumSha256: sha256(bytes),
    body,
    internalLocators: Object.freeze({
      hot: target('hot').internalLocator,
      canonical: target('canonical').internalLocator,
    }),
    intentRowVersion: 2,
    objectRowVersion: 1,
    providerCopies: Object.freeze({
      hot: Object.freeze({
        storageObjectCopyId: HOT_COPY_ID,
        providerBindingId: HOT_BINDING_ID,
        providerRole: 'hot' as const,
        state: 'pending' as const,
        rowVersion: 1,
        internalLocator: target('hot').internalLocator,
      }),
      canonical: Object.freeze({
        storageObjectCopyId: CANONICAL_COPY_ID,
        providerBindingId: CANONICAL_BINDING_ID,
        providerRole: 'canonical' as const,
        state: 'pending' as const,
        rowVersion: 1,
        internalLocator: target('canonical').internalLocator,
      }),
    }),
  });
}

function adapter(registry: FakeRegistry, writer: FakeWriter): DualProviderObjectIngestAdapter {
  return new DualProviderObjectIngestAdapter({
    registry,
    writer,
    mediaVerifier: new BoundedMediaVerifier({ maximumByteLength: 1_024 }),
    resolveTarget: {
      resolve: ({ providerRole }) => target(providerRole),
    },
    createTemporaryId: () => 'deterministic',
  });
}

const MATRIX = [
  {
    name: 'both providers succeed',
    failures: [] as const,
    storageState: 'ready',
    stage: 'canonical-and-hot-verified',
  },
  {
    name: 'hot fails and canonical succeeds',
    failures: ['hot'] as const,
    storageState: 'degraded',
    stage: 'canonical-verified-hot-repair-required',
  },
  {
    name: 'hot succeeds and canonical fails',
    failures: ['canonical'] as const,
    storageState: 'degraded',
    stage: 'hot-verified-canonical-repair-required',
  },
  {
    name: 'both providers fail',
    failures: ['hot', 'canonical'] as const,
    storageState: 'unavailable',
    stage: 'provider-write-failed',
  },
] as const;

for (const scenario of MATRIX) {
  test(`dual-provider outcome matrix: ${scenario.name}`, async () => {
    const bytes = png();
    const registry = new FakeRegistry();
    const writer = new FakeWriter();
    scenario.failures.forEach((role) => writer.failRoles.add(role));
    const reads = { count: 0 };
    const receipt = await adapter(registry, writer).ingest(ingestInput(bytes, reads));
    assert.equal(reads.count, 1, 'incoming body must be consumed exactly once');
    assert.equal(writer.writes.length, 2);
    assert.deepEqual(writer.writes.map((entry) => entry.role).sort(), ['canonical', 'hot']);
    for (const write of writer.writes) assert.deepEqual(write.bytes, bytes);
    assert.equal(receipt.completionResult?.storageState, scenario.storageState);
    assert.equal(receipt.completionResult?.objectProtectionStage, scenario.stage);
    assert.equal(registry.beginCalls, 1);
    assert.equal(registry.completeCalls, 1);
    assert.equal(registry.abortCalls, 0);
    assert.deepEqual(writer.cleanups.sort(), [...scenario.failures].sort());
    const serialized = JSON.stringify(receipt.completionResult);
    for (const prohibited of ['secret-ref', 'hot-assets', 'canonical-assets', 'apps/test/object']) {
      assert.equal(serialized.includes(prohibited), false);
    }
  });
}

test('media verification failure happens before provider work and records a safe abort', async () => {
  const bytes = new TextEncoder().encode('not-media');
  const registry = new FakeRegistry();
  const writer = new FakeWriter();
  const reads = { count: 0 };
  await assert.rejects(adapter(registry, writer).ingest(ingestInput(bytes, reads)));
  assert.equal(reads.count, 1);
  assert.equal(writer.writes.length, 0);
  assert.equal(registry.abortCalls, 1);
});

test('targeted retry writes only the failed role and preserves the verified peer', async () => {
  const registry = new FakeRegistry();
  const writer = new FakeWriter();
  const coordinator = new TargetedProviderRetryCoordinator({
    registry,
    writer,
    resolveTarget: { resolve: ({ providerRole }) => target(providerRole) },
  });
  const result = await coordinator.retry({
    storageObjectId: STORAGE_OBJECT_ID,
    providerRole: 'hot',
    expectedFailedCopyVersion: 2,
    verifiedSource: { open: () => Readable.from([png()]) },
  });
  assert.equal(registry.retryReserveCalls, 1);
  assert.equal(registry.retryCompleteCalls, 1);
  assert.deepEqual(writer.writes.map((entry) => entry.role), ['hot']);
  assert.equal(result.storageState, 'ready');
  assert.equal(result.copies.hot.state, 'verified');
  assert.equal(result.copies.canonical.state, 'verified');
});

test('S3-compatible writer resolves credentials server-side and verifies PUT plus HEAD facts', async () => {
  const checksum = sha256(png());
  const commands: unknown[] = [];
  let resolvedReference = '';
  const writer = new S3CompatibleProviderObjectWriter({
    credentialResolver: {
      resolve: (reference) => {
        resolvedReference = reference;
        return Object.freeze({
          endpoint: 'https://provider.internal',
          region: 'auto',
          forcePathStyle: false,
          accessKeyId: 'private-access-key',
          secretAccessKey: ['private', 'secret', 'key'].join('-'),
        });
      },
    },
    createClient: () => ({
      async send(command: unknown) {
        commands.push(command);
        if (command instanceof HeadObjectCommand) {
          return {
            Metadata: { 'z-s-sha256': checksum },
            ContentLength: png().byteLength,
          };
        }
        return {};
      },
    }),
  });
  const receipt = await writer.write({
    target: target('canonical'),
    source: Readable.from([png()]),
    checksumSha256: checksum,
    byteLength: png().byteLength,
  });
  assert.equal(resolvedReference, 'canonical-secret-ref');
  assert.ok(commands[0] instanceof PutObjectCommand);
  assert.ok(commands[1] instanceof HeadObjectCommand);
  assert.equal(receipt.integrityVerification.verified, true);
  assert.equal(JSON.stringify(receipt).includes('private-secret-key'), false);

  await writer.cleanup({ target: target('canonical') });
  assert.ok(commands[2] instanceof DeleteObjectCommand);
});

test('live-provider handoff harness is explicit, allowlisted, exact-target, and non-CI', async () => {
  const source = await readFile('scripts/verify-2b-06-providers.mjs', 'utf8');
  for (const scenario of [
    'both-success-png',
    'both-success-mp4',
    'hot-write-failure',
    'canonical-write-failure',
    'both-write-failure',
    'checksum-mismatch',
    'required-size-mismatch',
    'hot-targeted-retry',
    'canonical-targeted-retry',
  ]) {
    assert.ok(source.includes(`'${scenario}'`));
  }
  assert.ok(source.includes('--confirm-provider-actions'));
  assert.ok(source.includes('ZS_2B06_PROVIDER_ACTIONS_APPROVED'));
  assert.ok(source.includes('HeadObjectCommand'));
  assert.ok(source.includes('DeleteObjectCommand') === false);
  assert.ok(source.includes('ListObjects') === false);
  assert.ok(source.includes('broadProviderListingPerformed: false'));
  const workflow = await readFile(
    '.github/workflows/2b-06-dual-provider-media-validation.yml',
    'utf8',
  );
  assert.equal(workflow.includes('verify:2b06:providers'), false);
});

