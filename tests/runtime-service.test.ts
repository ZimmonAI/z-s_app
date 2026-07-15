import assert from 'node:assert/strict';
import test from 'node:test';
import * as runtimeServiceModule from '../src/runtime-service.js';
import {
  CONTRACT_VERSION,
  PACKAGE_VERSION,
  SAFE_DIAGNOSTIC_CATEGORIES,
  SERVICE_ID,
  compatibilityPolicy,
  createHttpStorageRuntime,
  createSafeDiagnostic,
  serializeSafeDiagnostic,
  type IntegrityVerificationResult,
  type ObjectWriteIntentRequest,
  type ProviderCapabilityPolicy,
  type StorageRuntimeOptions,
} from '../src/index.js';

const CAPABILITY_POLICY: ProviderCapabilityPolicy = {
  checksumVerification: 'required',
  sizeVerification: 'required-when-supported',
  headContentLength: 'optional-with-checksum',
  rangeRead: 'required',
};

const INTEGRITY_RESULT: IntegrityVerificationResult = {
  verified: true,
  checksumVerified: true,
  sizeVerified: true,
  sizeVerificationDisposition: 'matched',
};

const OPAQUE_COMPLETION_VALUE = ['opaque', 'completion', 'value'].join('-');

const VALID_PAYLOAD: ObjectWriteIntentRequest = {
  storageProfile: {
    profileId: 'video-maker-dev-default',
    profileVersion: 1,
    environment: 'dev',
  },
  mediaType: 'image/png',
  byteLength: 1024,
  checksumSha256: 'a'.repeat(64),
  sourceReference: 'pending-resource-01',
};

function runtimeOptions(
  overrides: Partial<StorageRuntimeOptions> = {},
): StorageRuntimeOptions {
  const base: StorageRuntimeOptions = {
    authenticate: (token) =>
      token === 'valid-token' ? { appId: 'video-maker_app', serviceId: 'api' } : null,
    authorizeCaller: ({ appId }) => appId === 'video-maker_app' || appId === 'z-x_app',
    resolveStorageProfile: (request) => ({
      ...request,
      ready: true,
      safeFingerprint: 'profile-fingerprint-v1',
      capabilityPolicy: CAPABILITY_POLICY,
      capabilities: {
        objectWriteIntent: true,
        objectReadGrant: false,
        objectDeleteRequest: false,
        objectRepairOperation: false,
      },
      protectionStages: ['write-intent-created'],
    }),
    createObjectWriteIntent: ({ context }) => ({
      writeIntentId: `wi_${context.requestId}`,
      storageObjectId: `so_${context.requestId}`,
      state: 'accepted',
      uploadCompletionToken: OPAQUE_COMPLETION_VALUE,
      expiresAt: '2026-07-15T16:30:00.000Z',
      objectProtectionStage: 'write-intent-created',
    }),
    controlPlaneReadiness: () => ({ status: 'ready' }),
    dataPlaneReadiness: () => ({ status: 'not-ready', code: 'provider-adapters-not-configured' }),
    now: () => new Date('2026-07-15T16:00:00.000Z'),
    createId: () => 'request-01',
  };
  return { ...base, ...overrides };
}

