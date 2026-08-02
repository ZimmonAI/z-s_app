import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ClientCredentialAuthenticationResult,
  ClientCredentialAuthenticator,
} from '../src/client-control-auth.js';
import { InMemoryClientStorageConfigurationStore } from '../src/client-storage-configuration.js';
import { createControlPlaneUiRuntime } from '../src/control-plane-ui.js';
import type { HttpStorageRuntime } from '../src/runtime-contract.js';

const SIGNING_KEY = 'client-storage-session-signing-key-2026';
const ADMIN_PASSPHRASE = 'operator-passphrase';
const NOW = new Date('2026-08-02T00:00:00.000Z');

class FakeClientAuthenticator implements ClientCredentialAuthenticator {
  readonly configured = true;

  async authenticate(input: Readonly<{
    clientId: string;
    clientCredential: string;
    now: Date;
  }>): Promise<Readonly<ClientCredentialAuthenticationResult>> {
    if (input.clientCredential !== 'fixture-browser-credential') {
      return Object.freeze({ kind: 'invalid' });
    }
    if (input.clientId === 'video-maker_app') {
      return Object.freeze({
        kind: 'authenticated',
        clientId: input.clientId,
        displayLabel: 'Video Maker',
      });
    }
    if (input.clientId === 'other-client') {
      return Object.freeze({
        kind: 'authenticated',
        clientId: input.clientId,
        displayLabel: 'Other Client',
      });
    }
    return Object.freeze({ kind: 'invalid' });
  }
}

function documentPayload() {
  return {
    providerConnections: [
      {
        connectionId: 'minio-production',
        displayLabel: 'MinIO production',
        providerType: 'minio',
        secretReferenceId: 'vault:z-s/minio-production',
        safeMetadata: { regionLabel: 'local-primary' },
      },
      {
        connectionId: 'r2-video-maker',
        displayLabel: 'R2 Video Maker',
        providerType: 'r2',
        secretReferenceId: 'vault:z-s/r2-video-maker',
        safeMetadata: { regionLabel: 'global-hot' },
      },
    ],
    vaults: [
      {
        vaultId: 'originals-minio',
        providerConnectionId: 'minio-production',
        displayLabel: 'Originals',
        purpose: 'originals',
        bucketLabel: 'video-maker-originals',
        prefixTemplate: 'video-maker/originals/*',
        retention: { mode: 'permanent' },
      },
      {
        vaultId: 'hot-r2-seven-day',
        providerConnectionId: 'r2-video-maker',
        displayLabel: 'Hot copy',
        purpose: 'hot-copy',
        bucketLabel: 'video-maker-hot',
        prefixTemplate: 'video-maker/hot/*',
        retention: { mode: 'delete-after-days', deleteAfterDays: 7 },
      },
      {
        vaultId: 'image-derivatives-r2',
        providerConnectionId: 'r2-video-maker',
        displayLabel: 'Derivatives',
        purpose: 'derivatives',
        bucketLabel: 'video-maker-derivatives',
        prefixTemplate: 'video-maker/derivatives/*',
        retention: { mode: 'permanent' },
      },
    ],
    imagePresets: [
      {
        presetId: 'production-web-images',
        targetVaultId: 'image-derivatives-r2',
        widths: [512, 1024],
        outputFormat: 'webp',
        quality: 82,
        fit: 'inside',
      },
    ],
    routes: [
      {
        routeId: 'images',
        assetClass: 'image',
        targets: [
          { role: 'primary', vaultId: 'originals-minio' },
          { role: 'replica', vaultId: 'hot-r2-seven-day' },
        ],
        imagePresetId: 'production-web-images',
      },
      {
        routeId: 'videos',
        assetClass: 'video',
        targets: [{ role: 'primary', vaultId: 'originals-minio' }],
      },
      {
        routeId: 'documents',
        assetClass: 'document',
        targets: [{ role: 'primary', vaultId: 'originals-minio' }],
      },
    ],
  };
}

function requestCookie(setCookie: string): string {
  return setCookie.split(';')[0] ?? '';
}

