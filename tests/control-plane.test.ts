import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ControlPlaneError,
  InMemoryStorageProfileRegistry,
  StorageControlPlaneService,
} from '../src/index.js';
import { cloneDataSet, createReadyDataSet, TEST_CLOCK } from './fixtures.js';

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ControlPlaneError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

function serviceFrom(data = createReadyDataSet()): StorageControlPlaneService {
  return new StorageControlPlaneService(new InMemoryStorageProfileRegistry(data, TEST_CLOCK));
}

test('default profile resolves the approved providers, buckets, prefix, and policy', async () => {
  const result = await serviceFrom().resolveStorageProfileAssignment({
    appId: 'video-maker_app',
    environment: 'dev',
    profileId: 'video-maker-dev-default',
    operationClass: 'user-upload',
  });

  assert.deepEqual(result.hotProvider, {
    providerId: 'r2_video_maker_dev_01',
    bucketLabel: 'video-maker-hot',
  });
  assert.deepEqual(result.canonicalProvider, {
    providerId: 'minio_zimspace_local_pc_01',
    bucketLabel: 'zs-dev-app-video-maker-canon',
  });
  assert.equal(result.normalizedPrefixPattern, 'video-maker/user-resources/*');
  assert.equal(result.capabilityPolicy.headContentLength, 'optional-with-checksum');
});

test('private profile resolves canonical MinIO and no hot provider', async () => {
  const result = await serviceFrom().resolveStorageProfileAssignment({
    appId: 'video-maker_app',
    environment: 'dev',
    profileId: 'video-maker-dev-private',
    operationClass: 'private-document',
  });
  assert.equal(result.hotProvider, null);
  assert.deepEqual(result.canonicalProvider, {
    providerId: 'minio_zimspace_local_pc_01',
    bucketLabel: 'zs-dev-app-video-maker-private',
  });
});

test('profile resolution is scoped to app and environment', async () => {
  await expectCode(
    serviceFrom().resolveStorageProfileAssignment({
      appId: 'other_app',
      environment: 'dev',
      profileId: 'video-maker-dev-default',
      operationClass: 'user-upload',
    }),
    'profile-app-mismatch',
  );
  await expectCode(
    serviceFrom().resolveStorageProfileAssignment({
      appId: 'video-maker_app',
      environment: 'stg',
      profileId: 'video-maker-dev-default',
      operationClass: 'user-upload',
    }),
    'managed-app-not-found',
  );
});

test('unknown and disabled managed apps fail closed', async () => {
  await expectCode(
    serviceFrom().resolveStorageProfileAssignment({
      appId: 'missing_app',
      environment: 'dev',
      profileId: 'video-maker-dev-default',
      operationClass: 'user-upload',
    }),
    'managed-app-not-found',
  );
  await expectCode(
    serviceFrom().resolveStorageProfileAssignment({
      appId: 'disabled_app',
      environment: 'dev',
      profileId: 'video-maker-dev-default',
      operationClass: 'user-upload',
    }),
    'managed-app-disabled',
  );
});

test('unknown, draft, disabled, and ambiguous profiles fail closed', async () => {
  await expectCode(
    serviceFrom().resolveStorageProfileAssignment({
      appId: 'video-maker_app',
      environment: 'dev',
      profileId: 'missing-profile',
      operationClass: 'user-upload',
    }),
    'profile-not-found',
  );
  for (const profileId of ['video-maker-dev-draft', 'video-maker-dev-disabled']) {
    await expectCode(
      serviceFrom().resolveStorageProfileAssignment({
        appId: 'video-maker_app',
        environment: 'dev',
        profileId,
        operationClass: 'user-upload',
      }),
      'profile-not-active',
    );
  }

  const ambiguous = createReadyDataSet();
  ambiguous.profiles.push({
    profileId: 'video-maker-dev-default',
    appId: 'video-maker_app',
    environment: 'dev',
    version: 2,
    status: 'active',
  });
  await expectCode(
    serviceFrom(ambiguous).resolveStorageProfileAssignment({
      appId: 'video-maker_app',
      environment: 'dev',
      profileId: 'video-maker-dev-default',
      operationClass: 'user-upload',
    }),
    'profile-version-ambiguous',
  );
});

