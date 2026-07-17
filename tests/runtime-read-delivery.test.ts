import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  ObjectReadGrantError,
  READ_GRANT_TOKEN_PURPOSE,
  createObjectReadGrantClaims,
  createObjectReadGrantTokenService,
  type IssueObjectReadGrantInput,
  type ObjectReadAttemptInput,
  type ObjectReadGrantRegistry,
  type ObjectReadGrantSnapshot,
  type ObjectReadObjectSnapshot,
  type RevokeObjectReadGrantInput,
} from '../src/runtime-read-grant.js';
import {
  ProviderReadError,
  createReadDeliveryHttpStorageRuntime,
  parseSingleByteRange,
  type ProviderObjectReadInput,
  type ProviderObjectReadReceipt,
  type ProviderObjectReader,
} from '../src/runtime-read-delivery.js';

const IDS = {
  grant: '00000000-0000-4000-8000-000000000201',
  object: '00000000-0000-4000-8000-000000000202',
  app: '00000000-0000-4000-8000-000000000203',
  hotCopy: '00000000-0000-4000-8000-000000000204',
  hotBinding: '00000000-0000-4000-8000-000000000205',
  canonicalCopy: '00000000-0000-4000-8000-000000000206',
  canonicalBinding: '00000000-0000-4000-8000-000000000207',
} as const;

const NOW = new Date('2026-07-17T12:00:00.000Z');
const DATA = new TextEncoder().encode('0123456789abcdefghijklmnopqrstuvwxyz');
const CHECKSUM = 'a'.repeat(64);

class MemoryRegistry implements ObjectReadGrantRegistry {
  grant?: ObjectReadGrantSnapshot;
  object: ObjectReadObjectSnapshot;
  readonly issues = new Map<string, { fingerprint: string; grant: ObjectReadGrantSnapshot }>();
  readonly revokes = new Map<string, string>();
  readonly attempts: Array<{ id: string; input: ObjectReadAttemptInput; outcome?: boolean }> = [];
  readonly events: Array<{ type: string; payload: Readonly<Record<string, unknown>> }> = [];

  constructor() {
    this.object = Object.freeze({
      storageObjectId: IDS.object,
      managedAppId: IDS.app,
      registryState: 'active',
      objectProtectionStage: 'canonical-and-hot-verified',
      verifiedChecksumSha256: CHECKSUM,
      verifiedByteLength: DATA.length,
      verifiedContentType: 'video/mp4',
      targets: Object.freeze({
        hot: Object.freeze({
          storageObjectCopyId: IDS.hotCopy,
          providerBindingId: IDS.hotBinding,
          providerRole: 'hot',
          providerType: 'r2',
          internalLocator: 'safe/hot/object',
        }),
        canonical: Object.freeze({
          storageObjectCopyId: IDS.canonicalCopy,
          providerBindingId: IDS.canonicalBinding,
          providerRole: 'canonical',
          providerType: 'minio',
          internalLocator: 'safe/canonical/object',
        }),
      }),
    });
  }

