import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  BoundedMediaVerifier,
  DualProviderObjectIngestAdapter,
  ProviderExecutionError,
  S3CompatibleProviderObjectWriter,
  TargetedProviderRetryCoordinator,
} from '../dist/runtime-service.js';

const ROLES = ['hot', 'canonical'];
const SCENARIOS = new Set([
  'both-success-png',
  'both-success-mp4',
  'hot-write-failure',
  'canonical-write-failure',
  'both-write-failure',
  'checksum-mismatch',
  'required-size-mismatch',
  'hot-targeted-retry',
  'canonical-targeted-retry',
]);
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_RUN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/=-]{0,900}\*$/;

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (entry === '--confirm-provider-actions') {
      values.set(entry, 'true');
      continue;
    }
    if (!entry.startsWith('--')) throw new Error('invalid-argument');
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('missing-argument-value');
    values.set(entry, value);
    index += 1;
  }
  return values;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') throw new Error(`missing-${name.toLowerCase()}`);
  return value.trim();
}

function optionalEnvironment(name) {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function booleanEnvironment(name, fallback) {
  const value = optionalEnvironment(name);
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`invalid-${name.toLowerCase()}`);
}

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

function png(width = 2, height = 3) {
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

function box(type, payload) {
  return join(u32(8 + payload.byteLength), ascii(type), payload);
}

function mp4(timescale = 1_000, duration = 2_000) {
  const ftyp = box('ftyp', join(ascii('isom'), u32(0), ascii('mp42')));
  const mvhd = join(Uint8Array.of(0, 0, 0, 0), u32(0), u32(0), u32(timescale), u32(duration));
  return join(ftyp, box('moov', box('mvhd', mvhd)));
}

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeRoleConfiguration(role) {
  const upper = role.toUpperCase();
  const providerAlias = requiredEnvironment(`ZS_2B06_${upper}_PROVIDER_ALIAS`);
  const bucketAlias = requiredEnvironment(`ZS_2B06_${upper}_BUCKET_ALIAS`);
  const prefixPattern = requiredEnvironment(`ZS_2B06_${upper}_PREFIX_PATTERN`);
  if (!SAFE_ID_PATTERN.test(providerAlias)) throw new Error(`invalid-${role}-provider-alias`);
  if (!SAFE_ID_PATTERN.test(bucketAlias)) throw new Error(`invalid-${role}-bucket-alias`);
  if (!SAFE_PREFIX_PATTERN.test(prefixPattern) || prefixPattern.includes('..')) {
    throw new Error(`invalid-${role}-prefix-pattern`);
  }
  return Object.freeze({
    providerAlias,
    bucketAlias,
    bucket: requiredEnvironment(`ZS_2B06_${upper}_BUCKET`),
    prefixPattern,
    credentialReference: `2b06-${role}-provider-binding`,
    binding: Object.freeze({
      endpoint: requiredEnvironment(`ZS_2B06_${upper}_ENDPOINT`),
      region: requiredEnvironment(`ZS_2B06_${upper}_REGION`),
      forcePathStyle: booleanEnvironment(`ZS_2B06_${upper}_FORCE_PATH_STYLE`, false),
      accessKeyId: requiredEnvironment(`ZS_2B06_${upper}_ACCESS_KEY_ID`),
      secretAccessKey: requiredEnvironment(`ZS_2B06_${upper}_SECRET_ACCESS_KEY`),
      ...(optionalEnvironment(`ZS_2B06_${upper}_SESSION_TOKEN`) === undefined
        ? {}
        : { sessionToken: optionalEnvironment(`ZS_2B06_${upper}_SESSION_TOKEN`) }),
    }),
  });
}

function targetFor(configuration, role, locator, requireSize) {
  return Object.freeze({
    providerRole: role,
    providerId: configuration.providerAlias,
    bucketLabel: configuration.bucket,
    internalLocator: locator,
    normalizedPrefixPattern: configuration.prefixPattern,
    capabilityPolicy: Object.freeze({
      checksumVerification: 'required',
      sizeVerification: 'required-when-supported',
      headContentLength: requireSize ? 'required' : 'optional-with-checksum',
      rangeRead: 'optional',
    }),
    credentialSecretReferenceId: configuration.credentialReference,
  });
}

function httpStatus(error) {
  if (error === null || typeof error !== 'object') return undefined;
  const metadata = error.$metadata;
  return metadata !== null && typeof metadata === 'object' && typeof metadata.httpStatusCode === 'number'
    ? metadata.httpStatusCode
    : undefined;
}

function isAbsent(error) {
  if (httpStatus(error) === 404) return true;
  if (error === null || typeof error !== 'object') return false;
  return error.name === 'NotFound' || error.name === 'NoSuchKey';
}

function sdkConfiguration(binding) {
  return {
    endpoint: binding.endpoint,
    region: binding.region,
    forcePathStyle: binding.forcePathStyle,
    credentials: {
      accessKeyId: binding.accessKeyId,
      secretAccessKey: binding.secretAccessKey,
      ...(binding.sessionToken === undefined ? {} : { sessionToken: binding.sessionToken }),
    },
  };
}

function createObservedMutationClient(binding, mutation) {
  const client = new S3Client(sdkConfiguration(binding));
  return {
    async send(command) {
      const result = await client.send(command);
      if (!(command instanceof HeadObjectCommand) || mutation === undefined) return result;
      if (mutation === 'checksum') {
        return {
          ...result,
          Metadata: {
            ...(result.Metadata ?? {}),
            'z-s-sha256': '0'.repeat(64),
          },
        };
      }
      const observed = typeof result.ContentLength === 'number' ? result.ContentLength : 0;
      return { ...result, ContentLength: observed + 1 };
    },
    destroy() {
      client.destroy();
    },
  };
}

function storageMapping(outcomes) {
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

class HandoffRegistry {
  constructor(targets) {
    this.targets = targets;
    this.lastOutcomes = undefined;
    this.checksumSha256 = undefined;
    this.byteLength = undefined;
  }

  async beginDualProviderWrite(input) {
    return Object.freeze({
      objectWriteIntentId: input.objectWriteIntentId,
      storageObjectId: input.storageObjectId,
      expectedIntentRowVersion: input.expectedIntentRowVersion,
      expectedObjectRowVersion: input.expectedObjectRowVersion,
      attempts: Object.freeze({
        hot: Object.freeze({
          providerAttemptId: randomUUID(),
          storageObjectCopyId: input.copies.hot.storageObjectCopyId,
          expectedCopyRowVersion: input.copies.hot.rowVersion,
        }),
        canonical: Object.freeze({
          providerAttemptId: randomUUID(),
          storageObjectCopyId: input.copies.canonical.storageObjectCopyId,
          expectedCopyRowVersion: input.copies.canonical.rowVersion,
        }),
      }),
    });
  }

  async completeDualProviderWrite(input) {
    this.lastOutcomes = input.outcomes;
    this.checksumSha256 = input.checksumSha256;
    this.byteLength = input.byteLength;
    const [storageState, objectProtectionStage] = storageMapping(input.outcomes);
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
          ...(input.outcomes.hot.diagnostic === undefined
            ? {}
            : { diagnostic: input.outcomes.hot.diagnostic }),
        }),
        canonical: Object.freeze({
          state: input.outcomes.canonical.state,
          retryable: input.outcomes.canonical.retryable,
          ...(input.outcomes.canonical.diagnostic === undefined
            ? {}
            : { diagnostic: input.outcomes.canonical.diagnostic }),
        }),
      }),
    });
  }

  async abortDualProviderWrite() {}

  async reserveTargetedProviderRetry(input) {
    if (this.lastOutcomes === undefined || this.checksumSha256 === undefined || this.byteLength === undefined) {
      throw new Error('retry-state-unavailable');
    }
    if (this.lastOutcomes[input.providerRole].state !== 'failed') {
      throw new Error('retry-role-not-failed');
    }
    const target = this.targets[input.providerRole];
    return Object.freeze({
      storageObjectId: input.storageObjectId,
      providerRole: input.providerRole,
      providerBindingId: randomUUID(),
      internalLocator: target.internalLocator,
      providerAttemptId: randomUUID(),
      storageObjectCopyId: randomUUID(),
      expectedPendingCopyVersion: input.expectedFailedCopyVersion + 1,
      expectedObjectRowVersion: 2,
      checksumSha256: this.checksumSha256,
      byteLength: this.byteLength,
    });
  }

  async completeTargetedProviderRetry(input) {
    const outcomes = {
      ...this.lastOutcomes,
      [input.reservation.providerRole]: input.outcome,
    };
    this.lastOutcomes = outcomes;
    const [storageState, objectProtectionStage] = storageMapping(outcomes);
    return Object.freeze({
      storageObjectId: input.reservation.storageObjectId,
      storageState,
      objectProtectionStage,
      copies: Object.freeze({
        hot: Object.freeze({
          state: outcomes.hot.state,
          retryable: outcomes.hot.retryable,
        }),
        canonical: Object.freeze({
          state: outcomes.canonical.state,
          retryable: outcomes.canonical.retryable,
        }),
      }),
    });
  }
}

