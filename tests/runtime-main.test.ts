import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { createHttpStorageRuntime } from '../src/index.js';
import { createNodeHttpHandler } from '../src/node-http-adapter.js';
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

test('operator command and Zimspace manifest expose the composed local Z-s runtime', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
    readonly scripts?: Record<string, string>;
  };
  const manifest = JSON.parse(await readFile('zimspace.app.json', 'utf8')) as {
    readonly projects?: readonly {
      readonly apps?: readonly {
        readonly id?: string;
        readonly port?: number;
        readonly startCommand?: string;
        readonly healthCheckUrl?: string;
        readonly publicUrl?: string;
        readonly actionsEnabled?: boolean;
      }[];
    }[];
  };
  const runtimeMain = await readFile('src/runtime-main.ts', 'utf8');
  const runtimeComposition = await readFile('src/runtime-local-composition.ts', 'utf8');
  const verifier = await readFile('scripts/verify-video-maker-runtime.mjs', 'utf8');

  const runtimeApp = manifest.projects
    ?.flatMap((project) => project.apps ?? [])
    .find((app) => app.id === 'z-s-runtime-api');

  assert.equal(
    packageJson.scripts?.['local:start'],
    'npm run build && node --enable-source-maps dist/runtime-main.js',
  );
  assert.equal(runtimeApp?.port, 4310);
  assert.equal(runtimeApp?.startCommand, 'npm run local:start');
  assert.equal(runtimeApp?.healthCheckUrl, 'http://127.0.0.1:4310/healthz');
  assert.equal(runtimeApp?.publicUrl, 'https://z-s.zimmon.ai');
  assert.equal(runtimeApp?.actionsEnabled, true);
  assert.match(runtimeMain, /createVideoMakerRuntimeComposition/);
  assert.doesNotMatch(runtimeMain, /local-runtime-placeholder|write runtime is not configured/);
  assert.match(runtimeComposition, /PostgresRuntimeStorageRegistry/);
  assert.match(runtimeComposition, /DualProviderObjectIngestAdapter/);
  assert.match(runtimeComposition, /PostgresObjectReadRegistry/);
  assert.match(runtimeComposition, /S3CompatibleProviderObjectReader/);
  assert.match(runtimeComposition, /BoundedMediaVerifier/);
  assert.match(verifier, /--confirm-live-actions/);
  assert.doesNotMatch(verifier, /commonHeaders\(configuration, `\$\{suffix\}-upload`\)/);
  assert.doesNotMatch(verifier, /commonHeaders\(configuration, `\$\{suffix\}-cancel`\)/);
  assert.doesNotMatch(verifier, /commonHeaders\(configuration, 'cancel-upload'\)/);
  for (const scenario of [
    'png-write-read',
    'mp4-write-read-range',
    'duplicate-replay',
    'cancel-before-content',
    'hot-read-fallback',
    'revoke-read-grant',
    'cleanup-only',
  ]) {
    assert.match(verifier, new RegExp(scenario));
  }
});

test('one listener preserves write routes and falls through only to read routes', async () => {
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

test('health and readiness come from the real write dependency graph', async () => {
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

test('Node HTTP adapter serves health and preserves auth failures', async () => {
  const runtime = createHttpStorageRuntime({
    authenticate: () => null,
    authorizeCaller: () => false,
    resolveStorageProfile: () => {
      throw new Error('not used');
    },
    createObjectWriteIntent: () => {
      throw new Error('not used');
    },
    controlPlaneReadiness: () => ({ status: 'ready' }),
    dataPlaneReadiness: () => ({ status: 'ready' }),
  });
  const server = createServer(createNodeHttpHandler(runtime));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(typeof address === 'object' && address !== null);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    const healthBody = await health.json() as Record<string, unknown>;
    assert.equal(healthBody.serviceId, 'z-s');

    const protectedResponse = await fetch(`${baseUrl}/v1/object-write-intents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-zs-contract-version': '1.0',
      },
      body: '{}',
    });
    assert.equal(protectedResponse.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve();
      });
    });
  }
});

test('upload completion responses preserve dual-provider protection stages', async () => {
  const runtime = createHttpStorageRuntime({
    authenticate: () => ({ appId: 'video-maker_app', serviceId: 'api' }),
    authorizeCaller: () => true,
    resolveStorageProfile: () => {
      throw new Error('not used');
    },
    createObjectWriteIntent: () => {
      throw new Error('not used');
    },
    uploadCompletionTokenService: {
      issue: () => 'not-used',
      verify: () => ({
        purpose: 'object-upload-completion',
        objectWriteIntentId: '00000000-0000-4000-8000-000000000001',
        storageObjectId: '00000000-0000-4000-8000-000000000002',
        callerAppId: 'video-maker_app',
        callerServiceId: 'api',
        contractVersion: '1.0',
        expiresAt: '2026-07-17T00:15:00.000Z',
      }),
    },
    completeObjectUpload: () => ({
      storageObjectId: '00000000-0000-4000-8000-000000000002',
      writeIntentId: '00000000-0000-4000-8000-000000000001',
      state: 'recorded',
      checksumSha256: 'a'.repeat(64),
      byteLength: 1,
      integrityVerification: {
        verified: true,
        checksumVerified: true,
        sizeVerified: true,
        sizeVerificationDisposition: 'matched',
      },
      objectProtectionStage: 'canonical-and-hot-verified',
      storageState: 'ready',
      verifiedMedia: {
        mediaType: 'image/png',
        mediaFamily: 'image',
        image: { width: 1, height: 1 },
      },
      copies: {
        hot: { state: 'verified', retryable: false },
        canonical: { state: 'verified', retryable: false },
      },
    }),
    controlPlaneReadiness: () => ({ status: 'ready' }),
    dataPlaneReadiness: () => ({ status: 'ready' }),
    now: () => new Date('2026-07-17T00:00:00.000Z'),
  });

  const response = await runtime.handle(new Request(
    'http://z-s/v1/object-write-intents/00000000-0000-4000-8000-000000000001/content',
    {
      method: 'PUT',
      headers: {
        authorization: 'Bearer valid-token',
        'x-zs-caller-app': 'video-maker_app',
        'x-zs-contract-version': '1.0',
        'x-app-correlation-reference': 'resource-01',
        'idempotency-key': 'complete-dual-provider',
        'x-zs-upload-completion-token': 'valid-token',
        'x-content-sha256': 'a'.repeat(64),
        'content-type': 'image/png',
        'content-length': '1',
      },
      body: new Uint8Array([1]),
    },
  ));

  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal((body.result as Record<string, unknown>).objectProtectionStage, 'canonical-and-hot-verified');
});
