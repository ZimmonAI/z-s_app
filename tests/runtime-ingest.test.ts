import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  CONTRACT_VERSION,
  ObjectIngestRuntimeError,
  UPLOAD_COMPLETION_TOKEN_PURPOSE,
  createDeterministicUploadCompletionTokenService,
  createObjectIngestRuntime,
  type HttpStorageRuntime,
  type ObjectIngestAdapter,
  type ObjectIngestInput,
  type ObjectIngestReceipt,
  type ObjectIngestRegistry,
  type ResolvedObjectWriteAuthority,
  type UploadCompletionTokenService,
} from '../src/index.js';
import type {
  CreateObjectWriteIntentInput,
  ObjectWriteIntentExecutionContext,
} from '../src/runtime-storage-registry.js';

const VIDEO_MANAGED_APP_ID = '20000000-0000-4000-8000-000000000001';
const ZX_MANAGED_APP_ID = '20000000-0000-4000-8000-000000000002';
const PROFILE_ID = '20000000-0000-4000-8000-000000000003';
const PREFIX_ID = '20000000-0000-4000-8000-000000000004';
const HOT_BINDING_ID = '20000000-0000-4000-8000-000000000005';
const CANONICAL_BINDING_ID = '20000000-0000-4000-8000-000000000006';
const PROFILE_FINGERPRINT = 'profile-fingerprint-v1';
const SIGNING_KEY = 'deterministic-object-ingest-test-key';

let clock = new Date('2026-07-16T10:00:00.000Z');
let idCounter = 100;

