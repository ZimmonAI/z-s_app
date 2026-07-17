import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createNodeHttpHandler } from '../src/node-http-adapter.js';
import {
  PostgresVideoMakerAuthorityResolver,
  RuntimeCompositionError,
  createRuntimeLocalComposition,
  type ClosableRuntimePool,
} from '../src/runtime-local-composition.js';
import {
  EnvironmentProviderCredentialResolver,
  readRuntimeEnvironment,
} from '../src/runtime-environment.js';
import type {
  PostgresClientLike,
  PostgresQueryResult,
} from '../src/runtime-storage-registry-types.js';

const OBJECT_ID = '00000000-0000-4000-8000-000000000101';
const AUTHORITY_IDS = {
  managedApp: '00000000-0000-4000-8000-000000000001',
  profile: '00000000-0000-4000-8000-000000000002',
  prefix: '00000000-0000-4000-8000-000000000003',
  hotBinding: '00000000-0000-4000-8000-000000000004',
  canonicalBinding: '00000000-0000-4000-8000-000000000005',
} as const;

async function listen(runtime: ReturnType<typeof createRuntimeLocalComposition>): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = createServer(createNodeHttpHandler(runtime.runtime));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(typeof address === 'object' && address !== null);
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) reject(error);
          else resolve();
        });
      });
      await runtime.close();
    },
  };
}

