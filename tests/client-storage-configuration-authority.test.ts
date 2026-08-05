import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ClientCredentialAuthenticationResult,
  ClientCredentialAuthenticator,
} from '../src/client-control-auth.js';
import {
  ClientStorageConfigurationError,
  InMemoryClientStorageConfigurationStore,
  type ConfigurationDraftDocument,
  type CreateConfigurationDraftInput,
  type ProviderConnectionInput,
} from '../src/client-storage-configuration.js';
import { SafeClientStorageConfigurationStore } from '../src/client-storage-configuration-safe.js';
import {
  configurationDocumentFromPayload,
  createConfigurationDraftFromPayload,
} from '../src/client-storage-control-request.js';
import { createControlPlaneUiRuntime } from '../src/control-plane-ui.js';
import { ControlPlaneUiError } from '../src/control-plane-ui-request.js';
import type { HttpStorageRuntime } from '../src/runtime-contract.js';

const NOW = new Date('2026-08-05T16:00:00.000Z');
const SIGNING_KEY = 'authority-preservation-session-signing-key';
const FIRST_AUTHORITY = 'fixture-authority:minio-primary:one';
const SECOND_AUTHORITY = 'fixture-authority:r2-hot:two';

function configurationDocument(): CreateConfigurationDraftInput {
  return {
    environment: 'dev',
    providerConnections: [
      {
        connectionId: 'minio-primary',
        displayLabel: 'MinIO primary',
        providerType: 'minio',
        secretReferenceId: FIRST_AUTHORITY,
        safeMetadata: { regionLabel: 'local-primary', authorityClass: 'managed' },
      },
      {
        connectionId: 'r2-hot',
        displayLabel: 'R2 hot',
        providerType: 'r2',
        secretReferenceId: SECOND_AUTHORITY,
        safeMetadata: { regionLabel: 'global-hot', authorityClass: 'managed' },
      },
    ],
    vaults: [
      {
        vaultId: 'originals',
        providerConnectionId: 'minio-primary',
        displayLabel: 'Originals',
        purpose: 'originals',
        bucketLabel: 'authority-originals',
        prefixTemplate: 'authority/originals/*',
        retention: { mode: 'permanent' },
      },
      {
        vaultId: 'hot-copy',
        providerConnectionId: 'r2-hot',
        displayLabel: 'Hot copy',
        purpose: 'hot-copy',
        bucketLabel: 'authority-hot',
        prefixTemplate: 'authority/hot/*',
        retention: { mode: 'delete-after-days', deleteAfterDays: 7 },
      },
      {
        vaultId: 'derivatives',
        providerConnectionId: 'r2-hot',
        displayLabel: 'Derivatives',
        purpose: 'derivatives',
        bucketLabel: 'authority-derivatives',
        prefixTemplate: 'authority/derivatives/*',
        retention: { mode: 'permanent' },
      },
    ],
    routes: [
      {
        routeId: 'images',
        assetClass: 'image',
        targets: [
          { role: 'primary', vaultId: 'originals' },
          { role: 'replica', vaultId: 'hot-copy' },
        ],
        imagePresetId: 'production-web-images',
      },
      {
        routeId: 'videos',
        assetClass: 'video',
        targets: [{ role: 'primary', vaultId: 'originals' }],
      },
      {
        routeId: 'documents',
        assetClass: 'document',
        targets: [{ role: 'primary', vaultId: 'originals' }],
      },
    ],
    imagePresets: [
      {
        presetId: 'production-web-images',
        targetVaultId: 'derivatives',
        widths: [512, 1024, 1600],
        outputFormat: 'webp',
        quality: 82,
        fit: 'inside',
      },
    ],
  };
}

function browserPayload(document: Readonly<ConfigurationDraftDocument>): Readonly<Record<string, unknown>> {
  return {
    providerConnections: document.providerConnections.map((connection) => ({
      connectionId: connection.connectionId,
      displayLabel: connection.displayLabel,
      providerType: connection.providerType,
    })),
    vaults: structuredClone(document.vaults),
    routes: structuredClone(document.routes),
    imagePresets: structuredClone(document.imagePresets),
  };
}