function nextUuid(): string {
  idCounter += 1;
  return `30000000-0000-4000-8000-${idCounter.toString().padStart(12, '0')}`;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function cloneContext(
  value: Readonly<ObjectWriteIntentExecutionContext>,
): Readonly<ObjectWriteIntentExecutionContext> {
  return Object.freeze({
    ...value,
    internalLocators: Object.freeze({ ...value.internalLocators }),
  });
}

class FakeRegistry implements ObjectIngestRegistry {
  readonly contexts = new Map<string, ObjectWriteIntentExecutionContext>();
  readonly copyStates = new Map<string, { hot: 'pending'; canonical: 'pending' }>();
  readonly createInputs: CreateObjectWriteIntentInput[] = [];
  readonly duplicateEntries = new Map<
    string,
    { fingerprint: string; promise: Promise<unknown> }
  >();
  createCalls = 0;
  beginCalls = 0;
  completeCalls = 0;
  cancelCalls = 0;
  failureCalls = 0;

  async execute<T>(input: {
    scope: string;
    key: string;
    fingerprint: string;
    operation: () => Promise<T>;
  }): Promise<Readonly<{ replayed: boolean; value: T }>> {
    const mapKey = `${input.scope}:${input.key}`;
    const existing = this.duplicateEntries.get(mapKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== input.fingerprint) {
        throw new ObjectIngestRuntimeError(
          'duplicate-conflict',
          'idempotency-key-reused',
          409,
        );
      }
      return Object.freeze({ replayed: true, value: (await existing.promise) as T });
    }
    const promise = Promise.resolve().then(input.operation);
    this.duplicateEntries.set(mapKey, { fingerprint: input.fingerprint, promise });
    try {
      return Object.freeze({ replayed: false, value: await promise });
    } catch (error) {
      if (this.duplicateEntries.get(mapKey)?.promise === promise) {
        this.duplicateEntries.delete(mapKey);
      }
      throw error;
    }
  }

  async createObjectWriteIntent(input: CreateObjectWriteIntentInput) {
    this.createCalls += 1;
    this.createInputs.push(input);
    const objectWriteIntentId = nextUuid();
    const storageObjectId = nextUuid();
    const callerAppId =
      input.managedAppId === VIDEO_MANAGED_APP_ID ? 'video-maker_app' : 'z-x_app';
    const context: ObjectWriteIntentExecutionContext = {
      objectWriteIntentId,
      storageObjectId,
      managedAppId: input.managedAppId,
      callerAppId,
      storageProfileId: input.storageProfileId,
      storageProfileVersion: 1,
      storageProfileFingerprint: input.storageProfileFingerprint,
      storagePrefixClassId: input.storagePrefixClassId,
      appCorrelationReference: input.appCorrelationReference,
      sourceReference: input.sourceReference,
      expectedContentType: input.expectedContentType,
      expectedByteLength: input.expectedByteLength,
      expectedChecksumSha256: input.expectedChecksumSha256,
      state: 'accepted',
      expiresAt: input.expiresAt.toISOString(),
      rowVersion: 1,
      registryState: 'reserved',
      objectProtectionStage: 'write-intent-created',
      internalLocators: Object.freeze({ ...input.internalLocators }),
    };
    if (input.callerServiceId !== undefined) context.callerServiceId = input.callerServiceId;
    this.contexts.set(objectWriteIntentId, context);
    this.copyStates.set(storageObjectId, { hot: 'pending', canonical: 'pending' });
    return Object.freeze({
      intent: Object.freeze({
        objectWriteIntentId,
        storageObjectId,
        state: 'accepted' as const,
        expiresAt: context.expiresAt,
      }),
      object: Object.freeze({
        storageObjectId,
        objectProtectionStage: 'write-intent-created',
      }),
    });
  }

  async getObjectWriteIntentExecutionContext(objectWriteIntentId: string) {
    const value = this.contexts.get(objectWriteIntentId);
    return value === undefined ? null : cloneContext(value);
  }

  async expireObjectWriteIntentIfDue(objectWriteIntentId: string): Promise<boolean> {
    const value = this.contexts.get(objectWriteIntentId);
    if (
      value === undefined ||
      (value.state !== 'accepted' && value.state !== 'uploading') ||
      new Date(value.expiresAt).getTime() > clock.getTime()
    ) {
      return false;
    }
    value.state = 'expired';
    value.rowVersion += 1;
    return true;
  }

  async beginObjectUpload(input: {
    objectWriteIntentId: string;
    expectedRowVersion: number;
  }) {
    const value = this.contexts.get(input.objectWriteIntentId);
    if (
      value === undefined ||
      value.state !== 'accepted' ||
      value.rowVersion !== input.expectedRowVersion ||
      new Date(value.expiresAt).getTime() <= clock.getTime()
    ) {
      throw new ObjectIngestRuntimeError(
        'duplicate-conflict',
        'object-write-intent-begin-conflict',
        409,
      );
    }
    this.beginCalls += 1;
    value.state = 'uploading';
    value.rowVersion += 1;
    return cloneContext(value);
  }

  async completeObjectUpload(input: {
    objectWriteIntentId: string;
    expectedRowVersion: number;
    checksumSha256: string;
    byteLength: number;
  }) {
    const value = this.contexts.get(input.objectWriteIntentId);
    if (
      value === undefined ||
      value.state !== 'uploading' ||
      value.rowVersion !== input.expectedRowVersion ||
      value.expectedChecksumSha256 !== input.checksumSha256 ||
      value.expectedByteLength !== input.byteLength
    ) {
      throw new ObjectIngestRuntimeError(
        'duplicate-conflict',
        'object-write-intent-complete-conflict',
        409,
      );
    }
    this.completeCalls += 1;
    value.state = 'completed';
    value.rowVersion += 1;
    value.objectProtectionStage = 'upload-completion-recorded';
    return cloneContext(value);
  }

  async cancelObjectWriteIntent(input: {
    objectWriteIntentId: string;
    expectedState: 'accepted' | 'uploading';
    expectedRowVersion: number;
  }) {
    const value = this.contexts.get(input.objectWriteIntentId);
    if (
      value === undefined ||
      value.state !== input.expectedState ||
      value.rowVersion !== input.expectedRowVersion
    ) {
      throw new ObjectIngestRuntimeError(
        'duplicate-conflict',
        'object-write-intent-cancel-conflict',
        409,
      );
    }
    this.cancelCalls += 1;
    value.state = 'cancelled';
    value.rowVersion += 1;
    return cloneContext(value);
  }

  async failObjectUpload(objectWriteIntentId: string): Promise<boolean> {
    const value = this.contexts.get(objectWriteIntentId);
    if (value === undefined || (value.state !== 'accepted' && value.state !== 'uploading')) {
      return false;
    }
    this.failureCalls += 1;
    value.state = 'failed';
    value.rowVersion += 1;
    return true;
  }

  forceUploading(objectWriteIntentId: string): void {
    const value = this.contexts.get(objectWriteIntentId);
    assert.ok(value !== undefined);
    value.state = 'uploading';
    value.rowVersion += 1;
  }

  duplicateValues(): unknown[] {
    return [...this.duplicateEntries.values()].map((entry) => entry.promise);
  }
}

class FakeAdapter implements ObjectIngestAdapter {
  calls = 0;
  cleanupCalls = 0;
  fail = false;
  consumeOnly: number | undefined;
  readonly partial = new Set<string>();
  readonly receivedLocators: Array<Readonly<{ hot: string; canonical: string }>> = [];