test('real runtime composition mounts write and read route families on one listener', async () => {
  const composition = createRuntimeLocalComposition({ environment: {} });
  const server = await listen(composition);
  try {
    const health = await fetch(`${server.baseUrl}/healthz`);
    assert.equal(health.status, 200);
    const ready = await fetch(`${server.baseUrl}/readyz`);
    assert.equal(ready.status, 503);
    const readyBody = await ready.json() as {
      readonly status?: string;
      readonly controlPlane?: { readonly code?: string };
      readonly dataPlane?: { readonly code?: string };
    };
    assert.equal(readyBody.status, 'not-ready');
    assert.equal(readyBody.controlPlane?.code, 'database-url-missing');
    assert.ok(typeof readyBody.dataPlane?.code === 'string');

    const routes: ReadonlyArray<Readonly<{ method: string; path: string; body?: string }>> = [
      { method: 'POST', path: '/v1/object-write-intents', body: '{}' },
      { method: 'PUT', path: `/v1/object-write-intents/${OBJECT_ID}/content`, body: 'x' },
      { method: 'DELETE', path: `/v1/object-write-intents/${OBJECT_ID}` },
      { method: 'POST', path: '/v1/object-read-grants', body: '{}' },
      { method: 'DELETE', path: `/v1/object-read-grants/${OBJECT_ID}` },
      { method: 'HEAD', path: `/v1/storage-objects/${OBJECT_ID}/content` },
      { method: 'GET', path: `/v1/storage-objects/${OBJECT_ID}/content` },
    ];
    for (const route of routes) {
      const response = await fetch(`${server.baseUrl}${route.path}`, {
        method: route.method,
        headers: {
          'content-type': 'application/json',
          'x-zs-contract-version': '1.0',
        },
        ...(route.body === undefined ? {} : { body: route.body }),
      });
      assert.equal(response.status, 401, `${route.method} ${route.path}`);
    }
    const missing = await fetch(`${server.baseUrl}/not-a-route`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});

test('environment resolver uses secret-reference mappings without serializing secret values', async () => {
  const environment: NodeJS.ProcessEnv = {
    Z_S_DATABASE_URL: 'postgresql://runtime.invalid/z-s',
    Z_S_UPLOAD_COMPLETION_SIGNING_KEY: 'u'.repeat(32),
    Z_S_OBJECT_READ_GRANT_SIGNING_KEY: 'r'.repeat(32),
    Z_S_PROVIDER_SECRET_BINDINGS_JSON: JSON.stringify({
      'provider-ref': {
        endpointEnv: 'TEST_PROVIDER_ENDPOINT',
        regionEnv: 'TEST_PROVIDER_REGION',
        forcePathStyle: true,
        accessKeyIdEnv: 'TEST_PROVIDER_ACCESS_KEY',
        secretAccessKeyEnv: 'TEST_PROVIDER_SECRET_KEY',
      },
    }),
    TEST_PROVIDER_ENDPOINT: 'https://provider.invalid',
    TEST_PROVIDER_REGION: 'auto',
    TEST_PROVIDER_ACCESS_KEY: 'access-value',
    TEST_PROVIDER_SECRET_KEY: 'secret-value',
  };
  const configuration = readRuntimeEnvironment(environment);
  assert.deepEqual(configuration.safeConfigurationCodes, []);
  const resolver = new EnvironmentProviderCredentialResolver({
    environment,
    bindings: configuration.providerSecretBindings,
  });
  assert.equal(resolver.readinessCode('provider-ref'), undefined);
  const resolved = await resolver.resolve('provider-ref');
  assert.equal(resolved.endpoint, 'https://provider.invalid');
  assert.equal(resolved.forcePathStyle, true);
  const serializedConfiguration = JSON.stringify(configuration);
  assert.equal(serializedConfiguration.includes('access-value'), false);
  assert.equal(serializedConfiguration.includes('secret-value'), false);
});

function capabilityRows(): Array<Record<string, unknown>> {
  const capabilities = ['put', 'head', 'get', 'delete', 'checksum', 'size', 'range'] as const;
  return ['r2_video_maker_dev_01', 'minio_zimspace_local_pc_01'].flatMap((providerId) =>
    capabilities.map((capability) => ({
      capability_run_id: `run-${providerId}-${capability}`,
      provider_id: providerId,
      bucket_label:
        providerId === 'r2_video_maker_dev_01'
          ? 'video-maker-hot'
          : 'zs-dev-app-video-maker-canon',
      capability,
      result: 'passed',
      verified_at: '2026-07-17T00:00:00.000Z',
      expires_at: '2026-08-17T00:00:00.000Z',
    })),
  );
}

function authorityPool(input: { authorityPresent?: boolean } = {}): ClosableRuntimePool {
  const client: PostgresClientLike = {
    async query<Row extends Record<string, unknown>>(
      text: string,
    ): Promise<PostgresQueryResult<Row>> {
      if (text.includes('SELECT 1 AS ready')) {
        return { rows: [{ ready: 1 } as unknown as Row], rowCount: 1 };
      }
      if (text.includes('FROM public.managed_apps')) {
        if (input.authorityPresent === false) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            managed_app_id: AUTHORITY_IDS.managedApp,
            caller_app_id: 'video-maker_app',
            environment: 'dev',
            storage_profile_id: AUTHORITY_IDS.profile,
            profile_id: 'video-maker-dev-default',
            profile_version: 1,
            storage_prefix_class_id: AUTHORITY_IDS.prefix,
            prefix_class_id: 'user-resources',
            normalized_prefix_pattern: 'video-maker/user-resources/*',
            hot_binding_id: AUTHORITY_IDS.hotBinding,
            hot_provider_id: 'r2_video_maker_dev_01',
            hot_bucket_label: 'video-maker-hot',
            hot_secret_reference_id: 'r2-ref',
            canonical_binding_id: AUTHORITY_IDS.canonicalBinding,
            canonical_provider_id: 'minio_zimspace_local_pc_01',
            canonical_bucket_label: 'zs-dev-app-video-maker-canon',
            canonical_secret_reference_id: 'minio-ref',
          } as unknown as Row],
          rowCount: 1,
        };
      }
      if (text.includes('FROM public.storage_profile_provider_bindings')) {
        const rows = capabilityRows() as Row[];
        return { rows, rowCount: rows.length };
      }
      throw new Error('unexpected-query');
    },
    release(): void {
      // No resource is held by the fake client.
    },
  };
  return {
    connect: async () => client,
    async end(): Promise<void> {
      // No resource is held by the fake pool.
    },
  };
}