test('missing canonical binding fails', async () => {
  const data = createReadyDataSet();
  data.bindings = data.bindings.filter(
    (binding) =>
      !(
        binding.profileId === 'video-maker-dev-default' &&
        binding.providerRole === 'canonical'
      ),
  );
  await expectCode(
    serviceFrom(data).resolveStorageProfileAssignment({
      appId: 'video-maker_app',
      environment: 'dev',
      profileId: 'video-maker-dev-default',
      operationClass: 'user-upload',
    }),
    'provider-binding-missing',
  );
});

test('disabled provider fails before assignment return', async () => {
  const data = createReadyDataSet();
  const provider = data.providers.find(
    (record) => record.providerId === 'r2_video_maker_dev_01',
  );
  assert.ok(provider);
  provider.status = 'disabled';
  await expectCode(
    serviceFrom(data).resolveStorageProfileAssignment({
      appId: 'video-maker_app',
      environment: 'dev',
      profileId: 'video-maker-dev-default',
      operationClass: 'user-upload',
    }),
    'provider-disabled',
  );
});

test('cross-profile binding and prefix corruption fail closed', async () => {
  const bindingCorruption = createReadyDataSet();
  const hotBinding = bindingCorruption.bindings.find(
    (binding) => binding.providerRole === 'hot',
  );
  assert.ok(hotBinding);
  hotBinding.profileId = 'shared-name-profile';
  await expectCode(
    serviceFrom(bindingCorruption).resolveStorageProfileAssignment({
      appId: 'video-maker_app',
      environment: 'dev',
      profileId: 'video-maker-dev-default',
      operationClass: 'user-upload',
    }),
    'provider-binding-missing',
  );

  const prefixCorruption = createReadyDataSet();
  const prefix = prefixCorruption.prefixClasses.find(
    (record) => record.prefixClassId === 'video-maker-user-resource',
  );
  assert.ok(prefix);
  prefix.profileId = 'shared-name-profile';
  await expectCode(
    serviceFrom(prefixCorruption).resolveStorageProfileAssignment({
      appId: 'video-maker_app',
      environment: 'dev',
      profileId: 'video-maker-dev-default',
      operationClass: 'user-upload',
    }),
    'prefix-class-not-found',
  );
});

test('user-upload resolves only the approved prefix class', async () => {
  const result = await serviceFrom().resolveStorageProfileAssignment({
    appId: 'video-maker_app',
    environment: 'dev',
    profileId: 'video-maker-dev-default',
    operationClass: 'user-upload',
  });
  assert.equal(result.prefixClassId, 'video-maker-user-resource');
  assert.equal(result.normalizedPrefixPattern, 'video-maker/user-resources/*');
});

test('object key outside prefix fails before any credential boundary is reached', async () => {
  await expectCode(
    serviceFrom().resolveStorageProfileAssignment({
      appId: 'video-maker_app',
      environment: 'dev',
      profileId: 'video-maker-dev-default',
      operationClass: 'user-upload',
      objectKey: 'video-maker/other/file.bin',
    }),
    'object-key-outside-prefix',
  );
});

