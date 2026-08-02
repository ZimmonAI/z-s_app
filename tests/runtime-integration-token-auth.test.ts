import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InMemoryClientStorageConfigurationStore,
  type ClientStorageConfigurationStore,
} from '../src/client-storage-configuration.js';
import {
  ConfigurationStoreRuntimeIntegrationTokenAuthenticator,
  RuntimeIntegrationTokenAuthenticationError,
  requireRuntimeIntegrationScope,
} from '../src/runtime-integration-token-auth.js';

const NOW = new Date('2026-08-02T00:00:00.000Z');

function authError(code: string) {
  return (error: unknown) =>
    error instanceof RuntimeIntegrationTokenAuthenticationError && error.code === code;
}

test('valid integration token returns only safe runtime principal fields', async () => {
  const store = new InMemoryClientStorageConfigurationStore();
  store.registerClient('client-a');
  const issued = await store.createIntegrationToken('client-a', {
    environment: 'staging',
    tokenId: 'runtime-write',
    displayLabel: 'Runtime write',
    scopes: ['object:write', 'object:read'],
  }, NOW);
  const principal = await new ConfigurationStoreRuntimeIntegrationTokenAuthenticator(store)
    .authenticate(issued.token, 'object:write', NOW);
  assert.deepEqual(principal, {
    clientId: 'client-a',
    environment: 'staging',
    tokenId: 'runtime-write',
    scopes: ['object:write', 'object:read'],
  });
  assert.equal(JSON.stringify(principal).includes(issued.token), false);
  assert.equal(JSON.stringify(principal).includes('digest'), false);
});

test('invalid, expired, revoked and wrong-scope tokens return bounded safe errors', async () => {
  const store = new InMemoryClientStorageConfigurationStore();
  store.registerClient('client-a');
  const active = await store.createIntegrationToken('client-a', {
    environment: 'dev', tokenId: 'runtime-read', displayLabel: 'Runtime read',
    scopes: ['object:read'],
  }, NOW);
  const expired = await store.createIntegrationToken('client-a', {
    environment: 'dev', tokenId: 'expired', displayLabel: 'Expired', scopes: ['object:write'],
    expiresAt: new Date('2026-08-02T00:00:01.000Z'),
  }, NOW);
  const revoked = await store.createIntegrationToken('client-a', {
    environment: 'dev', tokenId: 'revoked', displayLabel: 'Revoked', scopes: ['object:write'],
  }, NOW);
  await store.revokeIntegrationToken('client-a', 'dev', 'revoked', NOW);
  const authenticator = new ConfigurationStoreRuntimeIntegrationTokenAuthenticator(store);
  await assert.rejects(authenticator.authenticate('not-a-token', undefined, NOW), authError('integration-token-invalid'));
  await assert.rejects(
    authenticator.authenticate(expired.token, undefined, new Date('2026-08-02T00:00:02.000Z')),
    authError('integration-token-invalid'),
  );
  await assert.rejects(authenticator.authenticate(revoked.token, undefined, NOW), authError('integration-token-invalid'));
  await assert.rejects(authenticator.authenticate(active.token, 'object:write', NOW), authError('integration-token-scope-denied'));
  const readPrincipal = await authenticator.authenticate(active.token, undefined, NOW);
  assert.throws(() => requireRuntimeIntegrationScope(readPrincipal, 'object:manage'), authError('integration-token-scope-denied'));
});

test('disabled client outcome is distinct and does not expose token material', async () => {
  const store = {
    configured: true,
    authenticateIntegrationToken: async () => Object.freeze({ kind: 'client-disabled' as const }),
  } as unknown as ClientStorageConfigurationStore;
  const authenticator = new ConfigurationStoreRuntimeIntegrationTokenAuthenticator(store);
  await assert.rejects(
    authenticator.authenticate('private-token-value'),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeIntegrationTokenAuthenticationError);
      assert.equal(error.code, 'integration-token-client-disabled');
      assert.equal(error.status, 403);
      assert.equal(String(error).includes('private-token-value'), false);
      return true;
    },
  );
});
