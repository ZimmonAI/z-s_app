import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type {
  HttpStorageRuntime,
  StorageHealth,
  StorageReadiness,
} from '../src/runtime-contract.js';
import {
  PostgresVideoMakerAuthorityRegistry,
  RuntimeCompositionError,
  composeStorageRuntimes,
  createEnvironmentCredentialResolver,
  createVideoMakerRuntimeComposition,
  type ReadyProviderCredentialResolver,
} from '../src/runtime-local-composition.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
} from '../src/runtime-storage-registry.js';

const IDS = Object.freeze({
  managedApp: '00000000-0000-4000-8000-000000000001',
  profile: '00000000-0000-4000-8000-000000000002',
  prefix: '00000000-0000-4000-8000-000000000003',
  hotBinding: '00000000-0000-4000-8000-000000000004',
  canonicalBinding: '00000000-0000-4000-8000-000000000005',
  hotProvider: '00000000-0000-4000-8000-000000000006',
  canonicalProvider: '00000000-0000-4000-8000-000000000007',
});

const AUTHORITY_ROW = Object.freeze({
  managed_app_id: IDS.managedApp,
  managed_app_status: 'active',
  profile_uuid: IDS.profile,
  profile_status: 'active',
  effective_at: '2026-07-01T00:00:00.000Z',
  retired_at: null,
  prefix_uuid: IDS.prefix,
  prefix_status: 'active',
  normalized_prefix_pattern: 'video-maker/user-resources/*',
  hot_binding_id: IDS.hotBinding,
  hot_binding_required: true,
  hot_provider_uuid: IDS.hotProvider,
  hot_provider_id: 'r2_video_maker_dev_01',
  hot_provider_status: 'active',
  hot_bucket_label: 'video-maker-hot',
  hot_secret_reference_id: 'secret-ref-hot',
  canonical_binding_id: IDS.canonicalBinding,
  canonical_binding_required: true,
  canonical_provider_uuid: IDS.canonicalProvider,
  canonical_provider_id: 'minio_zimspace_local_pc_01',
  canonical_provider_status: 'active',
  canonical_bucket_label: 'video-maker-canonical',
  canonical_secret_reference_id: 'secret-ref-canonical',
});

const CAPABILITIES = Object.freeze(
  [IDS.hotProvider, IDS.canonicalProvider].flatMap((providerId, providerIndex) =>
    ['put', 'head', 'get', 'delete', 'checksum', 'size', 'range'].map((capability) =>
      Object.freeze({
        storage_provider_id: providerId,
        bucket_label: providerIndex === 0 ? 'video-maker-hot' : 'video-maker-canonical',
        capability,
        result: 'passed',
        expires_at: null,
      }),
    ),
  ),
);

function fakePool(options: {
  readonly authorityRows?: readonly Record<string, unknown>[];
  readonly capabilityRows?: readonly Record<string, unknown>[];
} = {}): PostgresPoolLike {
  return Object.freeze({
    connect: async (): Promise<PostgresClientLike> =>
      Object.freeze({
        query: async <Row extends Record<string, unknown>>(text: string) => {
          if (text.includes('FROM public.managed_apps AS managed_app')) {
            return Object.freeze({
              rows: [...(options.authorityRows ?? [AUTHORITY_ROW])] as Row[],
              rowCount: (options.authorityRows ?? [AUTHORITY_ROW]).length,
            });
          }
          if (text.includes('FROM public.storage_capability_results')) {
            return Object.freeze({
              rows: [...(options.capabilityRows ?? CAPABILITIES)] as Row[],
              rowCount: (options.capabilityRows ?? CAPABILITIES).length,
            });
          }
          throw new Error('unexpected-query');
        },
        release: () => undefined,
      }),
  });
}

