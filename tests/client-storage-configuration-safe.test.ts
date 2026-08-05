import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InMemoryClientStorageConfigurationStore,
} from '../src/client-storage-configuration.js';
import {
  SafeClientStorageConfigurationStore,
} from '../src/client-storage-configuration-safe.js';

const document = Object.freeze({
  environment: 'dev' as const,
  providerConnections: Object.freeze([{
    connectionId: 'r2-main',
    displayLabel: 'R2 main',
    providerType: 'r2' as const,
    secretReferenceId: 'zs-storage-service:00000000-0000-0000-0000-000000000001',
  }]),
  vaults: Object.freeze([]),
  routes: Object.freeze([]),
  imagePresets: Object.freeze([]),
});

test('public configuration facade strips secret references and preserves authority on save', async () => {
  const base = new InMemoryClientStorageConfigurationStore();
  base.registerClient('client-a');
  const draft = await base.createDraft('client-a', document);
  const safe = new SafeClientStorageConfigurationStore(base);
  const publicDraft = await safe.readVersion('client-a', 'dev', draft.id);
  assert.equal(publicDraft.providerConnections[0]?.secretReferenceId, '');
  await safe.replaceDraft('client-a', 'dev', draft.id, {
    providerConnections: publicDraft.providerConnections,
    vaults: publicDraft.vaults,
    routes: publicDraft.routes,
    imagePresets: publicDraft.imagePresets,
  });
  const internal = await base.readVersion('client-a', 'dev', draft.id);
  assert.equal(internal.providerConnections[0]?.secretReferenceId, document.providerConnections[0]?.secretReferenceId);
});