test('unverified, failed, and expired capabilities block resolution', async () => {
  const unverified = createReadyDataSet();
  unverified.capabilityResults = unverified.capabilityResults.filter(
    (result) =>
      !(
        result.providerId === 'r2_video_maker_dev_01' && result.capability === 'put'
      ),
  );
  await expectCode(
    serviceFrom(unverified).resolveStorageProfileAssignment({
      appId: 'video-maker_app',
      environment: 'dev',
      profileId: 'video-maker-dev-default',
      operationClass: 'user-upload',
    }),
    'capability-not-verified',
  );

  const failed = createReadyDataSet();
  const failedResult = failed.capabilityResults.find(
    (result) =>
      result.providerId === 'r2_video_maker_dev_01' && result.capability === 'checksum',
  );
  assert.ok(failedResult);
  failedResult.result = 'failed';
  await expectCode(
    serviceFrom(failed).resolveStorageProfileAssignment({
      appId: 'video-maker_app',
      environment: 'dev',
      profileId: 'video-maker-dev-default',
      operationClass: 'user-upload',
    }),
    'capability-failed',
  );

  const expired = createReadyDataSet();
  const expiredResult = expired.capabilityResults.find(
    (result) =>
      result.providerId === 'r2_video_maker_dev_01' && result.capability === 'get',
  );
  assert.ok(expiredResult);
  expiredResult.expiresAt = '2026-07-14T11:59:59.000Z';
  await expectCode(
    serviceFrom(expired).resolveStorageProfileAssignment({
      appId: 'video-maker_app',
      environment: 'dev',
      profileId: 'video-maker-dev-default',
      operationClass: 'user-upload',
    }),
    'capability-expired',
  );
});

test('capability-ready state returns the approved policy', async () => {
  const result = await serviceFrom().resolveStorageProfileAssignment({
    appId: 'video-maker_app',
    environment: 'dev',
    profileId: 'video-maker-dev-default',
    operationClass: 'user-upload',
  });
  assert.deepEqual(result.capabilityPolicy, {
    checksumVerification: 'required',
    sizeVerification: 'required-when-supported',
    headContentLength: 'optional-with-checksum',
    rangeRead: 'optional',
  });
});

test('configuration conflicts are rejected', async () => {
  await expectCode(
    serviceFrom().resolveStorageProfileAssignment({
      appId: 'video-maker_app',
      environment: 'dev',
      profileId: 'video-maker-dev-default',
      operationClass: 'user-upload',
      expectedConfiguration: {
        canonicalBucket: 'wrong-bucket',
      },
    }),
    'configuration-conflict',
  );
});

test('safe fingerprints are deterministic and responses contain no secret-bearing fields', async () => {
  const service = serviceFrom();
  const input = {
    appId: 'video-maker_app' as const,
    environment: 'dev' as const,
    profileId: 'video-maker-dev-default',
    operationClass: 'user-upload' as const,
  };
  const first = await service.resolveStorageProfileAssignment(input);
  const second = await service.resolveStorageProfileAssignment(input);
  assert.equal(first.safeFingerprint, second.safeFingerprint);
  assert.match(first.safeFingerprint, /^zs-profile-v1:[a-f0-9]{64}$/);

  const serialized = JSON.stringify(first).toLowerCase();
  for (const prohibited of [
    'secretreferenceid',
    'secretaccesskey',
    'accesskeyid',
    'endpoint',
    'connectionstring',
    'accountid',
    'signedurl',
    'objectkey',
    'privateproviderresponse',
  ]) {
    assert.equal(serialized.includes(prohibited), false, prohibited);
  }
});

test('registry reports active version and required capability matrix', async () => {
  const registry = new InMemoryStorageProfileRegistry(createReadyDataSet(), TEST_CLOCK);
  assert.equal(await registry.getActiveProfileVersion('video-maker-dev-default'), 1);
  const required = await registry.listRequiredCapabilities(
    'video-maker-dev-default',
    'user-upload',
  );
  assert.equal(required.length, 12);
  assert.ok(required.some((entry) => entry.capability === 'size'));
});

test('fixture mutation helper produces isolated copies', () => {
  const original = createReadyDataSet();
  const copy = cloneDataSet(original);
  copy.managedApps[0]!.status = 'disabled';
  assert.equal(original.managedApps[0]!.status, 'active');
});
