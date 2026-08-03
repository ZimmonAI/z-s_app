import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InMemoryClientStorageConfigurationStore,
  type ConfigurationVersionSnapshot,
} from '../src/client-storage-configuration.js';
import {
  clientStorageControlOverviewPage,
  clientStorageControlVersionPage,
  clientStorageControlWorkspacePage,
} from '../src/client-storage-control-presentation.js';

const NOW = new Date('2026-08-03T00:00:00.000Z');
const ACCOUNT = Object.freeze({
  clientId: 'video-maker_app',
  displayLabel: 'Video Maker',
});

function documentPayload() {
  return {
    providerConnections: [
      {
        connectionId: 'r2-video-maker',
        displayLabel: 'R2 Video Maker',
        providerType: 'r2' as const,
        secretReferenceId: 'vault:z-s:r2-video-maker',
        safeMetadata: { regionLabel: 'global-hot' },
      },
    ],
    vaults: [
      {
        vaultId: 'originals-r2',
        providerConnectionId: 'r2-video-maker',
        displayLabel: 'Originals',
        purpose: 'originals' as const,
        bucketLabel: 'video-maker-originals',
        prefixTemplate: 'video-maker/originals/*',
        retention: { mode: 'permanent' as const },
      },
      {
        vaultId: 'derivatives-r2',
        providerConnectionId: 'r2-video-maker',
        displayLabel: 'Derivatives',
        purpose: 'derivatives' as const,
        bucketLabel: 'video-maker-derivatives',
        prefixTemplate: 'video-maker/derivatives/*',
        retention: { mode: 'delete-after-days' as const, deleteAfterDays: 30 },
      },
    ],
    routes: [
      {
        routeId: 'images',
        assetClass: 'image' as const,
        targets: [
          { role: 'primary' as const, vaultId: 'originals-r2' },
          { role: 'replica' as const, vaultId: 'derivatives-r2' },
        ],
        imagePresetId: 'web-images',
      },
      {
        routeId: 'videos',
        assetClass: 'video' as const,
        targets: [{ role: 'primary' as const, vaultId: 'originals-r2' }],
      },
      {
        routeId: 'documents',
        assetClass: 'document' as const,
        targets: [{ role: 'primary' as const, vaultId: 'originals-r2' }],
      },
    ],
    imagePresets: [
      {
        presetId: 'web-images',
        targetVaultId: 'derivatives-r2',
        widths: [512, 1024],
        outputFormat: 'webp' as const,
        quality: 82,
        fit: 'inside' as const,
      },
    ],
  };
}

async function fixture(): Promise<Readonly<{
  overview: Awaited<ReturnType<InMemoryClientStorageConfigurationStore['overview']>>;
  draft: Readonly<ConfigurationVersionSnapshot>;
  tokens: Awaited<ReturnType<InMemoryClientStorageConfigurationStore['listIntegrationTokens']>>;
}>> {
  const store = new InMemoryClientStorageConfigurationStore();
  store.registerClient(ACCOUNT.clientId);
  const draft = await store.createDraft(ACCOUNT.clientId, {
    environment: 'dev',
    ...documentPayload(),
  }, NOW);
  await store.createIntegrationToken(ACCOUNT.clientId, {
    environment: 'dev',
    tokenId: 'runtime-writer',
    displayLabel: 'Runtime writer',
    scopes: ['object:write'],
  }, NOW);
  return Object.freeze({
    overview: await store.overview(ACCOUNT.clientId, 'dev'),
    draft,
    tokens: await store.listIntegrationTokens(ACCOUNT.clientId, 'dev', NOW),
  });
}

test('overview provides environment navigation and a browser-operated draft action', async () => {
  const data = await fixture();
  const page = clientStorageControlOverviewPage(ACCOUNT, data.overview);
  assert.match(page, /Client Storage Control Center|client storage control center/i);
  assert.match(page, /aria-label="Storage environment"/);
  assert.match(page, /data-create-draft/);
  assert.match(page, /Open workspace/);
  assert.match(page, /Provider references/);
  assert.match(page, /Integration tokens/);
  assert.doesNotMatch(page, /<textarea/i);
});

test('workspace exposes draft, token lifecycle, confirmation, and reveal-once controls', async () => {
  const data = await fixture();
  const page = clientStorageControlWorkspacePage(ACCOUNT, data.overview, data.tokens);
  assert.match(page, /Configuration workspace/);
  assert.match(page, /Open editor/);
  assert.match(page, /Create integration token/);
  assert.match(page, /name="scope" value="object:write"/);
  assert.match(page, /data-rotate-token="runtime-writer"/);
  assert.match(page, /data-revoke-token="runtime-writer"/);
  assert.match(page, /id="client-storage-token-reveal"/);
  assert.match(page, /Token ID and bearer token are different/);
  assert.match(page, /data-token-acknowledgement/);
  assert.match(page, /Detailed activity is unavailable/);
  assert.doesNotMatch(page, /zs_it_/);
  assert.doesNotMatch(page, /tokenDigest|token_digest/);
});

test('draft editor provides normal controls for vaults, routes, ordered targets, presets, and activation', async () => {
  const data = await fixture();
  const page = clientStorageControlVersionPage(ACCOUNT, data.draft);
  assert.match(page, /Approved provider connections/);
  assert.match(page, /data-add-vault/);
  assert.match(page, /data-add-route/);
  assert.match(page, /data-add-preset/);
  assert.match(page, /data-save-draft/);
  assert.match(page, /data-activate-version/);
  assert.match(page, /data-discard-version/);
  assert.match(page, /data-comparison/);
  assert.match(page, /Move up/);
  assert.match(page, /Save and validate/);
  assert.doesNotMatch(page, /hand-written JSON|Paste JSON/i);
});

test('immutable version is read-only and cloneable', async () => {
  const data = await fixture();
  const store = new InMemoryClientStorageConfigurationStore();
  store.registerClient(ACCOUNT.clientId);
  const draft = await store.createDraft(ACCOUNT.clientId, {
    environment: 'dev',
    ...documentPayload(),
  }, NOW);
  const active = await store.activateDraft(ACCOUNT.clientId, 'dev', draft.id, NOW);
  const page = clientStorageControlVersionPage(ACCOUNT, active);
  assert.match(page, /Immutable policy/);
  assert.match(page, /Clone into new draft/);
  assert.doesNotMatch(page, /data-save-draft/);
  assert.doesNotMatch(page, /data-discard-version/);
  assert.match(page, /1\. primary/);
  assert.equal(data.draft.state, 'draft');
});

test('browser adapter preserves existing JSON endpoints and clears reveal-once values', async () => {
  const data = await fixture();
  const page = clientStorageControlVersionPage(ACCOUNT, data.draft);
  assert.match(page, /\/client\/storage\/configurations/);
  assert.match(page, /method: 'PUT'/);
  assert.match(page, /method: 'DELETE'/);
  assert.match(page, /\/activate/);
  assert.match(page, /\/clone/);
  assert.match(page, /tokenNode\.textContent = ''/);
  assert.match(page, /navigator\.clipboard\.writeText/);
  assert.match(page, /credentials: 'same-origin'/);
});