  async ingest(input: Readonly<ObjectIngestInput>): Promise<Readonly<ObjectIngestReceipt>> {
    this.calls += 1;
    this.partial.add(input.objectWriteIntentId);
    this.receivedLocators.push(input.internalLocators);
    const hash = createHash('sha256');
    let byteLength = 0;
    for await (const chunk of input.body) {
      hash.update(chunk);
      byteLength += chunk.byteLength;
      if (this.consumeOnly !== undefined && byteLength >= this.consumeOnly) break;
    }
    if (this.fail) throw new Error('private provider failure');
    return Object.freeze({
      state: 'accepted',
      checksumSha256: hash.digest('hex'),
      byteLength,
    });
  }

  hasPartialState(input: { objectWriteIntentId: string }): boolean {
    return this.partial.has(input.objectWriteIntentId);
  }

  cleanup(input: { objectWriteIntentId: string }): void {
    this.cleanupCalls += 1;
    this.partial.delete(input.objectWriteIntentId);
  }
}

function tokenService(): UploadCompletionTokenService {
  return createDeterministicUploadCompletionTokenService({
    signingKey: SIGNING_KEY,
    now: () => clock,
  });
}

function authorityFor(caller: Readonly<{ appId: string; serviceId?: string }> = {
  appId: 'video-maker_app',
  serviceId: 'api',
}): ResolvedObjectWriteAuthority {
  const authority: ResolvedObjectWriteAuthority = {
    managedAppId: caller.appId === 'z-x_app' ? ZX_MANAGED_APP_ID : VIDEO_MANAGED_APP_ID,
    storageProfileId: PROFILE_ID,
    storageProfileVersion: 1,
    storageProfileFingerprint: PROFILE_FINGERPRINT,
    storagePrefixClassId: PREFIX_ID,
    normalizedPrefixPattern: 'video-maker/user-resources/*',
    hotProviderBindingId: HOT_BINDING_ID,
    canonicalProviderBindingId: CANONICAL_BINDING_ID,
    writePolicy: {
      uploadMode: 'server-streamed-single-object',
      allowedMediaTypes: ['image/png', 'video/mp4'],
      maxByteLength: 1024,
      intentTtlSeconds: 900,
    },
  };
  if (caller.serviceId !== undefined) authority.callerServiceId = caller.serviceId;
  return authority;
}

function makeRuntime(
  registry: FakeRegistry,
  adapter: FakeAdapter,
  options: {
    active?: boolean;
    ready?: boolean;
    allowedMediaTypes?: readonly string[];
    maxByteLength?: number;
    signingService?: UploadCompletionTokenService;
  } = {},
): HttpStorageRuntime {
  return createObjectIngestRuntime({
    authenticate: (token) => {
      if (token === 'valid-token') return { appId: 'video-maker_app', serviceId: 'api' };
      if (token === 'other-service-token') {
        return { appId: 'video-maker_app', serviceId: 'worker' };
      }
      if (token === 'zx-token') return { appId: 'z-x_app', serviceId: 'generator' };
      return null;
    },
    authorizeCaller: () => true,
    resolveStorageProfile: (request) => ({
      ...request,
      active: options.active ?? true,
      ready: options.ready ?? true,
      safeFingerprint: PROFILE_FINGERPRINT,
      capabilityPolicy: {
        checksumVerification: 'required',
        sizeVerification: 'required-when-supported',
        headContentLength: 'optional-with-checksum',
        rangeRead: 'required',
      },
      capabilities: {
        objectWriteIntent: true,
        objectReadGrant: false,
        objectDeleteRequest: false,
        objectRepairOperation: false,
      },
      protectionStages: ['write-intent-created'],
      writePolicy: {
        uploadMode: 'server-streamed-single-object',
        allowedMediaTypes: options.allowedMediaTypes ?? ['image/png', 'video/mp4'],
        maxByteLength: options.maxByteLength ?? 1024,
        intentTtlSeconds: 900,
      },
    }),
    resolveObjectWriteAuthority: (_request, context) => ({
      ...authorityFor(context.caller),
      writePolicy: {
        ...authorityFor(context.caller).writePolicy,
        allowedMediaTypes: options.allowedMediaTypes ?? ['image/png', 'video/mp4'],
        maxByteLength: options.maxByteLength ?? 1024,
      },
    }),
    uploadCompletionTokenService: options.signingService ?? tokenService(),
    registry,
    adapter,
    controlPlaneReadiness: () => ({ status: 'ready' }),
    dataPlaneReadiness: () => ({ status: 'ready' }),
    now: () => clock,
    createId: nextUuid,
    createLocatorId: nextUuid,
  });
}

