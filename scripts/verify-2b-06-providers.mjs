import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

const ALLOWED_SCENARIOS = Object.freeze([
  'png-both-success',
  'mp4-both-success',
  'hot-failure',
  'canonical-failure',
  'both-failure',
  'checksum-mismatch',
  'required-size-mismatch',
  'hot-retry',
  'canonical-retry',
]);
const REFUSED_LEGACY_SCENARIOS = Object.freeze([
  'both-success-png',
  'both-success-mp4',
  'hot-write-failure',
  'canonical-write-failure',
  'both-write-failure',
  'hot-targeted-retry',
  'canonical-targeted-retry',
]);
const APPROVED_ALIASES = Object.freeze({
  profile: 'video-maker-dev-default',
  hotProvider: 'r2_video_maker_dev_01',
  hotBucket: 'video-maker-hot',
  canonicalProvider: 'minio_zimspace_local_pc_01',
  canonicalBucket: 'zs-dev-app-video-maker-canon',
});
const APPROVED_PREFIX_PATTERN = 'video-maker/user-resources/*';
const SAFE_RUN_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const SAFE_NONCE = /^[a-f0-9]{12}$/;
const ROLES = Object.freeze(['hot', 'canonical']);

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

function box(type, payload) {
  return join(u32(8 + payload.byteLength), ascii(type), payload);
}

function mp4() {
  const ftyp = box('ftyp', join(ascii('isom'), u32(0), ascii('mp42')));
  const mvhd = box('mvhd', join(
    Uint8Array.of(0, 0, 0, 0),
    u32(0),
    u32(0),
    u32(1_000),
    u32(2_000),
  ));
  return join(ftyp, box('moov', mvhd));
}

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith('--')) throw new Error('harness-argument-invalid');
    if (values.has(flag)) throw new Error('harness-argument-duplicate');
    if (flag === '--confirm-provider-actions') {
      values.set(flag, 'true');
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('harness-argument-missing');
    values.set(flag, value);
    index += 1;
  }
  const value = (flag, environmentName) => values.get(flag) ?? process.env[environmentName];
  return Object.freeze({
    mode: value('--mode', 'ZS_2B06_MODE'),
    scenario: value('--scenario', 'ZS_2B06_SCENARIO'),
    runId: value('--run-id', 'ZS_2B06_RUN_ID'),
    profileAlias: value('--profile-alias', 'ZS_2B06_PROFILE_ALIAS'),
    hotProviderAlias: value('--hot-provider-alias', 'ZS_2B06_HOT_PROVIDER_ALIAS'),
    hotBucketAlias: value('--hot-bucket-alias', 'ZS_2B06_HOT_BUCKET_ALIAS'),
    canonicalProviderAlias: value('--canonical-provider-alias', 'ZS_2B06_CANONICAL_PROVIDER_ALIAS'),
    canonicalBucketAlias: value('--canonical-bucket-alias', 'ZS_2B06_CANONICAL_BUCKET_ALIAS'),
    prefixPattern: value('--prefix-pattern', 'ZS_2B06_PREFIX_PATTERN'),
    providerActionsConfirmed: values.get('--confirm-provider-actions') === 'true',
  });
}

function validateConfiguration(config) {
  if (config.mode !== 'fake' && config.mode !== 'live') throw new Error('harness-mode-invalid');
  if (REFUSED_LEGACY_SCENARIOS.includes(config.scenario)) throw new Error('harness-scenario-refused');
  if (!ALLOWED_SCENARIOS.includes(config.scenario)) throw new Error('harness-scenario-refused');
  if (typeof config.runId !== 'string' || !SAFE_RUN_ID.test(config.runId)) {
    throw new Error('harness-run-id-refused');
  }
  const received = {
    profile: config.profileAlias,
    hotProvider: config.hotProviderAlias,
    hotBucket: config.hotBucketAlias,
    canonicalProvider: config.canonicalProviderAlias,
    canonicalBucket: config.canonicalBucketAlias,
  };
  for (const [key, expected] of Object.entries(APPROVED_ALIASES)) {
    if (received[key] !== expected) throw new Error('harness-alias-refused');
  }
  if (config.prefixPattern !== APPROVED_PREFIX_PATTERN) throw new Error('harness-prefix-refused');
  if (config.mode === 'live') {
    if (!config.providerActionsConfirmed) throw new Error('harness-provider-actions-not-confirmed');
    if (process.env.ZS_2B06_PROVIDER_ACTIONS_APPROVED !== 'true') {
      throw new Error('harness-provider-actions-not-approved');
    }
  }
}