function safeDocument(
  document: Readonly<ConfigurationDraftDocument>,
): ConfigurationDraftDocument {
  return {
    providerConnections: document.providerConnections.map((connection) => ({
      connectionId: connection.connectionId,
      displayLabel: connection.displayLabel,
      providerType: connection.providerType,
      secretReferenceId: '',
    })),
    vaults: structuredClone(document.vaults),
    routes: structuredClone(document.routes),
    imagePresets: structuredClone(document.imagePresets),
  };
}

function controlError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ControlPlaneUiError && error.code === code;
}

function configurationError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ClientStorageConfigurationError && error.code === code;
}

test('draft replacement parser accepts safe provider references while trusted creation remains strict', () => {
  const full = configurationDocument();
  const payload = browserPayload(full);
  const parsed = configurationDocumentFromPayload(payload);
  assert.deepEqual(
    parsed.providerConnections.map((connection) => connection.secretReferenceId),
    ['', ''],
  );
  assert.doesNotThrow(() => createConfigurationDraftFromPayload(full));
  assert.throws(
    () => createConfigurationDraftFromPayload({ environment: 'dev', ...payload }),
    controlError('invalid-secret-reference-id'),
  );
  assert.throws(
    () => configurationDocumentFromPayload({
      ...payload,
      providerConnections: [{
        connectionId: 'minio-primary',
        displayLabel: 'MinIO primary',
        providerType: 'minio',
        secretReferenceId: 'caller-provided-authority',
      }],
    }),
    controlError('provider-connection-authority-mismatch'),
  );
  assert.throws(
    () => configurationDocumentFromPayload({
      ...payload,
      providerConnections: [{
        connectionId: 'Malformed Connection Id',
        displayLabel: 'Malformed',
        providerType: 'minio',
      }],
    }),
    controlError('invalid-provider-connection-id'),
  );
  assert.throws(
    () => configurationDocumentFromPayload({
      ...payload,
      providerConnections: [{
        connectionId: 'minio-primary',
        displayLabel: 'MinIO primary',
        providerType: 'unknown-provider',
      }],
    }),
    controlError('invalid-provider-type'),
  );
});

test('safe store rehydrates exact provider authority before validation and redacts the result', async () => {
  const base = new InMemoryClientStorageConfigurationStore();
  base.registerClient('client-a');
  const full = configurationDocument();
  const draft = await base.createDraft('client-a', full, NOW);
  const safe = new SafeClientStorageConfigurationStore(base);
  const safeInput = safeDocument(draft);
  const input: ConfigurationDraftDocument = {
    ...safeInput,
    imagePresets: safeInput.imagePresets.map((preset, index) =>
      index === 0 ? { ...preset, outputFormat: 'png' as const } : preset),
  };

  const result = await safe.replaceDraft(
    'client-a',
    'dev',
    draft.id,
    input,
    new Date('2026-08-05T16:01:00.000Z'),
  );
  assert.equal(result.validationState, 'valid');
  assert.equal(result.imagePresets[0]?.outputFormat, 'png');
  assert.deepEqual(
    result.providerConnections.map((connection) => connection.secretReferenceId),
    ['', ''],
  );
  assert.doesNotMatch(JSON.stringify(result), new RegExp(FIRST_AUTHORITY));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECOND_AUTHORITY));

  const stored = await base.readVersion('client-a', 'dev', draft.id);
  assert.deepEqual(
    stored.providerConnections.map((connection) => connection.secretReferenceId),
    [FIRST_AUTHORITY, SECOND_AUTHORITY],
  );
  assert.deepEqual(
    stored.providerConnections.map((connection) => connection.safeMetadata),
    full.providerConnections.map((connection) => connection.safeMetadata),
  );
});