function createRequest(input: {
  bytes: Uint8Array;
  mediaType?: string;
  sourceReference?: string;
  correlation?: string;
  idempotencyKey?: string;
  authToken?: string;
  callerApp?: string;
  byteLength?: number;
  checksum?: string;
}): Request {
  return new Request('https://z-s.internal/v1/object-write-intents', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.authToken ?? 'valid-token'}`,
      'content-type': 'application/json',
      'x-zs-contract-version': CONTRACT_VERSION,
      'x-zs-caller-app': input.callerApp ?? 'video-maker_app',
      'x-app-correlation-reference': input.correlation ?? 'resource-01',
      'idempotency-key': input.idempotencyKey ?? nextUuid(),
    },
    body: JSON.stringify({
      storageProfile: {
        profileId: 'video-maker-dev-default',
        profileVersion: 1,
        environment: 'dev',
      },
      mediaType: input.mediaType ?? 'image/png',
      byteLength: input.byteLength ?? input.bytes.byteLength,
      checksumSha256: input.checksum ?? sha256(input.bytes),
      sourceReference: input.sourceReference ?? 'standalone-resource',
    }),
  });
}

function uploadRequest(input: {
  objectWriteIntentId: string;
  uploadCompletionToken: string;
  bytes: Uint8Array;
  checksumSha256: string;
  byteLength: number;
  idempotencyKey: string;
  correlation?: string;
  authToken?: string;
  callerApp?: string;
  mediaType?: string;
}): Request {
  return new Request(
    `https://z-s.internal/v1/object-write-intents/${input.objectWriteIntentId}/content`,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${input.authToken ?? 'valid-token'}`,
        'x-zs-contract-version': CONTRACT_VERSION,
        'x-zs-caller-app': input.callerApp ?? 'video-maker_app',
        'x-app-correlation-reference': input.correlation ?? 'resource-01',
        'idempotency-key': input.idempotencyKey,
        'x-zs-upload-completion-token': input.uploadCompletionToken,
        'x-content-sha256': input.checksumSha256,
        'content-type': input.mediaType ?? 'image/png',
        'content-length': String(input.byteLength),
      },
      body: input.bytes,
    },
  );
}