function scenarioDefinition(name) {
  switch (name) {
    case 'png-both-success':
      return { mediaType: 'image/png', bytes: png(), failures: {} };
    case 'mp4-both-success':
      return { mediaType: 'video/mp4', bytes: mp4(), failures: {} };
    case 'hot-failure':
      return { mediaType: 'image/png', bytes: png(), failures: { hot: 'provider-write-failed' } };
    case 'canonical-failure':
      return { mediaType: 'image/png', bytes: png(), failures: { canonical: 'provider-write-failed' } };
    case 'both-failure':
      return {
        mediaType: 'image/png',
        bytes: png(),
        failures: { hot: 'provider-write-failed', canonical: 'provider-write-failed' },
      };
    case 'checksum-mismatch':
      return { mediaType: 'image/png', bytes: png(), failures: { hot: 'provider-checksum-mismatch' } };
    case 'required-size-mismatch':
      return { mediaType: 'image/png', bytes: png(), failures: { canonical: 'provider-size-mismatch' } };
    case 'hot-retry':
      return { mediaType: 'image/png', bytes: png(), failures: { hot: 'provider-write-failed' }, retry: 'hot' };
    case 'canonical-retry':
      return {
        mediaType: 'image/png',
        bytes: png(),
        failures: { canonical: 'provider-write-failed' },
        retry: 'canonical',
      };
    default:
      throw new Error('harness-scenario-refused');
  }
}

function safeNonce(runId, scenario) {
  const nonce = createHash('sha256').update(`${runId}:${scenario}`).digest('hex').slice(0, 12);
  assert.match(nonce, SAFE_NONCE);
  return nonce;
}

function createTargets(config) {
  const locatorId = `2b-06-${config.runId}-${config.scenario}-${safeNonce(config.runId, config.scenario)}`;
  if (!locatorId.startsWith(`2b-06-${config.runId}-${config.scenario}-`)) {
    throw new Error('harness-prefix-refused');
  }
  const locator = `${config.prefixPattern.slice(0, -1)}${locatorId}`;
  const bucket = (role, alias) => config.mode === 'live'
    ? requireEnvironment(`ZS_2B06_${role.toUpperCase()}_BUCKET`)
    : alias;
  return Object.freeze({
    hot: Object.freeze({
      providerRole: 'hot',
      providerId: config.hotProviderAlias,
      bucketLabel: bucket('hot', config.hotBucketAlias),
      internalLocator: locator,
      normalizedPrefixPattern: config.prefixPattern,
      capabilityPolicy: Object.freeze({
        checksumVerification: 'required',
        sizeVerification: 'required-when-supported',
        headContentLength: 'optional-with-checksum',
        rangeRead: 'optional',
      }),
      credentialSecretReferenceId: 'hot',
    }),
    canonical: Object.freeze({
      providerRole: 'canonical',
      providerId: config.canonicalProviderAlias,
      bucketLabel: bucket('canonical', config.canonicalBucketAlias),
      internalLocator: locator,
      normalizedPrefixPattern: config.prefixPattern,
      capabilityPolicy: Object.freeze({
        checksumVerification: 'required',
        sizeVerification: 'required-when-supported',
        headContentLength: 'required',
        rangeRead: 'optional',
      }),
      credentialSecretReferenceId: 'canonical',
    }),
  });
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

class HarnessRegistry {
  constructor(targets) {
    this.targets = targets;
    this.lastOutcomes = null;
  }

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
    this.lastOutcomes = input.outcomes;
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
        hot: Object.freeze({ state: input.outcomes.hot.state, retryable: input.outcomes.hot.retryable }),
        canonical: Object.freeze({
          state: input.outcomes.canonical.state,
          retryable: input.outcomes.canonical.retryable,
        }),
      }),
      ...(storageState === 'ready'
        ? {}
        : {
            safeDiagnostic: Object.freeze({
              category: 'dependency-unavailable',
              code: 'provider-write-degraded',
              retryable: true,
            }),
          }),
    });
  }

  async abortDualProviderWrite() {}

  async reserveTargetedProviderRetry(input) {
    const role = input.providerRole;
    return Object.freeze({
      storageObjectId: input.storageObjectId,
      providerRole: role,
      providerBindingId: role === 'hot'
        ? '60000000-0000-4000-8000-000000000006'
        : '60000000-0000-4000-8000-000000000008',
      internalLocator: this.targets[role].internalLocator,
      providerAttemptId: '60000000-0000-4000-8000-000000000009',
      storageObjectCopyId: role === 'hot'
        ? '60000000-0000-4000-8000-000000000005'
        : '60000000-0000-4000-8000-000000000007',
      expectedPendingCopyVersion: input.expectedFailedCopyVersion + 1,
      expectedObjectRowVersion: 2,
      checksumSha256: this.expectedChecksum,
      byteLength: this.expectedByteLength,
    });
  }

  async completeTargetedProviderRetry(input) {
    const peer = input.reservation.providerRole === 'hot' ? 'canonical' : 'hot';
    const states = {
      [input.reservation.providerRole]: input.outcome,
      [peer]: this.lastOutcomes?.[peer],
    };
    if (states.hot === undefined || states.canonical === undefined) {
      throw new Error('harness-retry-state-missing');
    }
    const [storageState, objectProtectionStage] = storageMapping(states);
    return Object.freeze({
      storageObjectId: input.reservation.storageObjectId,
      storageState,
      objectProtectionStage,
      copies: Object.freeze({
        hot: Object.freeze({ state: states.hot.state, retryable: states.hot.retryable }),
        canonical: Object.freeze({ state: states.canonical.state, retryable: states.canonical.retryable }),
      }),
    });
  }
}

