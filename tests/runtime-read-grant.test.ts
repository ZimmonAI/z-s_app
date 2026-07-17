import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTRACT_VERSION,
  type ObjectReadGrantRequest,
  type SafeDiagnostic,
  type StorageRuntimeOptions,
} from '../src/runtime-contract.js';
import {
  ObjectReadGrantTokenError,
  createDeterministicObjectReadGrantTokenService,
  createReadEnabledHttpStorageRuntime,
  objectReadGrantTokenDigest,
  type ObjectReadGrantRegistry,
  type ObjectReadGrantSnapshot,
} from '../src/runtime-read-grant.js';
import type {
  ObjectReadDeliveryResult,
  ObjectReadDeliveryService,
} from '../src/runtime-read-delivery.js';

const OBJECT_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_OBJECT_ID = '10000000-0000-4000-8000-000000000002';
const GRANT_ID = '10000000-0000-4000-8000-000000000003';
const NOW = new Date('2026-07-17T00:00:00.000Z');

class MemoryGrantRegistry implements ObjectReadGrantRegistry {
  readonly grants = new Map<string, ObjectReadGrantSnapshot>();
  readonly idempotency = new Map<string, { fingerprint: string; value: unknown }>();
  createCalls = 0;

  async execute<T>(input: {
    scope: string;
    key: string;
    fingerprint: string;
    operation: () => Promise<T>;
  }): Promise<Readonly<{ replayed: boolean; value: T }>> {
    const identity = `${input.scope}:${input.key}`;
    const existing = this.idempotency.get(identity);
    if (existing !== undefined) {
      if (existing.fingerprint !== input.fingerprint) {
        throw Object.assign(new Error('idempotency-key-reused'), {
          category: 'duplicate-conflict',
          code: 'idempotency-key-reused',
          status: 409,
          retryable: false,
        });
      }
      return { replayed: true, value: existing.value as T };
    }
    const value = await input.operation();
    this.idempotency.set(identity, { fingerprint: input.fingerprint, value });
    return { replayed: false, value };
  }

  async createObjectReadGrant(input: {
    objectReadGrantId: string;
    storageObjectId: string;
    callerAppId: string;
    callerServiceId?: string;
    appCorrelationReference: string;
    businessAuthorizationReference: string;
    purpose: string;
    allowedMethods: readonly ('HEAD' | 'GET')[];
    allowRange: boolean;
    disposition: 'inline' | 'attachment';
    fileName?: string;
    tokenDigest: string;
    expiresAt: Date;
  }): Promise<Readonly<ObjectReadGrantSnapshot>> {
    this.createCalls += 1;
    const snapshot: ObjectReadGrantSnapshot = {
      objectReadGrantId: input.objectReadGrantId,
      storageObjectId: input.storageObjectId,
      managedAppId: '10000000-0000-4000-8000-000000000010',
      callerAppId: input.callerAppId,
      appCorrelationReference: input.appCorrelationReference,
      businessAuthorizationReference: input.businessAuthorizationReference,
      purpose: input.purpose,
      allowedMethods: input.allowedMethods,
      allowRange: input.allowRange,
      disposition: input.disposition,
      tokenDigest: input.tokenDigest,
      tokenPurpose: 'object-read-grant',
      state: 'active',
      expiresAt: input.expiresAt.toISOString(),
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      rowVersion: 1,
    };
    if (input.callerServiceId !== undefined) snapshot.callerServiceId = input.callerServiceId;
    if (input.fileName !== undefined) snapshot.fileName = input.fileName;
    this.grants.set(input.objectReadGrantId, Object.freeze(snapshot));
    return Object.freeze(snapshot);
  }

  async getObjectReadGrant(input: {
    objectReadGrantId: string;
    storageObjectId: string;
    callerAppId: string;
    callerServiceId?: string;
    tokenDigest: string;
  }): Promise<Readonly<ObjectReadGrantSnapshot> | null> {
    const grant = this.grants.get(input.objectReadGrantId);
    if (
      grant === undefined ||
      grant.storageObjectId !== input.storageObjectId ||
      grant.callerAppId !== input.callerAppId ||
      (grant.callerServiceId ?? '') !== (input.callerServiceId ?? '') ||
      grant.tokenDigest !== input.tokenDigest
    ) {
      return null;
    }
    return grant;
  }