test('safe store rejects provider authority-set tampering without mutating the draft', async () => {
  const base = new InMemoryClientStorageConfigurationStore();
  base.registerClient('client-a');
  const draft = await base.createDraft('client-a', configurationDocument(), NOW);
  const safe = new SafeClientStorageConfigurationStore(base);
  const original = await base.readVersion('client-a', 'dev', draft.id);
  const valid = safeDocument(original);
  const first = valid.providerConnections[0]!;
  const second = valid.providerConnections[1]!;
  const mismatchCases: readonly (readonly ProviderConnectionInput[])[] = [
    [first],
    [first, first],
    [first, second, {
      connectionId: 'unknown-provider',
      displayLabel: 'Unknown provider',
      providerType: 'r2',
      secretReferenceId: '',
    }],
    [{ ...first, connectionId: 'unknown-provider' }, second],
    [{ ...first, providerType: 'r2' }, second],
    [{ ...first, displayLabel: 'Changed label' }, second],
    [{ ...first, secretReferenceId: 'caller-authority' }, second],
  ];

  for (const providerConnections of mismatchCases) {
    await assert.rejects(
      safe.replaceDraft('client-a', 'dev', draft.id, {
        ...valid,
        providerConnections,
      }),
      configurationError('provider-connection-authority-mismatch'),
    );
    assert.deepEqual(await base.readVersion('client-a', 'dev', draft.id), original);
  }

  await safe.replaceDraft('client-a', 'dev', draft.id, {
    ...valid,
    providerConnections: [
      { ...first, safeMetadata: { regionLabel: 'caller-change' } },
      second,
    ],
  });
  const stored = await base.readVersion('client-a', 'dev', draft.id);
  assert.deepEqual(
    stored.providerConnections.map((connection) => connection.safeMetadata),
    original.providerConnections.map((connection) => connection.safeMetadata),
  );
});

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
    if (input.clientId === 'client-a' || input.clientId === 'client-b') {
      return Object.freeze({
        kind: 'authenticated',
        clientId: input.clientId,
        displayLabel: input.clientId,
      });
    }
    return Object.freeze({ kind: 'invalid' });
  }
}

function requestCookie(setCookie: string): string {
  return setCookie.split(';')[0] ?? '';
}

async function clientCookie(runtime: HttpStorageRuntime, clientId: string): Promise<string> {
  const response = await runtime.handle(new Request('https://z-s.test/client/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, clientCredential: 'fixture-browser-credential' }),
  }));
  assert.equal(response.status, 204);
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie !== null);
  return requestCookie(setCookie);
}