function stubRuntime(name: string): HttpStorageRuntime {
  const health: StorageHealth = Object.freeze({
    serviceId: 'z-s',
    packageVersion: '0.5.0',
    contractVersion: '1.0',
    process: 'healthy',
    checkedAt: '2026-07-17T00:00:00.000Z',
  });
  const readiness: StorageReadiness = Object.freeze({
    serviceId: 'z-s',
    process: 'healthy',
    controlPlane: Object.freeze({ status: 'ready' }),
    dataPlane: Object.freeze({ status: 'ready' }),
    status: 'ready',
    checkedAt: '2026-07-17T00:00:00.000Z',
  });
  return Object.freeze({
    handle: async () => new Response(name),
    health: async () => health,
    readiness: async () => readiness,
  });
}

function readyEnvironment(): Record<string, string> {
  return {
    Z_S_VIDEO_MAKER_BEARER_TOKEN: 'video-maker-runtime-token',
    Z_S_Z_X_BEARER_TOKEN: 'z-x-runtime-bearer-token',
    Z_S_UPLOAD_COMPLETION_SIGNING_KEY: 'upload-completion-signing-key',
    Z_S_READ_GRANT_SIGNING_KEY: 'read-grant-signing-key',
    Z_S_PROVIDER_SECRET_BINDINGS_JSON: JSON.stringify({
      'secret-ref-hot': {
        endpointEnv: 'HOT_ENDPOINT',
        regionEnv: 'HOT_REGION',
        forcePathStyleEnv: 'HOT_FORCE_PATH_STYLE',
        accessKeyIdEnv: 'HOT_ACCESS_KEY_ID',
        secretAccessKeyEnv: 'HOT_SECRET_ACCESS_KEY',
      },
      'secret-ref-canonical': {
        endpointEnv: 'CANONICAL_ENDPOINT',
        regionEnv: 'CANONICAL_REGION',
        forcePathStyleEnv: 'CANONICAL_FORCE_PATH_STYLE',
        accessKeyIdEnv: 'CANONICAL_ACCESS_KEY_ID',
        secretAccessKeyEnv: 'CANONICAL_SECRET_ACCESS_KEY',
      },
    }),
    HOT_ENDPOINT: 'https://hot.example.invalid',
    HOT_REGION: 'auto',
    HOT_FORCE_PATH_STYLE: 'false',
    HOT_ACCESS_KEY_ID: 'hot-access-key',
    HOT_SECRET_ACCESS_KEY: 'hot-secret-key',
    CANONICAL_ENDPOINT: 'https://canonical.example.invalid',
    CANONICAL_REGION: 'us-east-1',
    CANONICAL_FORCE_PATH_STYLE: 'true',
    CANONICAL_ACCESS_KEY_ID: 'canonical-access-key',
    CANONICAL_SECRET_ACCESS_KEY: 'canonical-secret-key',
  };
}

test('one listener dispatches write and read namespaces to their mature runtimes', async () => {
  const runtime = composeStorageRuntimes(stubRuntime('write'), stubRuntime('read'));
  assert.equal(await (await runtime.handle(new Request('http://local/v1/object-write-intents', { method: 'POST' }))).text(), 'write');
  assert.equal(await (await runtime.handle(new Request('http://local/v1/object-read-grants', { method: 'POST' }))).text(), 'read');
  assert.equal(await (await runtime.handle(new Request('http://local/v1/storage-objects/00000000-0000-4000-8000-000000000099/content'))).text(), 'read');
  assert.equal((await runtime.readiness()).status, 'ready');
});

test('environment credential resolution uses indirection and fails closed', async () => {
  const environment = readyEnvironment();
  const resolver: ReadyProviderCredentialResolver = createEnvironmentCredentialResolver(environment);
  assert.equal(resolver.isReady('secret-ref-hot'), true);
  assert.equal(resolver.isReady('unknown'), false);
  const resolved = await resolver.resolve('secret-ref-hot');
  assert.equal(resolved.region, 'auto');
  assert.equal(resolved.forcePathStyle, false);
  await assert.rejects(
    Promise.resolve(resolver.resolve('unknown')),
    (error: unknown) => error instanceof RuntimeCompositionError && error.code === 'provider-credential-binding-unavailable',
  );
});