async function clientCookie(runtime: HttpStorageRuntime, clientId = 'video-maker_app'): Promise<string> {
  const response = await runtime.handle(new Request('https://z-s.zimmon.ai/client/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, clientCredential: 'fixture-browser-credential' }),
  }));
  assert.equal(response.status, 204);
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie !== null);
  return requestCookie(cookie);
}

function runtime() {
  const configurationStore = new InMemoryClientStorageConfigurationStore();
  configurationStore.registerClient('video-maker_app');
  configurationStore.registerClient('other-client');
  const delegatedRequests: Request[] = [];
  const storageRuntime: HttpStorageRuntime = Object.freeze({
    async handle(request: Request): Promise<Response> {
      delegatedRequests.push(request);
      return new Response(JSON.stringify({ error: { code: 'runtime-unauthenticated' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    },
    async health() {
      return {
        serviceId: 'z-s' as const,
        packageVersion: '0.5.0' as const,
        contractVersion: '1.0' as const,
        process: 'healthy' as const,
        checkedAt: NOW.toISOString(),
      };
    },
    async readiness() {
      return {
        serviceId: 'z-s' as const,
        process: 'healthy' as const,
        controlPlane: { status: 'ready' as const },
        dataPlane: { status: 'ready' as const },
        status: 'ready' as const,
        checkedAt: NOW.toISOString(),
      };
    },
  });
  return {
    delegatedRequests,
    runtime: createControlPlaneUiRuntime(storageRuntime, {
      adminPassword: ADMIN_PASSPHRASE,
      sessionSigningKey: SIGNING_KEY,
      clientCredentialAuthenticator: new FakeClientAuthenticator(),
      clientStorageConfigurationStore: configurationStore,
      now: () => NOW,
    }),
  };
}

test('authenticated client can create, inspect, activate, and clone configuration versions', async () => {
  const system = runtime();
  const cookie = await clientCookie(system.runtime);

  const initialPage = await system.runtime.handle(new Request(
    'https://z-s.zimmon.ai/client/storage?environment=dev',
    { headers: { cookie } },
  ));
  assert.equal(initialPage.status, 200);
  assert.match(await initialPage.text(), /No active configuration/);

  const created = await system.runtime.handle(new Request(
    'https://z-s.zimmon.ai/client/storage/configurations',
    {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ environment: 'dev', ...documentPayload() }),
    },
  ));
  assert.equal(created.status, 201);
  const createdBody = await created.json() as { result: { id: string; validationState: string } };
  assert.equal(createdBody.result.validationState, 'valid');

  const activate = await system.runtime.handle(new Request(
    `https://z-s.zimmon.ai/client/storage/configurations/${createdBody.result.id}/activate?environment=dev`,
    { method: 'POST', headers: { cookie } },
  ));
  assert.equal(activate.status, 200);
  const activated = await activate.json() as { result: { state: string } };
  assert.equal(activated.result.state, 'active');

  const immutable = await system.runtime.handle(new Request(
    `https://z-s.zimmon.ai/client/storage/configurations/${createdBody.result.id}?environment=dev`,
    {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(documentPayload()),
    },
  ));
  assert.equal(immutable.status, 409);
  assert.deepEqual(await immutable.json(), {
    error: { code: 'configuration-version-immutable' },
  });

  const clone = await system.runtime.handle(new Request(
    `https://z-s.zimmon.ai/client/storage/configurations/${createdBody.result.id}/clone?environment=dev`,
    { method: 'POST', headers: { cookie } },
  ));
  assert.equal(clone.status, 201);
  const cloned = await clone.json() as {
    result: { state: string; clonedFromVersionId: string; id: string };
  };
  assert.equal(cloned.result.state, 'draft');
  assert.equal(cloned.result.clonedFromVersionId, createdBody.result.id);
  assert.notEqual(cloned.result.id, createdBody.result.id);

  const workspace = await system.runtime.handle(new Request(
    'https://z-s.zimmon.ai/client/storage/configuration?environment=dev',
    { headers: { cookie } },
  ));
  assert.equal(workspace.status, 200);
  const workspaceBody = await workspace.text();
  assert.match(workspaceBody, /Configuration workspace/);
  assert.match(workspaceBody, /Active version/);
});

test('integration token routes reveal raw values only on create and rotate', async () => {
  const system = runtime();
  const cookie = await clientCookie(system.runtime);
  const create = await system.runtime.handle(new Request(
    'https://z-s.zimmon.ai/client/storage/integration-tokens',
    {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        environment: 'dev',
        tokenId: 'runtime-writer',
        displayLabel: 'Runtime writer',
        scopes: ['object:write'],
      }),
    },
  ));
  assert.equal(create.status, 201);
  const created = await create.json() as {
    result: { token: string; metadata: { tokenId: string } };
  };
  assert.match(created.result.token, /^zs_it_/);

  const list = await system.runtime.handle(new Request(
    'https://z-s.zimmon.ai/client/storage/integration-tokens?environment=dev',
    { headers: { cookie } },
  ));
  assert.equal(list.status, 200);
  const listingText = await list.text();
  assert.doesNotMatch(listingText, new RegExp(created.result.token));
  assert.doesNotMatch(listingText, /tokenDigest|token_digest/);

  const rotate = await system.runtime.handle(new Request(
    'https://z-s.zimmon.ai/client/storage/integration-tokens/runtime-writer/rotate?environment=dev',
    { method: 'POST', headers: { cookie } },
  ));
  assert.equal(rotate.status, 201);
  const rotated = await rotate.json() as { result: { token: string } };
  assert.notEqual(rotated.result.token, created.result.token);
});