function writeRequest(input: {
  version?: string;
  caller?: string;
  token?: string;
  idempotencyKey?: string;
  correlationReference?: string;
  payload?: ObjectWriteIntentRequest;
} = {}): Request {
  return new Request('https://z-s.internal/v1/object-write-intents', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.token ?? 'valid-token'}`,
      'content-type': 'application/json',
      'x-zs-contract-version': input.version ?? CONTRACT_VERSION,
      'x-zs-caller-app': input.caller ?? 'video-maker_app',
      'idempotency-key': input.idempotencyKey ?? 'write-01',
      'x-app-correlation-reference': input.correlationReference ?? 'resource-01',
    },
    body: JSON.stringify(input.payload ?? VALID_PAYLOAD),
  });
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null && !Array.isArray(body));
  return body as Record<string, unknown>;
}

function diagnosticCode(body: Record<string, unknown>): string | undefined {
  const error = body.error;
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return undefined;
  const diagnostic = (error as Record<string, unknown>).diagnostic;
  if (typeof diagnostic !== 'object' || diagnostic === null || Array.isArray(diagnostic)) {
    return undefined;
  }
  const code = (diagnostic as Record<string, unknown>).code;
  return typeof code === 'string' ? code : undefined;
}

test('runtime contract exposes exact identity and runtime functions', () => {
  assert.equal(SERVICE_ID, 'z-s');
  assert.equal(PACKAGE_VERSION, '0.2.0');
  assert.equal(CONTRACT_VERSION, '1.0');
  assert.deepEqual(Object.keys(runtimeServiceModule).sort(), [
    'createHttpStorageRuntime',
    'createInMemoryDuplicateProtectionStore',
    'createSafeDiagnostic',
    'serializeSafeDiagnostic',
  ]);
  assert.equal(compatibilityPolicy.currentContractVersion, CONTRACT_VERSION);
  assert.ok(SAFE_DIAGNOSTIC_CATEGORIES.includes('duplicate-conflict'));
  assert.equal(INTEGRITY_RESULT.sizeVerificationDisposition, 'matched');
});

test('incompatible contract versions are rejected before authentication', async () => {
  let authenticationCalls = 0;
  const runtime = createHttpStorageRuntime(
    runtimeOptions({
      authenticate: () => {
        authenticationCalls += 1;
        return { appId: 'video-maker_app' };
      },
    }),
  );
  const response = await runtime.handle(writeRequest({ version: '2.0' }));
  assert.equal(response.status, 409);
  assert.equal(diagnosticCode(await responseBody(response)), 'unsupported-contract-version');
  assert.equal(authenticationCalls, 0);
});

test('invalid caller claims and unauthorized callers fail closed', async () => {
  const runtime = createHttpStorageRuntime(runtimeOptions());
  const mismatch = await runtime.handle(writeRequest({ caller: 'z-x_app' }));
  assert.equal(mismatch.status, 403);
  assert.equal(diagnosticCode(await responseBody(mismatch)), 'invalid-caller');

  const denied = createHttpStorageRuntime(
    runtimeOptions({ authorizeCaller: () => false }),
  );
  const deniedResponse = await denied.handle(writeRequest());
  assert.equal(deniedResponse.status, 403);
  assert.equal(diagnosticCode(await responseBody(deniedResponse)), 'invalid-caller');
});

test('safe diagnostics serialize only bounded categories, codes and correlation', () => {
  assert.deepEqual(createSafeDiagnostic('not-ready', 'storage-profile-not-ready', true, 'ref-01'), {
    category: 'not-ready',
    code: 'storage-profile-not-ready',
    retryable: true,
    appCorrelationReference: 'ref-01',
  });
  assert.deepEqual(serializeSafeDiagnostic(new Error('secret endpoint value'), 'ref-02'), {
    category: 'internal',
    code: 'internal-error',
    retryable: false,
    appCorrelationReference: 'ref-02',
  });
  assert.deepEqual(createSafeDiagnostic('unknown', 'provider-secret', true, 'bad reference value'), {
    category: 'internal',
    code: 'internal-error',
    retryable: false,
  });
});

test('runtime results do not leak provider endpoints, secret references or object keys', async () => {
  const runtime = createHttpStorageRuntime(
    runtimeOptions({
      resolveStorageProfile: (request) => ({
        ...request,
        ready: true,
        safeFingerprint: 'profile-fingerprint-v1',
        capabilityPolicy: CAPABILITY_POLICY,
        capabilities: {
          objectWriteIntent: true,
          objectReadGrant: false,
          objectDeleteRequest: false,
          objectRepairOperation: false,
        },
        protectionStages: ['write-intent-created'],
        providerEndpoint: 'https://private-provider.invalid',
        secretReferenceId: 'secret-ref-01',
      }),
      createObjectWriteIntent: ({ context, resolvedProfile }) => {
        assert.equal('providerEndpoint' in resolvedProfile, false);
        assert.equal('secretReferenceId' in resolvedProfile, false);
        return {
          writeIntentId: `wi_${context.requestId}`,
          storageObjectId: `so_${context.requestId}`,
          state: 'accepted',
          uploadCompletionToken: OPAQUE_COMPLETION_VALUE,
          expiresAt: '2026-07-15T16:30:00.000Z',
          objectProtectionStage: 'write-intent-created',
          providerEndpoint: 'https://private-provider.invalid',
          secretReferenceId: 'secret-ref-01',
          objectKey: 'video-maker/user-resources/private-object.png',
          credential: 'do-not-return',
        };
      },
    }),
  );
  const response = await runtime.handle(writeRequest());
  assert.equal(response.status, 200);
  const serialized = JSON.stringify(await responseBody(response));
  assert.equal(serialized.includes('private-provider'), false);
  assert.equal(serialized.includes('secret-ref'), false);
  assert.equal(serialized.includes('private-object'), false);
  assert.equal(serialized.includes('do-not-return'), false);
});

test('duplicate protection replays identical requests and rejects conflicting reuse', async () => {
  let operationCalls = 0;
  const runtime = createHttpStorageRuntime(
    runtimeOptions({
      createObjectWriteIntent: async ({ context }) => {
        operationCalls += 1;
        await Promise.resolve();
        return {
          writeIntentId: `wi_${context.requestId}`,
          storageObjectId: `so_${context.requestId}`,
          state: 'accepted',
          uploadCompletionToken: OPAQUE_COMPLETION_VALUE,
          expiresAt: '2026-07-15T16:30:00.000Z',
          objectProtectionStage: 'write-intent-created',
        };
      },
    }),
  );

  const [first, replay] = await Promise.all([
    runtime.handle(writeRequest({ idempotencyKey: 'same-key' })),
    runtime.handle(writeRequest({ idempotencyKey: 'same-key' })),
  ]);
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(operationCalls, 1);
  const replayBody = JSON.stringify(await responseBody(replay));
  assert.equal(replayBody.includes('"replayed":true'), true);

  const conflict = await runtime.handle(
    writeRequest({
      idempotencyKey: 'same-key',
      payload: { ...VALID_PAYLOAD, byteLength: 2048 },
    }),
  );
  assert.equal(conflict.status, 409);
  assert.equal(diagnosticCode(await responseBody(conflict)), 'idempotency-key-reused');
});

test('process health remains distinct from dependency readiness', async () => {
  const runtime = createHttpStorageRuntime(runtimeOptions());
  const health = await runtime.handle(new Request('https://z-s.internal/healthz'));
  assert.equal(health.status, 200);
  assert.equal((await responseBody(health)).process, 'healthy');

  const readiness = await runtime.handle(new Request('https://z-s.internal/readyz'));
  assert.equal(readiness.status, 503);
  const body = await responseBody(readiness);
  assert.equal(body.status, 'not-ready');
  assert.equal((body.controlPlane as Record<string, unknown>).status, 'ready');
  assert.equal((body.dataPlane as Record<string, unknown>).status, 'not-ready');
});

test('synchronous and asynchronous readiness failures are contained safely', async () => {
  const runtime = createHttpStorageRuntime(
    runtimeOptions({
      controlPlaneReadiness: () => {
        throw new Error('postgres://secret@private-host/z-s');
      },
      dataPlaneReadiness: async () => {
        throw new Error('https://provider.invalid/private-key');
      },
    }),
  );
  const response = await runtime.handle(new Request('https://z-s.internal/readyz'));
  assert.equal(response.status, 503);
  const serialized = JSON.stringify(await responseBody(response));
  assert.equal(serialized.includes('postgres'), false);
  assert.equal(serialized.includes('provider.invalid'), false);
  assert.equal(serialized.includes('control-plane-unavailable'), true);
  assert.equal(serialized.includes('data-plane-unavailable'), true);
});