test('authority resolution binds the exact active Video Maker development profile', async () => {
  const registry = new PostgresVideoMakerAuthorityRegistry({
    pool: fakePool(),
    now: () => new Date('2026-07-17T00:00:00.000Z'),
  });
  const caller = Object.freeze({ appId: 'video-maker_app' as const, serviceId: 'api' });
  const request = Object.freeze({ profileId: 'video-maker-dev-default', profileVersion: 1, environment: 'dev' as const });
  const profile = await registry.resolveStorageProfile(request, caller);
  const authority = await registry.resolveObjectWriteAuthority(request, caller);
  const target = await registry.resolve({
    providerRole: 'hot',
    providerBindingId: IDS.hotBinding,
    internalLocator: 'video-maker/user-resources/object/hot',
  });
  assert.equal(profile.ready, true);
  assert.equal(profile.capabilityPolicy.rangeRead, 'required');
  assert.deepEqual(profile.writePolicy?.allowedMediaTypes, ['image/png', 'video/mp4']);
  assert.equal(authority.storageProfileId, IDS.profile);
  assert.equal(authority.storagePrefixClassId, IDS.prefix);
  assert.equal(target.providerId, 'r2_video_maker_dev_01');
  assert.equal(target.internalLocator, 'video-maker/user-resources/object/hot');
  await assert.rejects(
    registry.resolveStorageProfile({ ...request, environment: 'stg' }, caller),
    (error: unknown) => error instanceof RuntimeCompositionError && error.code === 'storage-authority-request-mismatch',
  );
});

test('authority resolution refuses missing exact bindings and capability evidence', async () => {
  const missingAuthority = new PostgresVideoMakerAuthorityRegistry({ pool: fakePool({ authorityRows: [] }) });
  await assert.rejects(
    missingAuthority.load(),
    (error: unknown) => error instanceof RuntimeCompositionError && error.code === 'storage-authority-unavailable',
  );
  const missingRange = new PostgresVideoMakerAuthorityRegistry({
    pool: fakePool({ capabilityRows: CAPABILITIES.filter((row) => row.capability !== 'range') }),
  });
  await assert.rejects(
    missingRange.load(),
    (error: unknown) => error instanceof RuntimeCompositionError && error.code === 'provider-range-capability-not-ready',
  );
});

test('composed readiness requires authority, identities, signing keys, and credentials', async () => {
  const ready = createVideoMakerRuntimeComposition({
    pool: fakePool(),
    environment: readyEnvironment(),
    now: () => new Date('2026-07-17T00:00:00.000Z'),
  });
  try {
    const status = await ready.runtime.readiness();
    assert.equal(status.status, 'ready');
    assert.equal(status.controlPlane.status, 'ready');
    assert.equal(status.dataPlane.status, 'ready');
  } finally {
    await ready.close();
  }
  const environment = readyEnvironment();
  delete environment.Z_S_READ_GRANT_SIGNING_KEY;
  const notReady = createVideoMakerRuntimeComposition({
    pool: fakePool(),
    environment,
    now: () => new Date('2026-07-17T00:00:00.000Z'),
  });
  try {
    const status = await notReady.runtime.readiness();
    assert.equal(status.status, 'not-ready');
    assert.equal(status.dataPlane.code, 'runtime-identity-or-signing-configuration-unavailable');
  } finally {
    await notReady.close();
  }
});

test('runtime entry point contains no placeholder authority or unconditional readiness', async () => {
  const source = await readFile('src/runtime-main.ts', 'utf8');
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { readonly scripts?: Record<string, string> };
  assert.doesNotMatch(source, /local-runtime-placeholder/);
  assert.doesNotMatch(source, /write runtime is not configured/);
  assert.match(source, /createVideoMakerRuntimeComposition/);
  assert.equal(packageJson.scripts?.['verify:video-maker-runtime'], 'npm run build && node scripts/verify-video-maker-runtime.mjs');
});
