import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AesGcmProviderSecretStore,
  InMemoryProviderSecretEnvelopeRepository,
  ProviderSecretStoreError,
} from '../src/provider-secret-store.js';

const context = Object.freeze({
  clientId: 'client-a',
  environment: 'dev' as const,
  serviceId: 'r2-main',
  providerType: 'cloudflare-r2',
});

const fakeSecretValue = ['test', 'secret', 'value'].join('-');

test('provider secrets use random authenticated envelopes and never persist plaintext', async () => {
  const repository = new InMemoryProviderSecretEnvelopeRepository();
  const store = new AesGcmProviderSecretStore({
    repository,
    keys: new Map([[1, Uint8Array.from({ length: 32 }, (_, index) => index + 1)]]),
    activeKeyVersion: 1,
  });
  const secret = Object.freeze({
    accountId: '0123456789abcdef0123456789abcdef',
    accessKeyId: 'test-access-key',
    secretAccessKey: fakeSecretValue,
    bucket: 'test-bucket',
  });
  const first = await store.store(context, secret, new Date('2026-08-05T00:00:00Z'));
  const second = await store.store(context, secret, new Date('2026-08-05T00:00:01Z'));
  assert.notEqual(first, second);
  assert.deepEqual(await store.resolve(context, first), secret);

  await assert.rejects(
    store.resolve({ ...context, clientId: 'client-b' }, first),
    (error: unknown) => error instanceof ProviderSecretStoreError &&
      error.code === 'provider-secret-not-found',
  );
  await assert.rejects(
    store.resolve({ ...context, environment: 'prod' }, first),
    (error: unknown) => error instanceof ProviderSecretStoreError &&
      error.code === 'provider-secret-not-found',
  );
});

test('secret replacement revokes the previous envelope without revealing it', async () => {
  const repository = new InMemoryProviderSecretEnvelopeRepository();
  const store = new AesGcmProviderSecretStore({
    repository,
    keys: new Map([[7, Uint8Array.from({ length: 32 }, () => 9)]]),
    activeKeyVersion: 7,
  });
  const first = await store.store(context, { secretAccessKey: ['first'].join('') });
  const second = await store.replace(context, first, { secretAccessKey: ['second'].join('') });
  assert.equal((await store.resolve(context, second)).secretAccessKey, 'second');
  await assert.rejects(
    store.resolve(context, first),
    (error: unknown) => error instanceof ProviderSecretStoreError &&
      error.code === 'provider-secret-revoked',
  );
});