  async revokeObjectReadGrant(input: {
    objectReadGrantId: string;
    callerAppId: string;
    callerServiceId?: string;
    appCorrelationReference: string;
  }): Promise<Readonly<ObjectReadGrantSnapshot>> {
    const grant = this.grants.get(input.objectReadGrantId);
    if (
      grant === undefined ||
      grant.callerAppId !== input.callerAppId ||
      (grant.callerServiceId ?? '') !== (input.callerServiceId ?? '')
    ) {
      throw Object.assign(new Error('object-read-grant-scope-mismatch'), {
        category: 'unauthorized',
        code: 'object-read-grant-scope-mismatch',
        status: 403,
        retryable: false,
      });
    }
    if (grant.state !== 'active') return grant;
    const revoked = Object.freeze({
      ...grant,
      state: 'revoked' as const,
      revokedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      rowVersion: grant.rowVersion + 1,
    });
    this.grants.set(grant.objectReadGrantId, revoked);
    return revoked;
  }
}

function validPayload(overrides: Partial<ObjectReadGrantRequest> = {}): ObjectReadGrantRequest {
  return {
    storageObjectId: OBJECT_ID,
    purpose: 'video-playback',
    allowedMethods: ['HEAD', 'GET'],
    allowRange: true,
    disposition: 'inline',
    fileName: 'clip.mp4',
    requestedTtlSeconds: 120,
    businessAuthorizationReference: 'resource-policy-01',
    ...overrides,
  };
}

function baseOptions(overrides: Partial<StorageRuntimeOptions> = {}): StorageRuntimeOptions {
  return {
    authenticate: (token) =>
      token === 'valid-token' ? { appId: 'video-maker_app', serviceId: 'api' } : null,
    authorizeCaller: ({ appId }) => appId === 'video-maker_app',
    resolveStorageProfile: (request) => ({
      ...request,
      active: true,
      ready: true,
      safeFingerprint: 'profile-fingerprint-v1',
      capabilityPolicy: {
        checksumVerification: 'required',
        sizeVerification: 'required-when-supported',
        headContentLength: 'optional-with-checksum',
        rangeRead: 'required',
      },
      capabilities: {
        objectWriteIntent: true,
        objectReadGrant: true,
        objectDeleteRequest: false,
        objectRepairOperation: false,
      },
      protectionStages: ['protected'],
    }),
    createObjectWriteIntent: () => ({
      writeIntentId: '10000000-0000-4000-8000-000000000020',
      storageObjectId: '10000000-0000-4000-8000-000000000021',
      state: 'accepted',
      expiresAt: '2026-07-17T00:15:00.000Z',
      objectProtectionStage: 'write-intent-created',
    }),
    controlPlaneReadiness: () => ({ status: 'ready' }),
    dataPlaneReadiness: () => ({ status: 'ready' }),
    now: () => NOW,
    createId: () => GRANT_ID,
    ...overrides,
  };
}

function request(
  path: string,
  options: {
    method?: string;
    token?: string;
    caller?: string;
    idempotencyKey?: string;
    payload?: unknown;
    readGrantToken?: string;
    range?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.token ?? 'valid-token'}`,
    'x-zs-contract-version': CONTRACT_VERSION,
    'x-zs-caller-app': options.caller ?? 'video-maker_app',
    'x-app-correlation-reference': 'resource-01',
  };
  if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;
  if (options.payload !== undefined) headers['content-type'] = 'application/json';
  if (options.readGrantToken !== undefined) {
    headers['x-zs-read-grant-token'] = options.readGrantToken;
  }
  if (options.range !== undefined) headers.range = options.range;
  return new Request(`https://z-s.internal${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.payload === undefined ? {} : { body: JSON.stringify(options.payload) }),
  });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  const result: unknown = await response.json();
  assert.ok(result !== null && typeof result === 'object' && !Array.isArray(result));
  return result as Record<string, unknown>;
}