function cancelRequest(input: {
  objectWriteIntentId: string;
  idempotencyKey: string;
  correlation?: string;
  authToken?: string;
  callerApp?: string;
}): Request {
  return new Request(
    `https://z-s.internal/v1/object-write-intents/${input.objectWriteIntentId}`,
    {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${input.authToken ?? 'valid-token'}`,
        'x-zs-contract-version': CONTRACT_VERSION,
        'x-zs-caller-app': input.callerApp ?? 'video-maker_app',
        'x-app-correlation-reference': input.correlation ?? 'resource-01',
        'idempotency-key': input.idempotencyKey,
      },
    },
  );
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function result(body: Record<string, unknown>): Record<string, unknown> {
  assert.ok(body.result !== null && typeof body.result === 'object' && !Array.isArray(body.result));
  return body.result as Record<string, unknown>;
}

function diagnosticCode(body: Record<string, unknown>): string | undefined {
  const error = body.error;
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const diagnostic = (error as Record<string, unknown>).diagnostic;
  if (diagnostic === null || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) {
    return undefined;
  }
  const code = (diagnostic as Record<string, unknown>).code;
  return typeof code === 'string' ? code : undefined;
}

async function createAcceptedIntent(input: {
  runtime: HttpStorageRuntime;
  bytes: Uint8Array;
  sourceReference?: string;
  correlation?: string;
  authToken?: string;
  callerApp?: string;
  idempotencyKey?: string;
}): Promise<Record<string, unknown>> {
  const response = await input.runtime.handle(
    createRequest({
      bytes: input.bytes,
      ...(input.sourceReference === undefined
        ? {}
        : { sourceReference: input.sourceReference }),
      ...(input.correlation === undefined ? {} : { correlation: input.correlation }),
      ...(input.authToken === undefined ? {} : { authToken: input.authToken }),
      ...(input.callerApp === undefined ? {} : { callerApp: input.callerApp }),
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: input.idempotencyKey }),
    }),
  );
  assert.equal(response.status, 200);
  return result(await jsonBody(response));
}

test('upload completion tokens are deterministic, purpose-bound, caller-bound and expiring', async () => {
  clock = new Date('2026-07-16T10:00:00.000Z');
  const service = tokenService();
  const claims = {
    purpose: UPLOAD_COMPLETION_TOKEN_PURPOSE,
    objectWriteIntentId: nextUuid(),
    storageObjectId: nextUuid(),
    callerAppId: 'video-maker_app',
    callerServiceId: 'api',
    contractVersion: CONTRACT_VERSION,
    expiresAt: '2026-07-16T10:15:00.000Z',
  } as const;
  const first = await service.issue(claims);
  const second = await service.issue(claims);
  assert.equal(first, second);
  assert.deepEqual(await service.verify(first, claims), claims);
  await assert.rejects(
    service.verify(first, { ...claims, objectWriteIntentId: nextUuid() }),
    /invalid-upload-completion-token/,
  );
  await assert.rejects(
    service.verify(first, { ...claims, storageObjectId: nextUuid() }),
    /invalid-upload-completion-token/,
  );
  await assert.rejects(
    service.verify(first, { ...claims, callerAppId: 'z-x_app' }),
    /invalid-upload-completion-token/,
  );
  const tampered = `${first.slice(0, -1)}${first.endsWith('a') ? 'b' : 'a'}`;
  await assert.rejects(service.verify(tampered, claims), /invalid-upload-completion-token/);
  clock = new Date('2026-07-16T10:15:00.000Z');
  await assert.rejects(service.verify(first, claims), /upload-completion-token-expired/);
});

test('create supports standalone, production-step and Z-X-shaped forms without authority leakage', async () => {
  clock = new Date('2026-07-16T10:00:00.000Z');
  const registry = new FakeRegistry();
  const adapter = new FakeAdapter();
  const runtime = makeRuntime(registry, adapter);
  const bytes = new TextEncoder().encode('generic-object');
  const forms = [
    { sourceReference: 'standalone-resource', authToken: 'valid-token', callerApp: 'video-maker_app' },
    { sourceReference: 'production-step-output', authToken: 'valid-token', callerApp: 'video-maker_app' },
    { sourceReference: 'generated-image-output', authToken: 'zx-token', callerApp: 'z-x_app' },
  ];
  for (const [index, form] of forms.entries()) {
    const accepted = await createAcceptedIntent({
      runtime,
      bytes,
      sourceReference: form.sourceReference,
      authToken: form.authToken,
      callerApp: form.callerApp,
      correlation: `resource-${index + 1}`,
      idempotencyKey: `write-${index + 1}`,
    });
    assert.equal(accepted.state, 'accepted');
    assert.equal(accepted.objectProtectionStage, 'write-intent-created');
    assert.equal(
      new Date(accepted.expiresAt as string).getTime() - clock.getTime(),
      15 * 60 * 1000,
    );
    const serialized = JSON.stringify(accepted);
    for (const prohibited of ['provider', 'binding', 'locator', 'bucket', 'endpoint', 'secret']) {
      assert.equal(serialized.toLowerCase().includes(prohibited), false);
    }
  }
  assert.equal(registry.createCalls, 3);
  assert.equal(adapter.calls, 0);
  for (const input of registry.createInputs) {
    assert.ok(input.internalLocators.hot.startsWith('video-maker/user-resources/'));
    assert.ok(input.internalLocators.canonical.startsWith('video-maker/user-resources/'));
    assert.equal(input.internalLocators.hot.includes('://'), false);
  }
  const duplicatePromises = registry.duplicateValues();
  const duplicateValues = await Promise.all(duplicatePromises as Promise<unknown>[]);
  const serializedDuplicates = JSON.stringify(duplicateValues);
  for (const accepted of duplicateValues as Array<Record<string, unknown>>) {
    assert.equal('uploadCompletionToken' in accepted, false);
  }
  assert.equal(serializedDuplicates.includes('object-upload-completion'), false);
});

test('create rejects inactive or unready profiles, disallowed media and profile size overflow', async () => {
  clock = new Date('2026-07-16T10:00:00.000Z');
  const bytes = new Uint8Array(8);
  const inactive = await makeRuntime(new FakeRegistry(), new FakeAdapter(), { active: false }).handle(
    createRequest({ bytes }),
  );
  assert.equal(inactive.status, 503);
  assert.equal(diagnosticCode(await jsonBody(inactive)), 'storage-profile-inactive');

  const unready = await makeRuntime(new FakeRegistry(), new FakeAdapter(), { ready: false }).handle(
    createRequest({ bytes }),
  );
  assert.equal(unready.status, 503);
  assert.equal(diagnosticCode(await jsonBody(unready)), 'storage-profile-not-ready');

  const media = await makeRuntime(new FakeRegistry(), new FakeAdapter(), {
    allowedMediaTypes: ['video/mp4'],
  }).handle(createRequest({ bytes, mediaType: 'image/png' }));
  assert.equal(media.status, 415);
  assert.equal(diagnosticCode(await jsonBody(media)), 'media-type-not-allowed');

  const size = await makeRuntime(new FakeRegistry(), new FakeAdapter(), {
    maxByteLength: 4,
  }).handle(createRequest({ bytes }));
  assert.equal(size.status, 413);
  assert.equal(diagnosticCode(await jsonBody(size)), 'byte-length-exceeds-profile-limit');
});

test('upload records computed integrity once and replays across runtime reconstruction without rereading', async () => {
  clock = new Date('2026-07-16T10:00:00.000Z');
  const registry = new FakeRegistry();
  const adapter = new FakeAdapter();
  const runtime = makeRuntime(registry, adapter);
  const bytes = new TextEncoder().encode('hello-ingest');
  const checksum = sha256(bytes);
  const accepted = await createAcceptedIntent({
    runtime,
    bytes,
    idempotencyKey: 'write-success',
  });
  const objectWriteIntentId = accepted.writeIntentId as string;
  const uploadCompletionToken = accepted.uploadCompletionToken as string;

  const first = await runtime.handle(
    uploadRequest({
      objectWriteIntentId,
      uploadCompletionToken,
      bytes,
      checksumSha256: checksum,
      byteLength: bytes.byteLength,
      idempotencyKey: 'complete-success',
    }),
  );
  assert.equal(first.status, 200);
  const firstResult = result(await jsonBody(first));
  assert.equal(firstResult.state, 'recorded');
  assert.equal(firstResult.checksumSha256, checksum);
  assert.equal(firstResult.byteLength, bytes.byteLength);
  assert.equal(firstResult.objectProtectionStage, 'upload-completion-recorded');
  assert.equal((firstResult.duplicateProtection as Record<string, unknown>).replayed, false);

  const replay = await runtime.handle(
    uploadRequest({
      objectWriteIntentId,
      uploadCompletionToken,
      bytes,
      checksumSha256: checksum,
      byteLength: bytes.byteLength,
      idempotencyKey: 'complete-success',
    }),
  );
  assert.equal(replay.status, 200);
  assert.equal(
    (result(await jsonBody(replay)).duplicateProtection as Record<string, unknown>).replayed,
    true,
  );

  const reconstructed = makeRuntime(registry, adapter);
  const processReplay = await reconstructed.handle(
    uploadRequest({
      objectWriteIntentId,
      uploadCompletionToken,
      bytes,
      checksumSha256: checksum,
      byteLength: bytes.byteLength,
      idempotencyKey: 'complete-success',
    }),
  );
  assert.equal(processReplay.status, 200);
  assert.equal(adapter.calls, 1);
  assert.equal(registry.beginCalls, 1);
  assert.equal(registry.completeCalls, 1);
  assert.equal((await registry.getObjectWriteIntentExecutionContext(objectWriteIntentId))?.state, 'completed');
  assert.deepEqual(registry.copyStates.get(firstResult.storageObjectId as string), {
    hot: 'pending',
    canonical: 'pending',
  });

  const newKey = await runtime.handle(
    uploadRequest({
      objectWriteIntentId,
      uploadCompletionToken,
      bytes,
      checksumSha256: checksum,
      byteLength: bytes.byteLength,
      idempotencyKey: 'complete-new-key',
    }),
  );
  assert.equal(newKey.status, 409);
  assert.equal(diagnosticCode(await jsonBody(newKey)), 'object-write-intent-completed');
  assert.equal(adapter.calls, 1);
});

test('twenty concurrent completion replays invoke the adapter exactly once', async () => {
  clock = new Date('2026-07-16T10:00:00.000Z');
  const registry = new FakeRegistry();
  const adapter = new FakeAdapter();
  const runtime = makeRuntime(registry, adapter);
  const bytes = new TextEncoder().encode('concurrent-object');
  const checksum = sha256(bytes);
  const accepted = await createAcceptedIntent({
    runtime,
    bytes,
    idempotencyKey: 'write-concurrent',
  });
  const responses = await Promise.all(
    Array.from({ length: 20 }, () =>
      runtime.handle(
        uploadRequest({
          objectWriteIntentId: accepted.writeIntentId as string,
          uploadCompletionToken: accepted.uploadCompletionToken as string,
          bytes,
          checksumSha256: checksum,
          byteLength: bytes.byteLength,
          idempotencyKey: 'complete-concurrent',
        }),
      ),
    ),
  );
  assert.equal(responses.every((response) => response.status === 200), true);
  assert.equal(adapter.calls, 1);
  assert.equal(registry.completeCalls, 1);
});

test('header mismatches fail before adapter work while computed mismatches clean partial state and fail intent', async () => {
  clock = new Date('2026-07-16T10:00:00.000Z');
  const bytes = new TextEncoder().encode('same-length');
  const checksum = sha256(bytes);

  const headerRegistry = new FakeRegistry();
  const headerAdapter = new FakeAdapter();
  const headerRuntime = makeRuntime(headerRegistry, headerAdapter);
  const headerAccepted = await createAcceptedIntent({
    runtime: headerRuntime,
    bytes,
    idempotencyKey: 'write-header',
  });
  const headerFailure = await headerRuntime.handle(
    uploadRequest({
      objectWriteIntentId: headerAccepted.writeIntentId as string,
      uploadCompletionToken: headerAccepted.uploadCompletionToken as string,
      bytes,
      checksumSha256: 'f'.repeat(64),
      byteLength: bytes.byteLength,
      idempotencyKey: 'complete-header',
    }),
  );
  assert.equal(headerFailure.status, 400);
  assert.equal(diagnosticCode(await jsonBody(headerFailure)), 'declared-checksum-mismatch');
  assert.equal(headerAdapter.calls, 0);
  assert.equal(
    (await headerRegistry.getObjectWriteIntentExecutionContext(
      headerAccepted.writeIntentId as string,
    ))?.state,
    'accepted',
  );

  const mismatchRegistry = new FakeRegistry();
  const mismatchAdapter = new FakeAdapter();
  const mismatchRuntime = makeRuntime(mismatchRegistry, mismatchAdapter);
  const mismatchAccepted = await createAcceptedIntent({
    runtime: mismatchRuntime,
    bytes,
    idempotencyKey: 'write-mismatch',
  });
  const changed = new TextEncoder().encode('diff-length');
  assert.equal(changed.byteLength, bytes.byteLength);
  const bodyFailure = await mismatchRuntime.handle(
    uploadRequest({
      objectWriteIntentId: mismatchAccepted.writeIntentId as string,
      uploadCompletionToken: mismatchAccepted.uploadCompletionToken as string,
      bytes: changed,
      checksumSha256: checksum,
      byteLength: bytes.byteLength,
      idempotencyKey: 'complete-mismatch',
    }),
  );
  assert.equal(bodyFailure.status, 400);
  assert.equal(diagnosticCode(await jsonBody(bodyFailure)), 'computed-checksum-mismatch');
  assert.equal(mismatchAdapter.cleanupCalls, 1);
  assert.equal(mismatchRegistry.failureCalls, 1);
  assert.equal(
    (await mismatchRegistry.getObjectWriteIntentExecutionContext(
      mismatchAccepted.writeIntentId as string,
    ))?.state,
    'failed',
  );
  assert.equal(JSON.stringify(await jsonBody(bodyFailure)).includes('private'), false);
});

test('short, oversized, partially consumed and adapter-failed bodies all trigger cleanup', async () => {
  clock = new Date('2026-07-16T10:00:00.000Z');
  const expected = new TextEncoder().encode('12345');
  const checksum = sha256(expected);
  const cases: Array<{
    name: string;
    body: Uint8Array;
    configure?: (adapter: FakeAdapter) => void;
    code: string;
  }> = [
    {
      name: 'short',
      body: new TextEncoder().encode('1234'),
      code: 'content-length-mismatch',
    },
    {
      name: 'oversized',
      body: new TextEncoder().encode('123456'),
      code: 'content-length-exceeded',
    },
    {
      name: 'partial',
      body: expected,
      configure: (adapter) => {
        adapter.consumeOnly = 1;
      },
      code: 'request-body-not-fully-consumed',
    },
    {
      name: 'adapter',
      body: expected,
      configure: (adapter) => {
        adapter.fail = true;
      },
      code: 'object-ingest-failed',
    },
  ];

  for (const entry of cases) {
    const registry = new FakeRegistry();
    const adapter = new FakeAdapter();
    entry.configure?.(adapter);
    const runtime = makeRuntime(registry, adapter);
    const accepted = await createAcceptedIntent({
      runtime,
      bytes: expected,
      idempotencyKey: `write-${entry.name}`,
    });
    const response = await runtime.handle(
      uploadRequest({
        objectWriteIntentId: accepted.writeIntentId as string,
        uploadCompletionToken: accepted.uploadCompletionToken as string,
        bytes: entry.body,
        checksumSha256: checksum,
        byteLength: expected.byteLength,
        idempotencyKey: `complete-${entry.name}`,
      }),
    );
    assert.equal(response.status >= 400, true);
    assert.equal(diagnosticCode(await jsonBody(response)), entry.code);
    assert.equal(adapter.cleanupCalls, 1);
    assert.equal(
      (await registry.getObjectWriteIntentExecutionContext(
        accepted.writeIntentId as string,
      ))?.state,
      'failed',
    );
  }
});

test('cancel is durable, preserves object identity and cleans reported uploading partial state only', async () => {
  clock = new Date('2026-07-16T10:00:00.000Z');
  const registry = new FakeRegistry();
  const adapter = new FakeAdapter();
  const runtime = makeRuntime(registry, adapter);
  const bytes = new TextEncoder().encode('cancel-object');
  const accepted = await createAcceptedIntent({
    runtime,
    bytes,
    idempotencyKey: 'write-cancel',
  });
  const objectWriteIntentId = accepted.writeIntentId as string;
  const storageObjectId = accepted.storageObjectId as string;
  registry.forceUploading(objectWriteIntentId);
  adapter.partial.add(objectWriteIntentId);

  const first = await runtime.handle(
    cancelRequest({ objectWriteIntentId, idempotencyKey: 'cancel-key' }),
  );
  assert.equal(first.status, 200);
  const cancelled = result(await jsonBody(first));
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.storageObjectId, storageObjectId);
  assert.equal(adapter.cleanupCalls, 1);
  assert.equal(registry.contexts.has(objectWriteIntentId), true);
  assert.equal(registry.copyStates.has(storageObjectId), true);

  const replay = await makeRuntime(registry, adapter).handle(
    cancelRequest({ objectWriteIntentId, idempotencyKey: 'cancel-key' }),
  );
  assert.equal(replay.status, 200);
  assert.equal(
    (result(await jsonBody(replay)).duplicateProtection as Record<string, unknown>).replayed,
    true,
  );
  assert.equal(registry.cancelCalls, 1);
});

test('caller service and app identity are enforced for completion and cancellation', async () => {
  clock = new Date('2026-07-16T10:00:00.000Z');
  const registry = new FakeRegistry();
  const adapter = new FakeAdapter();
  const runtime = makeRuntime(registry, adapter);
  const bytes = new TextEncoder().encode('caller-bound');
  const checksum = sha256(bytes);
  const accepted = await createAcceptedIntent({
    runtime,
    bytes,
    idempotencyKey: 'write-caller',
  });

  const wrongService = await runtime.handle(
    uploadRequest({
      objectWriteIntentId: accepted.writeIntentId as string,
      uploadCompletionToken: accepted.uploadCompletionToken as string,
      bytes,
      checksumSha256: checksum,
      byteLength: bytes.byteLength,
      idempotencyKey: 'complete-wrong-service',
      authToken: 'other-service-token',
    }),
  );
  assert.equal(wrongService.status, 401);
  assert.equal(diagnosticCode(await jsonBody(wrongService)), 'invalid-upload-completion-token');
  assert.equal(adapter.calls, 0);

  const wrongApp = await runtime.handle(
    cancelRequest({
      objectWriteIntentId: accepted.writeIntentId as string,
      idempotencyKey: 'cancel-wrong-app',
      authToken: 'zx-token',
      callerApp: 'z-x_app',
    }),
  );
  assert.equal(wrongApp.status, 403);
  assert.equal(diagnosticCode(await jsonBody(wrongApp)), 'object-write-intent-caller-mismatch');
});

test('due cancellation lazily expires the intent and refuses terminal-state cancellation', async () => {
  clock = new Date('2026-07-16T10:00:00.000Z');
  const registry = new FakeRegistry();
  const adapter = new FakeAdapter();
  const runtime = makeRuntime(registry, adapter);
  const bytes = new TextEncoder().encode('expiry-object');
  const accepted = await createAcceptedIntent({
    runtime,
    bytes,
    idempotencyKey: 'write-expiry',
  });
  clock = new Date('2026-07-16T10:15:00.000Z');
  const response = await runtime.handle(
    cancelRequest({
      objectWriteIntentId: accepted.writeIntentId as string,
      idempotencyKey: 'cancel-expired',
    }),
  );
  assert.equal(response.status, 409);
  assert.equal(diagnosticCode(await jsonBody(response)), 'object-write-intent-expired');
  assert.equal(
    (await registry.getObjectWriteIntentExecutionContext(
      accepted.writeIntentId as string,
    ))?.state,
    'expired',
  );
});