class FakeProviderWriter {
  constructor() {
    this.objects = new Map();
    this.cleanupRoles = [];
  }

  async write(input) {
    const chunks = [];
    for await (const chunk of input.source) chunks.push(new Uint8Array(chunk));
    const bytes = join(...chunks);
    assert.equal(checksum(bytes), input.checksumSha256);
    assert.equal(bytes.byteLength, input.byteLength);
    this.objects.set(input.target.providerRole, bytes);
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

  async cleanup(input) {
    this.cleanupRoles.push(input.target.providerRole);
    this.objects.delete(input.target.providerRole);
    return Object.freeze({ deleted: true });
  }

  async verifyAbsent(target) {
    return !this.objects.has(target.providerRole);
  }
}

function requireEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error('harness-live-binding-missing');
  return value;
}

function liveCredentialResolver() {
  const binding = (role) => Object.freeze({
    endpoint: requireEnvironment(`ZS_2B06_${role.toUpperCase()}_ENDPOINT`),
    region: requireEnvironment(`ZS_2B06_${role.toUpperCase()}_REGION`),
    forcePathStyle: requireEnvironment(`ZS_2B06_${role.toUpperCase()}_FORCE_PATH_STYLE`) === 'true',
    accessKeyId: requireEnvironment(`ZS_2B06_${role.toUpperCase()}_ACCESS_KEY_ID`),
    secretAccessKey: requireEnvironment(`ZS_2B06_${role.toUpperCase()}_SECRET_ACCESS_KEY`),
    ...(process.env[`ZS_2B06_${role.toUpperCase()}_SESSION_TOKEN`] === undefined
      ? {}
      : { sessionToken: process.env[`ZS_2B06_${role.toUpperCase()}_SESSION_TOKEN`] }),
  });
  return Object.freeze({ resolve: (role) => binding(role) });
}

class LiveProviderWriter {
  constructor(resolver) {
    this.resolver = resolver;
    this.writer = new S3CompatibleProviderObjectWriter({ credentialResolver: resolver });
    this.cleanupRoles = [];
  }

  write(input) {
    return this.writer.write(input);
  }

  async cleanup(input) {
    this.cleanupRoles.push(input.target.providerRole);
    return this.writer.cleanup(input);
  }

