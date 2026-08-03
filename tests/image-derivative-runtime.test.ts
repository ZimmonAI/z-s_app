import assert from 'node:assert/strict';
import test from 'node:test';
import { issueSignedSession } from '../src/control-plane-session.js';
import {
  createUnavailableImageDerivativeStore,
  type ImageDerivativeStore,
} from '../src/image-derivative.js';
import { createImageDerivativeRuntime } from '../src/image-derivative-runtime.js';
import type { HttpStorageRuntime } from '../src/runtime-contract.js';

const SIGNING_KEY = 'test-session-signing-key';
const NOW = new Date('2026-08-03T08:00:00.000Z');

function sessionCookie(clientId: string): string {
  const token = issueSignedSession({
    cookieName: 'zs_client_session',
    subject: `z-s-client:${clientId}`,
    ttlSeconds: 3600,
    signingKey: SIGNING_KEY,
  }, NOW);
  return `zs_client_session=${token}`;
}

function baseRuntime(): HttpStorageRuntime {
  return Object.freeze({
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === '/client/storage/configuration') {
        return new Response('<main><section aria-labelledby="activity-title">activity</section></main>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (request.method === 'PUT') {
        return new Response(JSON.stringify({ result: {
          storageObjectId: '00000000-0000-4000-8000-000000000010',
          state: 'recorded',
        } }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    },
    async health() { return Object.freeze({ process: 'healthy' }); },
    async readiness() { return Object.freeze({ status: 'ready' }); },
  });
}

test('same-client browser session can read bounded derivative status', async () => {
  const observed: unknown[][] = [];
  const store: ImageDerivativeStore = {
    configured: true,
    async enqueueVerifiedSource() { return 0; },
    async listStatus(...args) {
      observed.push(args);
      return [{
        jobId: 'job-1', sourceStorageObjectId: 'source-1', presetId: 'preview',
        width: 512, format: 'png', state: 'succeeded', attemptCount: 1,
        createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      }];
    },
    async claimNext() { return null; },
    async complete() {},
    async fail() {},
  };
  const runtime = createImageDerivativeRuntime(baseRuntime(), {
    store,
    sessionSigningKey: SIGNING_KEY,
    now: () => NOW,
  });
  const response = await runtime.handle(new Request(
    'https://example.test/client/storage/image-derivatives?environment=prod',
    { headers: { cookie: sessionCookie('client-one') } },
  ));
  assert.equal(response.status, 200);
  const payload = await response.json() as { result: unknown[] };
  assert.equal(payload.result.length, 1);
  assert.deepEqual(observed, [['client-one', 'prod', 50]]);
});

test('integration bearer token alone cannot authorize derivative status', async () => {
  const runtime = createImageDerivativeRuntime(baseRuntime(), {
    store: createUnavailableImageDerivativeStore(),
    sessionSigningKey: SIGNING_KEY,
    now: () => NOW,
  });
  const response = await runtime.handle(new Request(
    'https://example.test/client/storage/image-derivatives?environment=dev',
    { headers: { authorization: 'Bearer runtime-token' } },
  ));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: { code: 'client-login-required' } });
});

test('workspace remains usable and receives an additive unavailable-capable status section', async () => {
  const runtime = createImageDerivativeRuntime(baseRuntime(), {
    store: createUnavailableImageDerivativeStore(),
    sessionSigningKey: SIGNING_KEY,
    now: () => NOW,
  });
  const response = await runtime.handle(new Request(
    'https://example.test/client/storage/configuration?environment=dev',
    { headers: { cookie: sessionCookie('client-one') } },
  ));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /data-image-derivative-status/);
  assert.match(html, /safe metadata only/);
  assert.match(html, /activity/);
  assert.doesNotMatch(html, /secret_reference|internal_locator|signed_url/i);
});

test('successful upload completion is preserved while enqueue runs idempotently', async () => {
  const enqueued: string[] = [];
  const store: ImageDerivativeStore = {
    configured: true,
    async enqueueVerifiedSource(id) { enqueued.push(id); return 2; },
    async listStatus() { return []; },
    async claimNext() { return null; },
    async complete() {},
    async fail() {},
  };
  const runtime = createImageDerivativeRuntime(baseRuntime(), { store, now: () => NOW });
  const response = await runtime.handle(new Request(
    'https://example.test/v1/object-write-intents/00000000-0000-4000-8000-000000000011/content',
    { method: 'PUT', body: 'image' },
  ));
  assert.equal(response.status, 200);
  assert.deepEqual(enqueued, ['00000000-0000-4000-8000-000000000010']);
  const payload = await response.json() as { result: { state: string } };
  assert.equal(payload.result.state, 'recorded');
});