test('PostgreSQL authority resolution binds exact aliases and derives required Range readiness', async () => {
  const resolver = new PostgresVideoMakerAuthorityResolver({
    pool: authorityPool(),
    maximumObjectByteLength: 1024 * 1024,
    now: () => new Date('2026-07-17T12:00:00.000Z'),
  });
  const authority = await resolver.resolveExpected();
  assert.equal(authority.profile.profileId, 'video-maker-dev-default');
  assert.equal(authority.profile.profileVersion, 1);
  assert.equal(authority.profile.capabilityPolicy.rangeRead, 'required');
  assert.deepEqual(authority.profile.writePolicy?.allowedMediaTypes, ['image/png', 'video/mp4']);
  assert.equal(authority.writeAuthority.managedAppId, AUTHORITY_IDS.managedApp);
  assert.equal(authority.writeAuthority.hotProviderBindingId, AUTHORITY_IDS.hotBinding);
  assert.equal(authority.writeAuthority.canonicalProviderBindingId, AUTHORITY_IDS.canonicalBinding);
  assert.match(authority.profile.safeFingerprint, /^zs-profile-v1:[a-f0-9]{64}$/);

  await assert.rejects(
    resolver.resolve(
      { profileId: 'other', profileVersion: 1, environment: 'dev' },
      { appId: 'video-maker_app', serviceId: 'api' },
    ),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeCompositionError);
      assert.equal(error.code, 'video-maker-storage-authority-denied');
      return true;
    },
  );
});

test('runtime readiness becomes ready only for exact database authority and secret bindings', async () => {
  const environment: NodeJS.ProcessEnv = {
    Z_S_DATABASE_URL: 'postgresql://runtime.invalid/z-s',
    Z_S_UPLOAD_COMPLETION_SIGNING_KEY: 'u'.repeat(32),
    Z_S_OBJECT_READ_GRANT_SIGNING_KEY: 'r'.repeat(32),
    Z_S_PROVIDER_SECRET_BINDINGS_JSON: JSON.stringify({
      'r2-ref': {
        endpointEnv: 'TEST_R2_ENDPOINT',
        regionEnv: 'TEST_R2_REGION',
        accessKeyIdEnv: 'TEST_R2_ACCESS_KEY',
        secretAccessKeyEnv: 'TEST_R2_SECRET_KEY',
      },
      'minio-ref': {
        endpointEnv: 'TEST_MINIO_ENDPOINT',
        regionEnv: 'TEST_MINIO_REGION',
        forcePathStyle: true,
        accessKeyIdEnv: 'TEST_MINIO_ACCESS_KEY',
        secretAccessKeyEnv: 'TEST_MINIO_SECRET_KEY',
      },
    }),
    TEST_R2_ENDPOINT: 'https://r2.invalid',
    TEST_R2_REGION: 'auto',
    TEST_R2_ACCESS_KEY: 'r2-access',
    TEST_R2_SECRET_KEY: 'r2-secret',
    TEST_MINIO_ENDPOINT: 'http://minio.invalid',
    TEST_MINIO_REGION: 'us-east-1',
    TEST_MINIO_ACCESS_KEY: 'minio-access',
    TEST_MINIO_SECRET_KEY: 'minio-secret',
  };
  const composition = createRuntimeLocalComposition({
    environment,
    pool: authorityPool(),
    now: () => new Date('2026-07-17T12:00:00.000Z'),
  });
  try {
    const ready = await composition.runtime.readiness() as {
      readonly status: string;
      readonly controlPlane: { readonly status: string };
      readonly dataPlane: { readonly status: string };
    };
    assert.equal(ready.status, 'ready');
    assert.equal(ready.controlPlane.status, 'ready');
    assert.equal(ready.dataPlane.status, 'ready');
  } finally {
    await composition.close();
  }

  const missingAuthority = createRuntimeLocalComposition({
    environment,
    pool: authorityPool({ authorityPresent: false }),
    now: () => new Date('2026-07-17T12:00:00.000Z'),
  });
  try {
    const notReady = await missingAuthority.runtime.readiness() as {
      readonly status: string;
      readonly controlPlane: { readonly code?: string };
    };
    assert.equal(notReady.status, 'not-ready');
    assert.equal(notReady.controlPlane.code, 'video-maker-storage-authority-not-ready');
  } finally {
    await missingAuthority.close();
  }
});