  async issue(input: Readonly<IssueObjectReadGrantInput>) {
    const mapKey = `${input.caller.appId}:${input.caller.serviceId ?? ''}:${input.duplicateProtectionKey}`;
    const existing = this.issues.get(mapKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== input.requestFingerprint) {
        throw new ObjectReadGrantError('duplicate-conflict', 'idempotency-key-reused', 409);
      }
      return Object.freeze({ replayed: true, grant: existing.grant });
    }
    const grant: ObjectReadGrantSnapshot = Object.freeze({
      objectReadGrantId: input.proposedGrantId,
      storageObjectId: input.request.storageObjectId,
      managedAppId: IDS.app,
      callerAppId: input.caller.appId,
      ...(input.caller.serviceId === undefined ? {} : { callerServiceId: input.caller.serviceId }),
      appCorrelationReference: input.appCorrelationReference,
      businessAuthorizationReference: input.request.businessAuthorizationReference,
      purpose: input.request.purpose,
      allowedMethods: input.request.allowedMethods,
      allowRange: input.request.allowRange,
      disposition: input.request.disposition,
      ...(input.request.fileName === undefined ? {} : { fileName: input.request.fileName }),
      tokenDigest: input.proposedTokenDigest,
      tokenPurpose: READ_GRANT_TOKEN_PURPOSE,
      state: 'active',
      expiresAt: input.proposedExpiresAt.toISOString(),
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      rowVersion: 1,
    });
    this.grant = grant;
    this.issues.set(mapKey, { fingerprint: input.requestFingerprint, grant });
    return Object.freeze({ replayed: false, grant });
  }

  async revoke(input: Readonly<RevokeObjectReadGrantInput>) {
    if (this.grant === undefined || this.grant.objectReadGrantId !== input.objectReadGrantId) {
      throw new ObjectReadGrantError('not-ready', 'object-read-grant-not-found', 404);
    }
    const key = `${input.caller.appId}:${input.duplicateProtectionKey}`;
    const prior = this.revokes.get(key);
    if (prior !== undefined && prior !== input.requestFingerprint) {
      throw new ObjectReadGrantError('duplicate-conflict', 'idempotency-key-reused', 409);
    }
    const replayed = prior !== undefined;
    this.revokes.set(key, input.requestFingerprint);
    if (this.grant.state === 'active') {
      this.grant = Object.freeze({
        ...this.grant,
        state: 'revoked',
        revokedAt: NOW.toISOString(),
        rowVersion: this.grant.rowVersion + 1,
      });
    }
    return Object.freeze({ replayed, grant: this.grant });
  }

  async getForDelivery(input: { objectReadGrantId: string; storageObjectId: string; caller: { appId: string; serviceId?: string }; now: Date }) {
    if (
      this.grant === undefined ||
      this.grant.objectReadGrantId !== input.objectReadGrantId ||
      this.grant.storageObjectId !== input.storageObjectId ||
      this.grant.callerAppId !== input.caller.appId ||
      (this.grant.callerServiceId ?? '') !== (input.caller.serviceId ?? '')
    ) return null;
    return this.grant;
  }

  async resolveObjectForRead(input: { storageObjectId: string; managedAppId: string }) {
    return input.storageObjectId === this.object.storageObjectId && input.managedAppId === IDS.app
      ? this.object
      : null;
  }

  async beginReadAttempt(input: Readonly<ObjectReadAttemptInput>) {
    const id = randomUUID();
    this.attempts.push({ id, input });
    return id;
  }

  async completeReadAttempt(input: { providerAttemptId: string; succeeded: boolean }) {
    const attempt = this.attempts.find((entry) => entry.id === input.providerAttemptId);
    assert.ok(attempt !== undefined);
    attempt.outcome = input.succeeded;
  }

  async appendReadEvent(input: { eventType: string; payload: Readonly<Record<string, unknown>> }) {
    this.events.push({ type: input.eventType, payload: input.payload });
  }
}

class FakeReader implements ProviderObjectReader {
  readonly calls: ProviderObjectReadInput[] = [];
  hotFailure?: ProviderReadError;
  canonicalFailure?: ProviderReadError;
  midstreamFailure = false;
  destroyCount = 0;

  async read(input: Readonly<ProviderObjectReadInput>): Promise<Readonly<ProviderObjectReadReceipt>> {
    this.calls.push(input);
    if (input.target.providerRole === 'hot' && this.hotFailure !== undefined) throw this.hotFailure;
    if (input.target.providerRole === 'canonical' && this.canonicalFailure !== undefined) {
      throw this.canonicalFailure;
    }
    const selected = input.range === undefined
      ? DATA
      : DATA.slice(input.range.start, input.range.end + 1);
    const destroy = () => { this.destroyCount += 1; };
    if (input.method === 'HEAD') return Object.freeze({ observedByteLength: DATA.length, destroy });
    if (this.midstreamFailure) {
      let calls = 0;
      return Object.freeze({
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            calls += 1;
            if (calls === 1) controller.enqueue(selected.slice(0, 3));
            else controller.error(new Error('provider-private-body'));
          },
        }),
        destroy,
      });
    }
    return Object.freeze({
      body: new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(selected); controller.close(); },
      }),
      observedByteLength: selected.length,
      destroy,
    });
  }
}

function headers(extra: Record<string, string> = {}): Headers {
  return new Headers({
    authorization: 'Bearer caller-token',
    'x-zs-caller-app': 'video-maker_app',
    'x-zs-contract-version': '1.0',
    'x-app-correlation-reference': 'resource-01',
    ...extra,
  });
}

function createHarness() {
  const registry = new MemoryRegistry();
  const reader = new FakeReader();
  const tokenService = createObjectReadGrantTokenService(Buffer.alloc(32, 9));
  let id = 0;
  const runtime = createReadDeliveryHttpStorageRuntime({
    authenticate: (token) => token === 'caller-token' ? { appId: 'video-maker_app', serviceId: 'api' } : null,
    authorizeCaller: () => true,
    registry,
    tokenService,
    providerReader: reader,
    now: () => NOW,
    createId: () => {
      id += 1;
      return `00000000-0000-4000-8000-${String(300 + id).padStart(12, '0')}`;
    },
  });
  return { registry, reader, tokenService, runtime };
}