class ScenarioWriter {
  constructor(writers, failures) {
    this.writers = writers;
    this.failures = failures;
    this.attempts = { hot: 0, canonical: 0 };
  }

  async write(input) {
    const role = input.target.providerRole;
    this.attempts[role] += 1;
    if ((this.failures[role] ?? 0) > 0) {
      this.failures[role] -= 1;
      throw new ProviderExecutionError(
        'dependency-unavailable',
        `${role}-provider-write-injected-failure`,
        true,
      );
    }
    return this.writers[role].write(input);
  }

  async cleanup(input) {
    return this.writers[input.target.providerRole].cleanup(input);
  }
}

function safeCopy(copy) {
  return {
    state: copy.state,
    retryable: copy.retryable,
    ...(copy.diagnostic === undefined
      ? {}
      : { diagnostic: { category: copy.diagnostic.category, code: copy.diagnostic.code } }),
  };
}

async function verifyExactAbsence(configuration, target) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const client = new S3Client(sdkConfiguration(configuration.binding));
    try {
      await client.send(new HeadObjectCommand({
        Bucket: target.bucketLabel,
        Key: target.internalLocator,
      }));
    } catch (error) {
      if (isAbsent(error)) return true;
      throw new ProviderExecutionError('dependency-unavailable', 'provider-cleanup-verification-failed', true);
    } finally {
      client.destroy();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function expectedState(scenario) {
  if (scenario.startsWith('both-success') || scenario.endsWith('targeted-retry')) {
    return ['ready', 'canonical-and-hot-verified'];
  }
  if (scenario === 'both-write-failure') return ['unavailable', 'provider-write-failed'];
  if (scenario === 'hot-write-failure') {
    return ['degraded', 'canonical-verified-hot-repair-required'];
  }
  return ['degraded', 'hot-verified-canonical-repair-required'];
}

function prohibitedValues(configurations, targets) {
  const values = [];
  for (const role of ROLES) {
    const configuration = configurations[role];
    values.push(
      configuration.bucket,
      configuration.binding.endpoint,
      configuration.binding.accessKeyId,
      configuration.binding.secretAccessKey,
      configuration.binding.sessionToken,
      configuration.credentialReference,
      targets[role].internalLocator,
    );
  }
  return values.filter((value) => typeof value === 'string' && value.length >= 4);
}

async function main() {
  const argumentsMap = parseArguments(process.argv.slice(2));
  const runId = argumentsMap.get('--run-id');
  const scenario = argumentsMap.get('--scenario');
  if (!SAFE_RUN_PATTERN.test(runId ?? '')) throw new Error('invalid-run-id');
  if (!SCENARIOS.has(scenario)) throw new Error('scenario-not-allowlisted');
  if (argumentsMap.get('--confirm-provider-actions') !== 'true') {
    throw new Error('provider-actions-not-confirmed');
  }
  if (process.env.ZS_2B06_PROVIDER_ACTIONS_APPROVED !== 'true') {
    throw new Error('provider-actions-not-approved');
  }

  const configurations = Object.freeze({
    hot: safeRoleConfiguration('hot'),
    canonical: safeRoleConfiguration('canonical'),
  });
  const suffix = `${runId}/${scenario}/${randomUUID()}`;
  const extension = scenario === 'both-success-mp4' ? 'mp4' : 'png';
  const targets = Object.freeze(Object.fromEntries(ROLES.map((role) => {
    const prefix = configurations[role].prefixPattern.slice(0, -1);
    const locator = `${prefix}2b-06/${suffix}.${extension}`;
    const requireSize = role === 'canonical' || scenario === 'required-size-mismatch';
    return [role, targetFor(configurations[role], role, locator, requireSize)];
  })));

  const media = scenario === 'both-success-mp4'
    ? { mediaType: 'video/mp4', bytes: mp4() }
    : { mediaType: 'image/png', bytes: png() };
  const checksumSha256 = checksum(media.bytes);
  const mutations = {
    hot: undefined,
    canonical: scenario === 'checksum-mismatch'
      ? 'checksum'
      : scenario === 'required-size-mismatch'
        ? 'size'
        : undefined,
  };
  const credentialResolver = {
    resolve(reference) {
      for (const role of ROLES) {
        if (configurations[role].credentialReference === reference) {
          return configurations[role].binding;
        }
      }
      throw new Error('credential-reference-not-allowlisted');
    },
  };
  const writers = Object.freeze(Object.fromEntries(ROLES.map((role) => [
    role,
    new S3CompatibleProviderObjectWriter({
      credentialResolver,
      createClient: () => createObservedMutationClient(configurations[role].binding, mutations[role]),
    }),
  ])));
  const failures = {
    hot: ['hot-write-failure', 'both-write-failure', 'hot-targeted-retry'].includes(scenario) ? 1 : 0,
    canonical: ['canonical-write-failure', 'both-write-failure', 'canonical-targeted-retry'].includes(scenario) ? 1 : 0,
  };
  const writer = new ScenarioWriter(writers, failures);
  const registry = new HandoffRegistry(targets);
  const resolver = { resolve: ({ providerRole }) => targets[providerRole] };
  const adapter = new DualProviderObjectIngestAdapter({
    registry,
    writer,
    mediaVerifier: new BoundedMediaVerifier({
      maximumByteLength: 1_048_576,
      maximumImagePixels: 1_000_000,
    }),
    resolveTarget: resolver,
  });
  const reads = { count: 0 };
  const storageObjectId = randomUUID();
  let result;
  let retryResult;
  const cleanup = { requested: 0, verifiedAbsent: 0 };

  try {
    const receipt = await adapter.ingest(Object.freeze({
      objectWriteIntentId: randomUUID(),
      storageObjectId,
      mediaType: media.mediaType,
      declaredByteLength: media.bytes.byteLength,
      declaredChecksumSha256: checksumSha256,
      body: {
        async *[Symbol.asyncIterator]() {
          reads.count += 1;
          yield media.bytes;
        },
      },
      internalLocators: Object.freeze({
        hot: targets.hot.internalLocator,
        canonical: targets.canonical.internalLocator,
      }),
      intentRowVersion: 1,
      objectRowVersion: 1,
      providerCopies: Object.freeze({
        hot: Object.freeze({
          storageObjectCopyId: randomUUID(),
          providerBindingId: randomUUID(),
          providerRole: 'hot',
          state: 'pending',
          rowVersion: 1,
          internalLocator: targets.hot.internalLocator,
        }),
        canonical: Object.freeze({
          storageObjectCopyId: randomUUID(),
          providerBindingId: randomUUID(),
          providerRole: 'canonical',
          state: 'pending',
          rowVersion: 1,
          internalLocator: targets.canonical.internalLocator,
        }),
      }),
    }));
    result = receipt.completionResult;
    assert.ok(result !== undefined);
    assert.equal(reads.count, 1);

    if (scenario.endsWith('targeted-retry')) {
      const role = scenario.startsWith('hot') ? 'hot' : 'canonical';
      const peer = role === 'hot' ? 'canonical' : 'hot';
      const peerAttemptsBefore = writer.attempts[peer];
      const coordinator = new TargetedProviderRetryCoordinator({ registry, writer, resolveTarget: resolver });
      retryResult = await coordinator.retry({
        storageObjectId,
        providerRole: role,
        expectedFailedCopyVersion: 1,
        verifiedSource: { open: () => Readable.from([media.bytes]) },
      });
      assert.equal(writer.attempts[peer], peerAttemptsBefore, 'verified peer must not be rewritten');
    }

    const finalState = retryResult ?? result;
    const [expectedStorageState, expectedStage] = expectedState(scenario);
    assert.equal(finalState.storageState, expectedStorageState);
    assert.equal(finalState.objectProtectionStage, expectedStage);
  } finally {
    for (const role of ROLES) {
      cleanup.requested += 1;
      const deletion = await writer.cleanup({ target: targets[role] });
      if (!deletion.deleted) throw new Error(`${role}-cleanup-failed`);
      if (await verifyExactAbsence(configurations[role], targets[role])) {
        cleanup.verifiedAbsent += 1;
      }
    }
  }

  assert.equal(cleanup.verifiedAbsent, 2, 'every exact handoff target must be absent');
  const finalState = retryResult ?? result;
  const output = {
    schemaVersion: 1,
    packageVersion: '0.4.0',
    runId,
    scenario,
    media: finalState.verifiedMedia ?? result.verifiedMedia,
    checksumDisposition: result.integrityVerification.sizeVerificationDisposition,
    byteLength: result.byteLength,
    storageState: finalState.storageState,
    objectProtectionStage: finalState.objectProtectionStage,
    providers: Object.fromEntries(ROLES.map((role) => [role, {
      providerAlias: configurations[role].providerAlias,
      bucketAlias: configurations[role].bucketAlias,
      writeAttempts: writer.attempts[role],
      copy: safeCopy(finalState.copies[role]),
    }])),
    incomingBodyReadCount: reads.count,
    cleanup,
    safety: {
      databaseActionsPerformed: false,
      deploymentActionsPerformed: false,
      browserActionsPerformed: false,
      broadProviderListingPerformed: false,
      exactTargetsOnly: true,
    },
  };
  const serialized = JSON.stringify(output, null, 2);
  for (const prohibited of prohibitedValues(configurations, targets)) {
    if (serialized.includes(prohibited)) throw new Error('unsafe-output-detected');
  }
  console.log(serialized);
}

main().catch((error) => {
  const code = error instanceof ProviderExecutionError
    ? error.code
    : error instanceof Error && /^[a-z0-9-]+$/.test(error.message)
      ? error.message
      : 'provider-handoff-failed';
  console.error(JSON.stringify({ schemaVersion: 1, status: 'failed', code }));
  process.exitCode = 1;
});