function routeSystem(): Readonly<{
  base: InMemoryClientStorageConfigurationStore;
  runtime: HttpStorageRuntime;
}> {
  const base = new InMemoryClientStorageConfigurationStore();
  base.registerClient('client-a');
  base.registerClient('client-b');
  const delegated: HttpStorageRuntime = Object.freeze({
    async handle(): Promise<Response> {
      return new Response(null, { status: 404 });
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
  return Object.freeze({
    base,
    runtime: createControlPlaneUiRuntime(delegated, {
      sessionSigningKey: SIGNING_KEY,
      clientCredentialAuthenticator: new FakeClientAuthenticator(),
      clientStorageConfigurationStore: new SafeClientStorageConfigurationStore(base),
      now: () => NOW,
    }),
  });
}

test('client route clone, safe edit, validate flow preserves provider authority and active version', async () => {
  const system = routeSystem();
  const clientA = await clientCookie(system.runtime, 'client-a');
  const full = configurationDocument();
  const createResponse = await system.runtime.handle(new Request(
    'https://z-s.test/client/storage/configurations',
    {
      method: 'POST',
      headers: { cookie: clientA, 'content-type': 'application/json' },
      body: JSON.stringify(full),
    },
  ));
  assert.equal(createResponse.status, 201);
  const createText = await createResponse.text();
  assert.doesNotMatch(createText, new RegExp(FIRST_AUTHORITY));
  assert.doesNotMatch(createText, new RegExp(SECOND_AUTHORITY));
  const created = JSON.parse(createText) as { result: { id: string } };

  const activation = await system.runtime.handle(new Request(
    `https://z-s.test/client/storage/configurations/${created.result.id}/activate?environment=dev`,
    { method: 'POST', headers: { cookie: clientA } },
  ));
  assert.equal(activation.status, 200);

  const activeRead = await system.runtime.handle(new Request(
    `https://z-s.test/client/storage/configurations/${created.result.id}?environment=dev`,
    { headers: { cookie: clientA } },
  ));
  assert.equal(activeRead.status, 200);
  const activeText = await activeRead.text();
  assert.doesNotMatch(activeText, new RegExp(FIRST_AUTHORITY));
  assert.doesNotMatch(activeText, new RegExp(SECOND_AUTHORITY));

  const cloneResponse = await system.runtime.handle(new Request(
    `https://z-s.test/client/storage/configurations/${created.result.id}/clone?environment=dev`,
    { method: 'POST', headers: { cookie: clientA } },
  ));
  assert.equal(cloneResponse.status, 201);
  const cloned = await cloneResponse.json() as { result: ConfigurationDraftDocument & { id: string } };

  const draftRead = await system.runtime.handle(new Request(
    `https://z-s.test/client/storage/configurations/${cloned.result.id}?environment=dev`,
    { headers: { cookie: clientA } },
  ));
  assert.equal(draftRead.status, 200);
  const draftBody = await draftRead.json() as { result: ConfigurationDraftDocument };
  const editPayload = browserPayload(draftBody.result) as {
    providerConnections: unknown[];
    vaults: unknown[];
    routes: unknown[];
    imagePresets: Array<Record<string, unknown>>;
  };
  editPayload.imagePresets[0] = {
    ...editPayload.imagePresets[0],
    outputFormat: 'png',
  };

  const saveResponse = await system.runtime.handle(new Request(
    `https://z-s.test/client/storage/configurations/${cloned.result.id}?environment=dev`,
    {
      method: 'PUT',
      headers: { cookie: clientA, 'content-type': 'application/json' },
      body: JSON.stringify(editPayload),
    },
  ));
  assert.equal(saveResponse.status, 200);
  const saveText = await saveResponse.text();
  assert.doesNotMatch(saveText, new RegExp(FIRST_AUTHORITY));
  assert.doesNotMatch(saveText, new RegExp(SECOND_AUTHORITY));
  const saved = JSON.parse(saveText) as {
    result: { validationState: string; imagePresets: Array<{ outputFormat: string }> };
  };
  assert.equal(saved.result.validationState, 'valid');
  assert.equal(saved.result.imagePresets[0]?.outputFormat, 'png');

  const internalDraft = await system.base.readVersion('client-a', 'dev', cloned.result.id);
  assert.deepEqual(
    internalDraft.providerConnections.map((connection) => connection.secretReferenceId),
    [FIRST_AUTHORITY, SECOND_AUTHORITY],
  );
  const internalActive = await system.base.readVersion('client-a', 'dev', created.result.id);
  assert.equal(internalActive.state, 'active');
  assert.equal(internalActive.imagePresets[0]?.outputFormat, 'webp');
});

test('client route rejects signed-out, cross-client, and tampered draft replacement', async () => {
  const system = routeSystem();
  const clientA = await clientCookie(system.runtime, 'client-a');
  const clientB = await clientCookie(system.runtime, 'client-b');
  const createResponse = await system.runtime.handle(new Request(
    'https://z-s.test/client/storage/configurations',
    {
      method: 'POST',
      headers: { cookie: clientA, 'content-type': 'application/json' },
      body: JSON.stringify(configurationDocument()),
    },
  ));
  const created = await createResponse.json() as { result: { id: string } };
  const original = await system.base.readVersion('client-a', 'dev', created.result.id);
  const payload = browserPayload(original) as {
    providerConnections: unknown[];
    vaults: unknown[];
    routes: unknown[];
    imagePresets: unknown[];
  };

  const signedOut = await system.runtime.handle(new Request(
    `https://z-s.test/client/storage/configurations/${created.result.id}?environment=dev`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
  ));
  assert.equal(signedOut.status, 401);
  assert.deepEqual(await signedOut.json(), { error: { code: 'client-login-required' } });

  const crossClientRead = await system.runtime.handle(new Request(
    `https://z-s.test/client/storage/configurations/${created.result.id}?environment=dev`,
    { headers: { cookie: clientB } },
  ));
  assert.equal(crossClientRead.status, 404);
  const crossClientSave = await system.runtime.handle(new Request(
    `https://z-s.test/client/storage/configurations/${created.result.id}?environment=dev`,
    {
      method: 'PUT',
      headers: { cookie: clientB, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
  ));
  assert.equal(crossClientSave.status, 404);

  payload.providerConnections = payload.providerConnections.slice(0, 1);
  const tampered = await system.runtime.handle(new Request(
    `https://z-s.test/client/storage/configurations/${created.result.id}?environment=dev`,
    {
      method: 'PUT',
      headers: { cookie: clientA, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
  ));
  assert.equal(tampered.status, 400);
  assert.deepEqual(await tampered.json(), {
    error: { code: 'provider-connection-authority-mismatch' },
  });
  assert.deepEqual(await system.base.readVersion('client-a', 'dev', created.result.id), original);
});