function resultOf(value: Record<string, unknown>): Record<string, unknown> {
  const result = value.result;
  assert.ok(result !== null && typeof result === 'object' && !Array.isArray(result));
  return result as Record<string, unknown>;
}

function errorCode(value: Record<string, unknown>): string | undefined {
  const error = value.error;
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const diagnostic = (error as Record<string, unknown>).diagnostic;
  if (diagnostic === null || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) {
    return undefined;
  }
  return typeof (diagnostic as Record<string, unknown>).code === 'string'
    ? (diagnostic as Record<string, unknown>).code as string
    : undefined;
}

function runtimeHarness(input: {
  now?: () => Date;
  delivery?: ObjectReadDeliveryService;
} = {}) {
  const registry = new MemoryGrantRegistry();
  const tokenService = createDeterministicObjectReadGrantTokenService({
    signingKey: 'deterministic-read-token-key',
    now: input.now ?? (() => NOW),
  });
  const deliveries: Array<Record<string, unknown>> = [];
  const delivery: ObjectReadDeliveryService = input.delivery ?? {
    deliver: async (deliveryInput): Promise<Readonly<ObjectReadDeliveryResult>> => {
      deliveries.push({ ...deliveryInput });
      return {
        status: deliveryInput.rangeHeader === undefined ? 200 : 206,
        headers: Object.freeze({
          'content-type': 'video/mp4',
          'content-length': deliveryInput.rangeHeader === undefined ? '10' : '4',
          'cache-control': 'private, no-store, max-age=0',
          etag: `"${'a'.repeat(64)}"`,
          'accept-ranges': 'bytes',
          'x-zs-delivery-state': 'hot',
        }),
        body: deliveryInput.method === 'HEAD'
          ? null
          : new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('data'));
                controller.close();
              },
            }),
        deliveryState: 'hot',
      };
    },
  };
  const runtime = createReadEnabledHttpStorageRuntime({
    ...baseOptions({ now: input.now ?? (() => NOW) }),
    authorizeObjectReadGrant: () => true,
    objectReadGrantTokenService: tokenService,
    objectReadGrantRegistry: registry,
    objectReadDeliveryService: delivery,
  });
  return { runtime, registry, tokenService, deliveries };
}

test('read-grant tokens are deterministic, scoped and expiry checked', () => {
  const service = createDeterministicObjectReadGrantTokenService({
    signingKey: 'deterministic-read-token-key',
    now: () => NOW,
  });
  const claims = Object.freeze({
    tokenPurpose: 'object-read-grant' as const,
    objectReadGrantId: GRANT_ID,
    storageObjectId: OBJECT_ID,
    callerAppId: 'video-maker_app',
    callerServiceId: 'api',
    purpose: 'video-playback',
    allowedMethods: ['HEAD', 'GET'] as const,
    allowRange: true,
    contractVersion: CONTRACT_VERSION,
    expiresAt: '2026-07-17T00:02:00.000Z',
  });
  const token = service.issue(claims) as string;
  assert.equal(service.issue(claims), token);
  assert.equal(objectReadGrantTokenDigest(token).length, 64);
  assert.deepEqual(service.verify(token, { storageObjectId: OBJECT_ID, callerAppId: 'video-maker_app' }), claims);
  assert.throws(
    () => service.verify(token, { storageObjectId: OTHER_OBJECT_ID }),
    (error: unknown) => error instanceof ObjectReadGrantTokenError,
  );
  assert.throws(
    () => service.verify(`${token.slice(0, -1)}x`),
    (error: unknown) => error instanceof ObjectReadGrantTokenError,
  );
  assert.throws(
    () => service.verify(token, { now: new Date('2026-07-17T00:02:00.000Z') }),
    (error: unknown) =>
      error instanceof ObjectReadGrantTokenError &&
      error.code === 'object-read-grant-token-expired',
  );
});