async function issueGrant(
  harness: ReturnType<typeof createHarness>,
  overrides: Record<string, unknown> = {},
  key = 'read-01',
) {
  const request = new Request('https://storage.test/v1/object-read-grants', {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json', 'idempotency-key': key }),
    body: JSON.stringify({
      storageObjectId: IDS.object,
      purpose: 'resource-preview',
      allowedMethods: ['HEAD', 'GET'],
      allowRange: true,
      disposition: 'inline',
      fileName: 'preview.mp4',
      requestedTtlSeconds: 300,
      businessAuthorizationReference: 'permission-check-01',
      ...overrides,
    }),
  });
  const response = await harness.runtime.handle(request);
  const body = await response.json() as { result?: { objectReadGrantId: string; readGrantToken: string; duplicateProtection: { replayed: boolean } }; error?: unknown };
  return { response, body };
}

async function deliveryRequest(
  harness: ReturnType<typeof createHarness>,
  token: string,
  method: 'GET' | 'HEAD' = 'GET',
  range?: string,
  objectId: string = IDS.object,
) {
  return harness.runtime.handle(new Request(`https://storage.test/v1/storage-objects/${objectId}/content`, {
    method,
    headers: headers({
      'x-zs-read-grant-token': token,
      ...(range === undefined ? {} : { range }),
    }),
  }));
}

test('single byte ranges cover closed, open, suffix, and 416 forms', () => {
  assert.deepEqual(parseSingleByteRange('bytes=2-5', 10, true, 'GET'), {
    start: 2, end: 5, length: 4, contentRange: 'bytes 2-5/10', providerRange: 'bytes=2-5',
  });
  assert.deepEqual(parseSingleByteRange('bytes=7-', 10, true, 'GET'), {
    start: 7, end: 9, length: 3, contentRange: 'bytes 7-9/10', providerRange: 'bytes=7-9',
  });
  assert.deepEqual(parseSingleByteRange('bytes=-4', 10, true, 'GET'), {
    start: 6, end: 9, length: 4, contentRange: 'bytes 6-9/10', providerRange: 'bytes=6-9',
  });
  for (const range of ['items=1-2', 'bytes=1-2,4-5', 'bytes=20-', 'bytes=-0', 'bytes=a-b']) {
    assert.throws(() => parseSingleByteRange(range, 10, true, 'GET'), (error: unknown) =>
      error instanceof ObjectReadGrantError && error.status === 416);
  }
  assert.throws(() => parseSingleByteRange('bytes=0-1', 10, false, 'GET'), (error: unknown) =>
    error instanceof ObjectReadGrantError && error.status === 403);
});

test('grant issue replays exactly and conflicts on a changed payload', async () => {
  const harness = createHarness();
  const first = await issueGrant(harness);
  assert.equal(first.response.status, 201);
  assert.equal(first.body.result?.duplicateProtection.replayed, false);
  const second = await issueGrant(harness);
  assert.equal(second.response.status, 201);
  assert.equal(second.body.result?.duplicateProtection.replayed, true);
  assert.equal(second.body.result?.readGrantToken, first.body.result?.readGrantToken);
  const conflict = await issueGrant(harness, { purpose: 'different-purpose' });
  assert.equal(conflict.response.status, 409);
  assert.ok(!JSON.stringify(conflict.body).includes(first.body.result?.readGrantToken ?? 'never'));
});

test('revoke is scope-bound and idempotent', async () => {
  const harness = createHarness();
  const issued = await issueGrant(harness);
  const grantId = issued.body.result?.objectReadGrantId;
  assert.ok(grantId !== undefined);
  const revoke = () => harness.runtime.handle(new Request(`https://storage.test/v1/object-read-grants/${grantId}`, {
    method: 'DELETE',
    headers: headers({ 'idempotency-key': 'revoke-01' }),
  }));
  assert.equal((await revoke()).status, 200);
  const replay = await revoke();
  const body = await replay.json() as { result: { state: string; duplicateProtection: { replayed: boolean } } };
  assert.equal(body.result.state, 'revoked');
  assert.equal(body.result.duplicateProtection.replayed, true);
  const delivery = await deliveryRequest(harness, issued.body.result?.readGrantToken ?? '');
  assert.equal(delivery.status, 403);
  assert.equal(harness.reader.calls.length, 0);
});