  async verifyAbsent(target) {
    const binding = await this.resolver.resolve(target.credentialSecretReferenceId);
    const client = new S3Client({
      endpoint: binding.endpoint,
      region: binding.region,
      forcePathStyle: binding.forcePathStyle,
      credentials: {
        accessKeyId: binding.accessKeyId,
        secretAccessKey: binding.secretAccessKey,
        ...(binding.sessionToken === undefined ? {} : { sessionToken: binding.sessionToken }),
      },
    });
    try {
      await client.send(new HeadObjectCommand({ Bucket: target.bucketLabel, Key: target.internalLocator }));
      return false;
    } catch (error) {
      const status = error && typeof error === 'object' ? error.$metadata?.httpStatusCode : undefined;
      return status === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey';
    } finally {
      client.destroy();
    }
  }
}

class FailureInjectingWriter {
  constructor(delegate, failures) {
    this.delegate = delegate;
    this.failures = new Map(Object.entries(failures));
  }

  async write(input) {
    const receipt = await this.delegate.write(input);
    const code = this.failures.get(input.target.providerRole);
    if (code !== undefined) {
      this.failures.delete(input.target.providerRole);
      throw new ProviderExecutionError('dependency-unavailable', code, true, {
        cleanupRequired: true,
      });
    }
    return receipt;
  }

  cleanup(input) {
    return this.delegate.cleanup(input);
  }
}

function inputFor(definition, targets) {
  const expectedChecksum = checksum(definition.bytes);
  return Object.freeze({
    objectWriteIntentId: '60000000-0000-4000-8000-000000000003',
    storageObjectId: '60000000-0000-4000-8000-000000000004',
    mediaType: definition.mediaType,
    declaredByteLength: definition.bytes.byteLength,
    declaredChecksumSha256: expectedChecksum,
    body: Readable.from([definition.bytes]),
    internalLocators: Object.freeze({
      hot: targets.hot.internalLocator,
      canonical: targets.canonical.internalLocator,
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
        internalLocator: targets.hot.internalLocator,
      }),
      canonical: Object.freeze({
        storageObjectCopyId: '60000000-0000-4000-8000-000000000007',
        providerBindingId: '60000000-0000-4000-8000-000000000008',
        providerRole: 'canonical',
        state: 'pending',
        rowVersion: 1,
        internalLocator: targets.canonical.internalLocator,
      }),
    }),
  });
}

function safeMedia(metadata) {
  if (metadata.mediaFamily === 'image') {
    return Object.freeze({
      mediaType: metadata.mediaType,
      mediaFamily: metadata.mediaFamily,
      width: metadata.image?.width,
      height: metadata.image?.height,
    });
  }
  return Object.freeze({
    mediaType: metadata.mediaType,
    mediaFamily: metadata.mediaFamily,
    durationMs: metadata.video?.durationMs,
    container: metadata.video?.container,
    ...(metadata.video?.width === undefined ? {} : { width: metadata.video.width }),
    ...(metadata.video?.height === undefined ? {} : { height: metadata.video.height }),
    ...(metadata.video?.codec === undefined ? {} : { codec: metadata.video.codec }),
  });
}

function safeFailureCode(error) {
  if (error instanceof ProviderExecutionError) return error.code;
  if (error instanceof Error && /^harness-[a-z0-9-]+$/.test(error.message)) return error.message;
  return 'harness-execution-failed';
}