test('issuance persists digest only and replays a stable token without a second grant', async () => {
  const harness = runtimeHarness();
  const first = await harness.runtime.handle(request('/v1/object-read-grants', {
    method: 'POST',
    idempotencyKey: 'read-grant-01',
    payload: validPayload(),
  }));
  assert.equal(first.status, 200);
  const firstResult = resultOf(await body(first));
  const token = firstResult.readGrantToken;
  assert.equal(typeof token, 'string');
  assert.equal(firstResult.state, 'active');
  assert.equal(harness.registry.createCalls, 1);
  const persisted = harness.registry.grants.get(GRANT_ID);
  if (persisted === undefined) throw new Error('grant-not-persisted');
  assert.equal(persisted.tokenDigest, objectReadGrantTokenDigest(token as string));
  assert.equal(JSON.stringify(persisted).includes(token as string), false);

  const replay = await harness.runtime.handle(request('/v1/object-read-grants', {
    method: 'POST',
    idempotencyKey: 'read-grant-01',
    payload: validPayload(),
  }));
  const replayResult = resultOf(await body(replay));
  assert.equal(replayResult.readGrantToken, token);
  assert.deepEqual(replayResult.duplicateProtection, { key: 'read-grant-01', replayed: true });
  assert.equal(harness.registry.createCalls, 1);
});

test('conflicting idempotency reuse and malformed grant requests fail closed', async () => {
  const harness = runtimeHarness();
  await harness.runtime.handle(request('/v1/object-read-grants', {
    method: 'POST',
    idempotencyKey: 'read-grant-01',
    payload: validPayload(),
  }));
  const conflict = await harness.runtime.handle(request('/v1/object-read-grants', {
    method: 'POST',
    idempotencyKey: 'read-grant-01',
    payload: validPayload({ purpose: 'download' }),
  }));
  assert.equal(conflict.status, 409);
  assert.equal(errorCode(await body(conflict)), 'idempotency-key-reused');

  for (const payload of [
    validPayload({ allowedMethods: [] }),
    validPayload({ requestedTtlSeconds: 301 }),
    validPayload({ fileName: '../secret.mp4' }),
  ]) {
    const response = await harness.runtime.handle(request('/v1/object-read-grants', {
      method: 'POST',
      idempotencyKey: `bad-${Math.random()}`.replace('.', '-'),
      payload,
    }));
    assert.equal(response.status, 400);
  }
});