test('client storage APIs require a browser session and reject operator or integration bearer authority', async () => {
  const system = runtime();
  const noSession = await system.runtime.handle(new Request(
    'https://z-s.zimmon.ai/client/storage/configurations?environment=dev',
  ));
  assert.equal(noSession.status, 401);
  assert.deepEqual(await noSession.json(), { error: { code: 'client-login-required' } });

  const operatorSession = await system.runtime.handle(new Request(
    'https://z-s.zimmon.ai/admin/session',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSPHRASE }),
    },
  ));
  const operatorCookie = operatorSession.headers.get('set-cookie');
  assert.ok(operatorCookie !== null);
  const operatorDenied = await system.runtime.handle(new Request(
    'https://z-s.zimmon.ai/client/storage/configurations?environment=dev',
    { headers: { cookie: requestCookie(operatorCookie) } },
  ));
  assert.equal(operatorDenied.status, 401);

  const bearerDenied = await system.runtime.handle(new Request(
    'https://z-s.zimmon.ai/client/storage/configurations?environment=dev',
    { headers: { authorization: 'Bearer fixture-integration-value' } },
  ));
  assert.equal(bearerDenied.status, 401);
});

test('browser client session does not authorize runtime object APIs', async () => {
  const system = runtime();
  const cookie = await clientCookie(system.runtime);
  const response = await system.runtime.handle(new Request(
    'https://z-s.zimmon.ai/v1/object-write-intents',
    {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    },
  ));
  assert.equal(response.status, 401);
  assert.equal(system.delegatedRequests.length, 1);
  assert.equal(system.delegatedRequests[0]?.headers.get('authorization'), null);
});

test('one client cannot read another client configuration version', async () => {
  const system = runtime();
  const firstCookie = await clientCookie(system.runtime, 'video-maker_app');
  const secondCookie = await clientCookie(system.runtime, 'other-client');
  const created = await system.runtime.handle(new Request(
    'https://z-s.zimmon.ai/client/storage/configurations',
    {
      method: 'POST',
      headers: { cookie: firstCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ environment: 'dev', ...documentPayload() }),
    },
  ));
  const body = await created.json() as { result: { id: string } };
  const denied = await system.runtime.handle(new Request(
    `https://z-s.zimmon.ai/client/storage/configurations/${body.result.id}?environment=dev`,
    { headers: { cookie: secondCookie } },
  ));
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), {
    error: { code: 'configuration-version-not-found' },
  });
});
