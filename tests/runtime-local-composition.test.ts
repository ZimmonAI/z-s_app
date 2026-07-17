import assert from 'node:assert/strict';
import test from 'node:test';
import type { HttpStorageRuntime } from '../src/runtime-contract.js';
import {
  composeStorageRuntimeRoutes,
  createRuntimeProviderCredentialResolver,
  isObjectReadGrantCallerAllowed,
} from '../src/runtime-local-composition.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function runtime(options: {
  handle(request: Request): Promise<Response> | Response;
  readiness?: 'ready' | 'not-ready';
}): HttpStorageRuntime {
  return Object.freeze({
    handle: async (request: Request) => options.handle(request),
    health: async () => Object.freeze({
      serviceId: 'z-s',
      packageVersion: '0.5.0',
      contractVersion: '1.0',
      process: 'healthy',
      checkedAt: '2026-07-17T00:00:00.000Z',
    }),
    readiness: async () => Object.freeze({
      serviceId: 'z-s',
      process: 'healthy',
      controlPlane: Object.freeze({ status: options.readiness ?? 'ready' }),
      dataPlane: Object.freeze({ status: options.readiness ?? 'ready' }),
      status: options.readiness ?? 'ready',
      checkedAt: '2026-07-17T00:00:00.000Z',
    }),
  });
}

const routeNotFound = (): Response => json({
  contractVersion: '1.0',
  error: {
    diagnostic: {
      category: 'invalid-request',
      code: 'route-not-found',
      retryable: false,
    },
  },
}, 404);

test('one composed listener preserves write routes and falls through to read routes', async () => {
  let readDispatches = 0;
  const writeRuntime = runtime({
    handle(request) {
      const path = new URL(request.url).pathname;
      if (path === '/v1/object-write-intents') return json({ route: 'write' }, 201);
      return routeNotFound();
    },
  });
  const readRuntime = runtime({
    async handle(request) {
      readDispatches += 1;
      const payload = await request.json() as Record<string, unknown>;
      return json({ route: 'read', purpose: payload.purpose }, 201);
    },
  });
  const composed = composeStorageRuntimeRoutes(writeRuntime, readRuntime);

  const writeResponse = await composed.handle(new Request('http://z-s/v1/object-write-intents', {
    method: 'POST',
    body: '{}',
    headers: { 'content-type': 'application/json' },
  }));
  assert.equal(writeResponse.status, 201);
  assert.deepEqual(await writeResponse.json(), { route: 'write' });
  assert.equal(readDispatches, 0);

  const readResponse = await composed.handle(new Request('http://z-s/v1/object-read-grants', {
    method: 'POST',
    body: JSON.stringify({ purpose: 'video-output' }),
    headers: { 'content-type': 'application/json' },
  }));
  assert.equal(readResponse.status, 201);
  assert.deepEqual(await readResponse.json(), { route: 'read', purpose: 'video-output' });
  assert.equal(readDispatches, 1);
});

test('operation-level 404 responses never dispatch to the fallback runtime', async () => {
  let fallbackCalled = false;
  const composed = composeStorageRuntimeRoutes(
    runtime({
      handle: () => json({
        error: {
          diagnostic: {
            category: 'not-ready',
            code: 'object-write-intent-not-found',
            retryable: false,
          },
        },
      }, 404),
    }),
    runtime({
      handle: () => {
        fallbackCalled = true;
        return json({ unexpected: true });
      },
    }),
  );

  const response = await composed.handle(new Request(
    'http://z-s/v1/object-write-intents/00000000-0000-4000-8000-000000000001/content',
    { method: 'PUT', body: new Uint8Array([1]) },
  ));
  assert.equal(response.status, 404);
  assert.equal(fallbackCalled, false);
});

test('health and readiness come from the real write runtime dependency graph', async () => {
  const composed = composeStorageRuntimeRoutes(
    runtime({ handle: routeNotFound, readiness: 'not-ready' }),
    runtime({ handle: routeNotFound, readiness: 'ready' }),
  );
  assert.equal((await composed.health()).process, 'healthy');
  assert.equal((await composed.readiness()).status, 'not-ready');
});

test('read grant caller allowlist is exact', () => {
  assert.equal(isObjectReadGrantCallerAllowed({ appId: 'video-maker_app', serviceId: 'api' }), true);
  assert.equal(isObjectReadGrantCallerAllowed({ appId: 'z-x_app', serviceId: 'api' }), true);
  assert.equal(isObjectReadGrantCallerAllowed({ appId: 'video-maker_app', serviceId: 'worker' }), false);
  assert.equal(isObjectReadGrantCallerAllowed({ appId: 'other_app', serviceId: 'api' }), false);
});

test('provider credential resolver exposes only exact runtime secret references', async () => {
  const safeAccessKey = ['runtime', 'access', 'key'].join('-');
  const safeSecretKey = ['runtime', 'secret', 'key'].join('-');
  const raw = JSON.stringify({
    'credential-binding:r2_video_maker_dev_01': {
      endpoint: 'https://r2.invalid.example',
      region: 'auto',
      forcePathStyle: false,
      accessKeyId: safeAccessKey,
      ['secretAccessKey']: safeSecretKey,
    },
  });
  const resolver = createRuntimeProviderCredentialResolver(raw);
  assert.equal(resolver.configured, true);
  assert.equal(resolver.has(['credential-binding:r2_video_maker_dev_01']), true);
  assert.equal(resolver.has(['credential-binding:minio_zimspace_local_pc_01']), false);
  const resolved = await resolver.resolve('credential-binding:r2_video_maker_dev_01');
  assert.equal(resolved.region, 'auto');
  assert.equal(resolved.forcePathStyle, false);

  await assert.rejects(
    async () => resolver.resolve('credential-binding:minio_zimspace_local_pc_01'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'provider-credential-binding-unavailable');
      assert.doesNotMatch(error.stack ?? '', new RegExp(`${safeSecretKey}|${safeAccessKey}`));
      return true;
    },
  );
});

test('malformed credential configuration remains safely not configured', async () => {
  const resolver = createRuntimeProviderCredentialResolver('{not-json');
  assert.equal(resolver.configured, false);
  assert.equal(resolver.has(['credential-binding:r2_video_maker_dev_01']), false);
  await assert.rejects(
    async () => resolver.resolve('credential-binding:r2_video_maker_dev_01'),
    /provider-credential-binding-unavailable/,
  );
});
