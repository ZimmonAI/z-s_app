import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  BoundedMediaVerifier,
  DualProviderObjectIngestAdapter,
  ProviderExecutionError,
} from '../dist/runtime-service.js';

function u32(value) {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function ascii(value) {
  return Uint8Array.from([...value].map((entry) => entry.charCodeAt(0)));
}

function join(...parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function png() {
  const data = join(u32(2), u32(3), Uint8Array.of(8, 6, 0, 0, 0));
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

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function target(role) {
  return Object.freeze({
    providerRole: role,
    providerId: `${role}-provider`,
    bucketLabel: `${role}-bucket`,
    internalLocator: `apps/harness/object/${role}`,
    normalizedPrefixPattern: 'apps/harness/*',
    capabilityPolicy: Object.freeze({
      checksumVerification: 'required',
      sizeVerification: 'required-when-supported',
      headContentLength: role === 'hot' ? 'optional-with-checksum' : 'required',
      rangeRead: 'optional',
    }),
    credentialSecretReferenceId: `${role}-reference`,
  });
}

function mapping(outcomes) {
  if (outcomes.hot.state === 'verified' && outcomes.canonical.state === 'verified') {
    return ['ready', 'canonical-and-hot-verified'];
  }
  if (outcomes.hot.state === 'failed' && outcomes.canonical.state === 'verified') {
    return ['degraded', 'canonical-verified-hot-repair-required'];
  }
  if (outcomes.hot.state === 'verified' && outcomes.canonical.state === 'failed') {
    return ['degraded', 'hot-verified-canonical-repair-required'];
  }
  return ['unavailable', 'provider-write-failed'];
}

class HarnessRegistry {
  async beginDualProviderWrite(input) {
    return Object.freeze({
      objectWriteIntentId: input.objectWriteIntentId,
      storageObjectId: input.storageObjectId,
      expectedIntentRowVersion: input.expectedIntentRowVersion,
      expectedObjectRowVersion: input.expectedObjectRowVersion,
      attempts: Object.freeze({
        hot: Object.freeze({
          providerAttemptId: '60000000-0000-4000-8000-000000000001',
          storageObjectCopyId: input.copies.hot.storageObjectCopyId,
          expectedCopyRowVersion: input.copies.hot.rowVersion,
        }),
        canonical: Object.freeze({
          providerAttemptId: '60000000-0000-4000-8000-000000000002',
          storageObjectCopyId: input.copies.canonical.storageObjectCopyId,
          expectedCopyRowVersion: input.copies.canonical.rowVersion,
        }),
      }),
    });
  }

  async completeDualProviderWrite(input) {
    const [storageState, objectProtectionStage] = mapping(input.outcomes);
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
      storageState,
      objectProtectionStage,
      verifiedMedia: input.verifiedMedia,
      copies: Object.freeze({
        hot: Object.freeze({
          state: input.outcomes.hot.state,
          retryable: input.outcomes.hot.retryable,
        }),
        canonical: Object.freeze({
          state: input.outcomes.canonical.state,
          retryable: input.outcomes.canonical.retryable,
        }),
      }),
    });
  }

  async abortDualProviderWrite() {}
  async reserveTargetedProviderRetry() {
    throw new Error('not-used');
  }
  async completeTargetedProviderRetry() {
    throw new Error('not-used');
  }
}

class HarnessWriter {
  constructor(failedRoles) {
    this.failedRoles = new Set(failedRoles);
    this.writes = [];
  }

  async write(input) {
    const chunks = [];
    for await (const chunk of input.source) chunks.push(new Uint8Array(chunk));
    const bytes = join(...chunks);
    assert.equal(checksum(bytes), input.checksumSha256);
    assert.equal(bytes.byteLength, input.byteLength);
    this.writes.push(input.target.providerRole);
    if (this.failedRoles.has(input.target.providerRole)) {
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

  async cleanup() {
    return Object.freeze({ deleted: true });
  }
}

async function runScenario(failedRoles) {
  const bytes = png();
  const writer = new HarnessWriter(failedRoles);
  const adapter = new DualProviderObjectIngestAdapter({
    registry: new HarnessRegistry(),
    writer,
    mediaVerifier: new BoundedMediaVerifier({ maximumByteLength: 1024 }),
    resolveTarget: { resolve: ({ providerRole }) => target(providerRole) },
    createTemporaryId: () => 'harness',
  });
  let reads = 0;
  const receipt = await adapter.ingest(Object.freeze({
    objectWriteIntentId: '60000000-0000-4000-8000-000000000003',
    storageObjectId: '60000000-0000-4000-8000-000000000004',
    mediaType: 'image/png',
    declaredByteLength: bytes.byteLength,
    declaredChecksumSha256: checksum(bytes),
    body: {
      async *[Symbol.asyncIterator]() {
        reads += 1;
        yield bytes;
      },
    },
    internalLocators: Object.freeze({
      hot: target('hot').internalLocator,
      canonical: target('canonical').internalLocator,
    }),
    intentRowVersion: 2,
    objectRowVersion: 1,
    providerCopies: Object.freeze({
      hot: Object.freeze({
        storageObjectCopyId: '60000000-0000-4000-8000-000000000005',
        providerBindingId: '60000000-0000-4000-8000-000000000006',
        providerRole: 'hot',
        state: 'pending',
        rowVersion: 1,
        internalLocator: target('hot').internalLocator,
      }),
      canonical: Object.freeze({
        storageObjectCopyId: '60000000-0000-4000-8000-000000000007',
        providerBindingId: '60000000-0000-4000-8000-000000000008',
        providerRole: 'canonical',
        state: 'pending',
        rowVersion: 1,
        internalLocator: target('canonical').internalLocator,
      }),
    }),
  }));
  assert.equal(reads, 1);
  assert.deepEqual(writer.writes.sort(), ['canonical', 'hot']);
  return receipt.completionResult;
}

const ready = await runScenario([]);
assert.equal(ready.storageState, 'ready');
assert.equal(ready.objectProtectionStage, 'canonical-and-hot-verified');
const degraded = await runScenario(['hot']);
assert.equal(degraded.storageState, 'degraded');
assert.equal(degraded.objectProtectionStage, 'canonical-verified-hot-repair-required');

console.log(JSON.stringify({
  schemaVersion: 1,
  packageVersion: '0.4.0',
  bothProvidersVerified: true,
  singleProviderFailureContained: true,
  incomingBodyReadCount: 1,
  safety: {
    secretsRead: false,
    databaseActionsPerformed: false,
    providerActionsPerformed: false,
    browserActionsPerformed: false,
    serviceActionsPerformed: false,
  },
}, null, 2));