test('full GET, HEAD, and byte-range GET return trusted exact headers', async () => {
  const harness = createHarness();
  const issued = await issueGrant(harness);
  const token = issued.body.result?.readGrantToken ?? '';

  const full = await deliveryRequest(harness, token);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(full.headers.get('content-length'), String(DATA.length));
  assert.equal(full.headers.get('etag'), `"sha256-${CHECKSUM}"`);
  assert.equal(full.headers.get('x-zs-delivery-state'), 'hot');
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), DATA);

  const head = await deliveryRequest(harness, token, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('content-length'), String(DATA.length));

  const ranged = await deliveryRequest(harness, token, 'GET', 'bytes=5-9');
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 5-9/${DATA.length}`);
  assert.equal(ranged.headers.get('content-length'), '5');
  assert.deepEqual(new Uint8Array(await ranged.arrayBuffer()), DATA.slice(5, 10));
  assert.ok(harness.reader.calls.every((call) => call.target.providerRole === 'hot'));
});

test('hot initial failure falls back once to canonical; hot success leaves canonical untouched', async () => {
  const harness = createHarness();
  const issued = await issueGrant(harness);
  const token = issued.body.result?.readGrantToken ?? '';
  const hot = await deliveryRequest(harness, token);
  await hot.arrayBuffer();
  assert.deepEqual(harness.reader.calls.map((call) => call.target.providerRole), ['hot']);

  harness.reader.calls.length = 0;
  harness.reader.hotFailure = new ProviderReadError('provider-object-missing', false, true);
  const fallback = await deliveryRequest(harness, token);
  assert.equal(fallback.status, 200);
  assert.equal(fallback.headers.get('x-zs-delivery-state'), 'canonical-fallback');
  await fallback.arrayBuffer();
  assert.deepEqual(harness.reader.calls.map((call) => call.target.providerRole), ['hot', 'canonical']);
});

test('grant, method, Range, token, and object refusals occur before provider access', async () => {
  const harness = createHarness();
  const issued = await issueGrant(harness, { allowedMethods: ['HEAD'], allowRange: false });
  const token = issued.body.result?.readGrantToken ?? '';
  assert.equal((await deliveryRequest(harness, token, 'GET')).status, 403);
  assert.equal((await deliveryRequest(harness, token, 'HEAD', 'bytes=0-1')).status, 403);
  assert.equal((await deliveryRequest(harness, `${token}x`)).status, 401);
  assert.equal((await deliveryRequest(harness, token, 'HEAD', undefined, '00000000-0000-4000-8000-000000000299')).status, 403);
  assert.equal(harness.reader.calls.length, 0);
});

test('malformed and unsatisfiable ranges return 416 with verified size and no provider access', async () => {
  const harness = createHarness();
  const issued = await issueGrant(harness);
  const token = issued.body.result?.readGrantToken ?? '';
  for (const range of ['bytes=1-2,4-5', `bytes=${DATA.length}-`, 'items=1-2']) {
    const response = await deliveryRequest(harness, token, 'GET', range);
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), `bytes */${DATA.length}`);
  }
  assert.equal(harness.reader.calls.length, 0);
});

test('unverified copy is never used and both unavailable produces bounded failure', async () => {
  const harness = createHarness();
  const issued = await issueGrant(harness);
  const token = issued.body.result?.readGrantToken ?? '';
  const canonicalTarget = harness.registry.object.targets.canonical;
  assert.ok(canonicalTarget !== undefined);
  harness.registry.object = Object.freeze({
    ...harness.registry.object,
    targets: Object.freeze({ canonical: canonicalTarget }),
  });
  const canonical = await deliveryRequest(harness, token);
  await canonical.arrayBuffer();
  assert.deepEqual(harness.reader.calls.map((call) => call.target.providerRole), ['canonical']);

  harness.reader.calls.length = 0;
  harness.reader.canonicalFailure = new ProviderReadError('provider-read-unavailable', true, true);
  const failed = await deliveryRequest(harness, token);
  assert.equal(failed.status, 503);
  const text = await failed.text();
  assert.ok(!/bucket|endpoint|locator|secret|safe\/canonical/i.test(text));
});

test('midstream errors are contained and provider cleanup is invoked', async () => {
  const harness = createHarness();
  const issued = await issueGrant(harness);
  harness.reader.midstreamFailure = true;
  const response = await deliveryRequest(harness, issued.body.result?.readGrantToken ?? '');
  await assert.rejects(response.arrayBuffer(), /object-read-stream-failed/);
  assert.equal(harness.reader.destroyCount, 1);
  assert.equal(harness.registry.attempts.at(-1)?.outcome, false);
  assert.ok(harness.registry.events.some((entry) => entry.type === 'object-read.failed'));
});

test('deterministic token claims remain exactly bound to the persisted grant', async () => {
  const harness = createHarness();
  const issued = await issueGrant(harness);
  assert.ok(harness.registry.grant !== undefined);
  const expected = harness.tokenService.issue(createObjectReadGrantClaims({
    grant: harness.registry.grant,
    contractVersion: '1.0',
  }));
  assert.equal(issued.body.result?.readGrantToken, expected);
});
