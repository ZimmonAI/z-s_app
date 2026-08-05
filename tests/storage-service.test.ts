import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudflareR2Adapter } from '../src/cloudflare-r2-adapter.js';
import {
  InMemoryClientStorageConfigurationStore,
} from '../src/client-storage-configuration.js';
import {
  AesGcmProviderSecretStore,
  InMemoryProviderSecretEnvelopeRepository,
} from '../src/provider-secret-store.js';
import { StorageProviderAdapterRegistry } from '../src/storage-provider-adapter.js';
import { StorageServiceApplicationService } from '../src/storage-service-application.js';
import { InMemoryStorageServiceRepository } from '../src/storage-service-memory.js';
import { StorageServiceError } from '../src/storage-service.js';

function fixture() {
  const configurations = new InMemoryClientStorageConfigurationStore();
  configurations.registerClient('client-a');
  const repository = new InMemoryStorageServiceRepository();
  const secrets = new AesGcmProviderSecretStore({
    repository: new InMemoryProviderSecretEnvelopeRepository(),
    keys: new Map([[1, Uint8Array.from({ length: 32 }, () => 4)]]),
    activeKeyVersion: 1,
  });
  const adapter = new CloudflareR2Adapter({
    nonce: () => 'fixed',
    createClient: () => ({
      async send(command: unknown): Promise<Record<string, unknown>> {
        return command !== null && typeof command === 'object' &&
          command.constructor.name === 'HeadObjectCommand'
          ? { ContentLength: 1 }
          : {};
      },
    }),
  });
  return {
    repository,
    configurations,
    service: new StorageServiceApplicationService({
      repository,
      secrets,
      adapters: new StorageProviderAdapterRegistry([adapter]),
      configurations,
    }),
  };
}

const createInput = Object.freeze({
  serviceId: 'r2-main',
  environment: 'dev' as const,
  displayName: 'R2 main',
  providerType: 'cloudflare-r2',
  safeMetadata: Object.freeze({ accountLabel: 'Test account' }),
  secretInput: Object.freeze({
    accountId: '0123456789abcdef0123456789abcdef',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-access-key',
    bucket: 'test-bucket',
  }),
  testScope: Object.freeze({ prefix: 'bounded' }),
});

test('client-owned service becomes ready and can seed a configuration draft', async () => {
  const { service, configurations } = fixture();
  const stored = await service.createClientOwned('client-a', createInput);
  assert.equal(stored.status, 'ready');
  assert.equal(JSON.stringify(stored).includes('test-secret-access-key'), false);
  const draft = await service.createConfigurationDraft('client-a', 'dev', 'r2-main');
  assert.equal(draft.providerConnections[0]?.connectionId, 'r2-main');
  assert.match(draft.providerConnections[0]?.secretReferenceId ?? '', /^zs-storage-service:/);
  const overview = await configurations.overview('client-a', 'dev');
  assert.equal(overview.draftVersions.length, 1);
});

test('active dependencies block disable and capability mismatch blocks activation', async () => {
  const { service, repository } = fixture();
  const stored = await service.createClientOwned('client-a', createInput);
  repository.setDependencies('client-a', 'dev', 'r2-main', {
    draftConfigurationCount: 0,
    activeConfigurationCount: 1,
    vaultCount: 1,
    routeCount: 1,
    objectCopyCount: 0,
    derivativeOutputCount: 0,
  });
  await assert.rejects(
    service.disableOrArchive('client-a', 'dev', 'r2-main', 'disabled'),
    (error: unknown) => error instanceof StorageServiceError &&
      error.code === 'storage-service-active-dependency',
  );
  assert.equal(stored.status, 'ready');
});