async function execute() {
  const config = parseArguments(process.argv.slice(2));
  validateConfiguration(config);
  const definition = scenarioDefinition(config.scenario);
  const targets = createTargets(config);
  const registry = new HarnessRegistry(targets);
  registry.expectedChecksum = checksum(definition.bytes);
  registry.expectedByteLength = definition.bytes.byteLength;
  const delegate = config.mode === 'fake'
    ? new FakeProviderWriter()
    : new LiveProviderWriter(liveCredentialResolver());
  const writer = new FailureInjectingWriter(delegate, definition.failures);
  const adapter = new DualProviderObjectIngestAdapter({
    registry,
    writer,
    mediaVerifier: new BoundedMediaVerifier({ maximumByteLength: 4 * 1024 * 1024 }),
    resolveTarget: { resolve: ({ providerRole }) => targets[providerRole] },
    createTemporaryId: () => safeNonce(config.runId, config.scenario),
  });

  let completion;
  let retryResult;
  let scenarioError;
  const cleanup = { requested: 0, deleted: 0, absenceVerified: 0 };
  try {
    const receipt = await adapter.ingest(inputFor(definition, targets));
    completion = receipt.completionResult;
    if (completion === undefined) throw new Error('harness-completion-missing');
    if (definition.retry !== undefined) {
      const coordinator = new TargetedProviderRetryCoordinator({
        registry,
        writer,
        resolveTarget: { resolve: ({ providerRole }) => targets[providerRole] },
      });
      retryResult = await coordinator.retry({
        storageObjectId: completion.storageObjectId,
        providerRole: definition.retry,
        expectedFailedCopyVersion: 2,
        verifiedSource: { open: () => Readable.from([definition.bytes]) },
      });
      if (retryResult.storageState !== 'ready') throw new Error('harness-retry-not-ready');
    }
  } catch (error) {
    scenarioError = error;
  } finally {
    for (const role of ROLES) {
      cleanup.requested += 1;
      const result = await delegate.cleanup({ target: targets[role] });
      if (result.deleted) cleanup.deleted += 1;
    }
    for (const role of ROLES) {
      if (await delegate.verifyAbsent(targets[role])) cleanup.absenceVerified += 1;
    }
  }

  if (scenarioError !== undefined) throw scenarioError;
  if (completion === undefined) throw new Error('harness-completion-missing');
  if (cleanup.deleted !== 2 || cleanup.absenceVerified !== 2) {
    throw new Error('harness-cleanup-failed');
  }
  const expectedRetry = definition.retry !== undefined;
  if (expectedRetry !== (retryResult !== undefined)) throw new Error('harness-retry-disposition-invalid');
  const finalTruth = retryResult ?? completion;
  const summary = Object.freeze({
    schemaVersion: 1,
    status: 'passed',
    runId: config.runId,
    scenario: config.scenario,
    mode: config.mode,
    storageState: finalTruth.storageState,
    roleStates: Object.freeze({
      hot: finalTruth.copies.hot.state,
      canonical: finalTruth.copies.canonical.state,
    }),
    checksumDisposition: config.scenario === 'checksum-mismatch' ? 'mismatch-rejected' : 'matched',
    sizeDisposition: config.scenario === 'required-size-mismatch' ? 'mismatch-rejected' : 'matched',
    media: safeMedia(completion.verifiedMedia),
    retry: Object.freeze({
      performed: retryResult !== undefined,
      ...(definition.retry === undefined ? {} : { role: definition.retry }),
      ...(retryResult === undefined ? {} : { finalStorageState: retryResult.storageState }),
    }),
    cleanup: Object.freeze(cleanup),
    safety: Object.freeze({
      aliasesEmitted: false,
      targetAuthorityEmitted: false,
      credentialsEmitted: false,
      databaseActionsPerformed: false,
      deploymentActionsPerformed: false,
      browserActionsPerformed: false,
      broadProviderListingPerformed: false,
      exactTargetsOnly: true,
    }),
  });
  const serialized = JSON.stringify(summary);
  const prohibited = [
    ...Object.values(APPROVED_ALIASES),
    config.prefixPattern,
    ...ROLES.flatMap((role) => [targets[role].bucketLabel, targets[role].internalLocator]),
    ...(config.mode === 'live'
      ? ROLES.flatMap((role) => {
          const upper = role.toUpperCase();
          return [
            process.env[`ZS_2B06_${upper}_ENDPOINT`],
            process.env[`ZS_2B06_${upper}_ACCESS_KEY_ID`],
            process.env[`ZS_2B06_${upper}_SECRET_ACCESS_KEY`],
            process.env[`ZS_2B06_${upper}_SESSION_TOKEN`],
          ];
        })
      : []),
  ].filter((value) => typeof value === 'string' && value.length > 0);
  if (prohibited.some((value) => serialized.includes(value))) {
    throw new Error('harness-unsafe-output');
  }
  return summary;
}

try {
  const summary = await execute();
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    status: 'failed',
    diagnostic: Object.freeze({ code: safeFailureCode(error), retryable: false }),
  })}\n`);
  process.exitCode = 1;
}
