import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudflareR2Adapter } from '../src/cloudflare-r2-adapter.js';
import {
  AesGcmProviderSecretStore,
  InMemoryProviderSecretEnvelopeRepository,
} from '../src/provider-secret-store.js';
import type { ResolvedS3CredentialBinding } from '../src/runtime-s3-provider.js';
import { StorageProviderAdapterRegistry } from '../src/storage-provider-adapter.js';
import {
  StorageServiceProviderCredentialResolver,
  storageServiceSecretReference,
} from '../src/storage-service-credential-resolver.js';
import { InMemoryStorageServiceRepository } from '../src/storage-service-memory.js';
import { storageServiceSecretContext } from '../src/storage-service.js';

const fakeSecretAccessKey = ['runtime', 'fake', 'secret'].join('-');

test('credential resolver isolates managed bindings from encrypted client-owned services', async () => {
  const repository = new InMemoryStorageServiceRepository();
  const secrets = new AesGcmProviderSecretStore({
    repository: new InMemoryProviderSecretEnvelopeRepository(),
    keys: new Map([[1, Uint8Array.from({ length: 32 }, (_, index) => index + 11)]]),
    activeKeyVersion: 1,
  });
  const adapter = new CloudflareR2Adapter();
  const adapters = new StorageProviderAdapterRegistry([adapter]);
  const capabilities = adapter.getProviderManifest().capabilities;
  const created = await repository.create({
    id: '00000000-0000-4000-8000-000000000071',
    serviceId: 'r2-main',
    clientId: 'client-a',
    environment: 'dev',
    displayName: 'R2 main',
    providerType: 'cloudflare-r2',
    ownership: 'client-owned',
    safeMetadata: { accountLabel: 'Test account' },
    capabilities,
  }, new Date('2026-08-05T00:00:00Z'));
  const secretId = await secrets.store(storageServiceSecretContext(created), {
    accountId: '0123456789abcdef0123456789abcdef',
    accessKeyId: 'test-access-key',
    secretAccessKey: fakeSecretAccessKey,
    bucket: 'test-bucket',
  });
  await repository.bindSecret('client-a', 'dev', 'r2-main', secretId, new Date('2026-08-05T00:00:01Z'));
  const ready = await repository.recordTest('client-a', 'dev', 'r2-main', {
    connected: true,
    capabilities,
    diagnosticCode: null,
    testedAt: '2026-08-05T00:00:02.000Z',
  }, new Date('2026-08-05T00:00:02Z'));

  const managedBinding: Readonly<ResolvedS3CredentialBinding> = Object.freeze({
    endpoint: 'https://managed.invalid',
    region: 'auto',
    forcePathStyle: false,
    accessKeyId: 'managed-access',
    secretAccessKey: ['managed', 'fake', 'secret'].join('-'),
  });
  const resolver = new StorageServiceProviderCredentialResolver({
    services: repository,
    secrets,
    adapters,
    managedResolver: {
      resolve(referenceId: string): Readonly<ResolvedS3CredentialBinding> {
        assert.equal(referenceId, 'managed-reference');
        return managedBinding;
      },
    },
  });

  assert.deepEqual(await resolver.resolve('managed-reference'), managedBinding);
  const clientOwned = await resolver.resolve(storageServiceSecretReference(ready.id));
  assert.equal(clientOwned.endpoint, 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com');
  assert.equal(clientOwned.accessKeyId, 'test-access-key');
  assert.equal(clientOwned.secretAccessKey, fakeSecretAccessKey);
});