test('authorized GET and HEAD delivery enforce exact method, Range and caller binding', async () => {
  const harness = runtimeHarness();
  const issued = await harness.runtime.handle(request('/v1/object-read-grants', {
    method: 'POST',
    idempotencyKey: 'read-grant-02',
    payload: validPayload(),
  }));
  const token = resultOf(await body(issued)).readGrantToken as string;

  const get = await harness.runtime.handle(request(`/v1/storage-objects/${OBJECT_ID}/content`, {
    method: 'GET',
    readGrantToken: token,
    range: 'bytes=2-5',
  }));
  assert.equal(get.status, 206);
  assert.equal(await get.text(), 'data');
  assert.equal(harness.deliveries.length, 1);
  assert.equal(harness.deliveries[0]?.rangeHeader, 'bytes=2-5');

  const head = await harness.runtime.handle(request(`/v1/storage-objects/${OBJECT_ID}/content`, {
    method: 'HEAD',
    readGrantToken: token,
  }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const wrongObject = await harness.runtime.handle(request(`/v1/storage-objects/${OTHER_OBJECT_ID}/content`, {
    method: 'GET',
    readGrantToken: token,
  }));
  assert.equal(wrongObject.status, 401);
  assert.equal(errorCode(await body(wrongObject)), 'invalid-object-read-grant-token');

  const wrongCaller = await harness.runtime.handle(request(`/v1/storage-objects/${OBJECT_ID}/content`, {
    method: 'GET',
    readGrantToken: token,
    caller: 'z-x_app',
  }));
  assert.equal(wrongCaller.status, 403);
  assert.equal(errorCode(await body(wrongCaller)), 'invalid-caller');
});

test('method and Range restrictions are enforced before delivery', async () => {
  const harness = runtimeHarness();
  const issued = await harness.runtime.handle(request('/v1/object-read-grants', {
    method: 'POST',
    idempotencyKey: 'read-grant-03',
    payload: validPayload({ allowedMethods: ['GET'], allowRange: false }),
  }));
  const token = resultOf(await body(issued)).readGrantToken as string;
  const head = await harness.runtime.handle(request(`/v1/storage-objects/${OBJECT_ID}/content`, {
    method: 'HEAD',
    readGrantToken: token,
  }));
  assert.equal(head.status, 403);
  assert.equal(errorCode(await body(head)), 'object-read-method-not-allowed');
  const range = await harness.runtime.handle(request(`/v1/storage-objects/${OBJECT_ID}/content`, {
    method: 'GET',
    readGrantToken: token,
    range: 'bytes=0-3',
  }));
  assert.equal(range.status, 403);
  assert.equal(errorCode(await body(range)), 'object-read-range-not-allowed');
  assert.equal(harness.deliveries.length, 0);
});

test('revocation is idempotent and blocks subsequent token use', async () => {
  const harness = runtimeHarness();
  const issued = await harness.runtime.handle(request('/v1/object-read-grants', {
    method: 'POST',
    idempotencyKey: 'read-grant-04',
    payload: validPayload(),
  }));
  const token = resultOf(await body(issued)).readGrantToken as string;
  const revokePath = `/v1/object-read-grants/${GRANT_ID}`;
  const revoked = await harness.runtime.handle(request(revokePath, {
    method: 'DELETE',
    idempotencyKey: 'revoke-01',
  }));
  assert.equal(revoked.status, 200);
  assert.equal(resultOf(await body(revoked)).state, 'revoked');
  const replay = await harness.runtime.handle(request(revokePath, {
    method: 'DELETE',
    idempotencyKey: 'revoke-01',
  }));
  assert.deepEqual(resultOf(await body(replay)).duplicateProtection, {
    key: 'revoke-01',
    replayed: true,
  });
  const blocked = await harness.runtime.handle(request(`/v1/storage-objects/${OBJECT_ID}/content`, {
    method: 'GET',
    readGrantToken: token,
  }));
  assert.equal(blocked.status, 403);
  assert.equal(errorCode(await body(blocked)), 'object-read-grant-revoked');
});

test('expired grants and delivery failures serialize bounded diagnostics only', async () => {
  let current = NOW;
  const diagnostic: Readonly<SafeDiagnostic> = Object.freeze({
    category: 'dependency-unavailable',
    code: 'object-content-unavailable',
    retryable: true,
  });
  const delivery: ObjectReadDeliveryService = {
    deliver: async () => {
      throw Object.assign(new Error('https://private-provider.invalid/secret'), {
        ...diagnostic,
        status: 503,
        providerEndpoint: 'https://private-provider.invalid',
      });
    },
  };
  const harness = runtimeHarness({ now: () => current, delivery });
  const issued = await harness.runtime.handle(request('/v1/object-read-grants', {
    method: 'POST',
    idempotencyKey: 'read-grant-05',
    payload: validPayload({ requestedTtlSeconds: 30 }),
  }));
  const token = resultOf(await body(issued)).readGrantToken as string;
  const failed = await harness.runtime.handle(request(`/v1/storage-objects/${OBJECT_ID}/content`, {
    method: 'GET',
    readGrantToken: token,
  }));
  assert.equal(failed.status, 503);
  const serialized = JSON.stringify(await body(failed));
  assert.equal(serialized.includes('private-provider'), false);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('object-content-unavailable'), true);

  current = new Date('2026-07-17T00:00:30.000Z');
  const expired = await harness.runtime.handle(request(`/v1/storage-objects/${OBJECT_ID}/content`, {
    method: 'GET',
    readGrantToken: token,
  }));
  assert.equal(expired.status, 401);
  assert.equal(errorCode(await body(expired)), 'object-read-grant-token-expired');
});
