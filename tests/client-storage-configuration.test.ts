import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ClientStorageConfigurationError,
  InMemoryClientStorageConfigurationStore,
  validateConfigurationDraft,
  type ConfigurationDraftDocument,
} from '../src/client-storage-configuration.js';

const NOW = new Date('2026-08-02T00:00:00.000Z');

function validDocument() {
  return {
    providerConnections: [
      {
        connectionId: 'minio-production',
        displayLabel: 'MinIO production',
        providerType: 'minio',
        secretReferenceId: 'vault:z-s:minio-production',
        safeMetadata: { regionLabel: 'local-primary' } as Readonly<Record<string, unknown>>,
      },
      {
        connectionId: 'r2-video-maker',
        displayLabel: 'R2 Video Maker',
        providerType: 'r2',
        secretReferenceId: 'vault:z-s:r2-video-maker',
        safeMetadata: { regionLabel: 'global-hot' } as Readonly<Record<string, unknown>>,
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
        displayLabel: 'Image derivatives',
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
        widths: [512, 1024, 1600],
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
        targets: [
          { role: 'primary', vaultId: 'originals-minio' },
          { role: 'replica', vaultId: 'hot-r2-seven-day' },
        ],
      },
      {
        routeId: 'documents',
        assetClass: 'document',
        targets: [
          { role: 'primary', vaultId: 'originals-minio' },
          { role: 'replica', vaultId: 'hot-r2-seven-day' },
        ],
      },
    ],
  } satisfies ConfigurationDraftDocument;
}

function store(): InMemoryClientStorageConfigurationStore {
  const result = new InMemoryClientStorageConfigurationStore();
  result.registerClient('client-a');
  result.registerClient('client-b');
  return result;
}

function configurationError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ClientStorageConfigurationError && error.code === code;
}

test('drafts support client-scoped create, read, replace, and delete', async () => {
  const repository = store();
  const draft = await repository.createDraft('client-a', {
    environment: 'dev',
    ...validDocument(),
  }, NOW);
  assert.equal(draft.state, 'draft');
  assert.equal(draft.validationState, 'valid');
  assert.equal(draft.versionNumber, 1);

  const read = await repository.readVersion('client-a', 'dev', draft.id);
  assert.deepEqual(read, draft);

  const changed = validDocument();
  changed.vaults[0] = { ...changed.vaults[0]!, displayLabel: 'Permanent originals' };
  const replaced = await repository.replaceDraft('client-a', 'dev', draft.id, changed, NOW);
  assert.equal(replaced.vaults[0]?.displayLabel, 'Permanent originals');

  await repository.deleteDraft('client-a', 'dev', draft.id);
  await assert.rejects(
    repository.readVersion('client-a', 'dev', draft.id),
    configurationError('configuration-version-not-found'),
  );
});

test('invalid configuration cannot activate and reports bounded validation codes', async () => {
  const repository = store();
  const invalid = validDocument();
  invalid.routes[0] = {
    ...invalid.routes[0]!,
    targets: [{ role: 'replica', vaultId: 'hot-r2-seven-day' }],
  };
  const errors = validateConfigurationDraft(invalid);
  assert.deepEqual(errors, ['route-primary-required']);

  const draft = await repository.createDraft('client-a', {
    environment: 'dev',
    ...invalid,
  }, NOW);
  assert.equal(draft.validationState, 'invalid');
  await assert.rejects(
    repository.activateDraft('client-a', 'dev', draft.id, NOW),
    configurationError('configuration-version-invalid'),
  );
  const overview = await repository.overview('client-a', 'dev');
  assert.equal(overview.activeVersion, undefined);
});

test('activation keeps exactly one active immutable version and rollback clones history', async () => {
  const repository = store();
  const firstDraft = await repository.createDraft('client-a', {
    environment: 'dev',
    ...validDocument(),
  }, NOW);
  const firstActive = await repository.activateDraft('client-a', 'dev', firstDraft.id, NOW);
  assert.equal(firstActive.state, 'active');
  await assert.rejects(
    repository.replaceDraft('client-a', 'dev', firstActive.id, validDocument(), NOW),
    configurationError('configuration-version-immutable'),
  );

  const secondDocument = validDocument();
  secondDocument.imagePresets[0] = { ...secondDocument.imagePresets[0]!, quality: 76 };
  const secondDraft = await repository.createDraft('client-a', {
    environment: 'dev',
    ...secondDocument,
  }, new Date('2026-08-02T00:01:00.000Z'));
  const secondActive = await repository.activateDraft(
    'client-a',
    'dev',
    secondDraft.id,
    new Date('2026-08-02T00:02:00.000Z'),
  );
  const firstAfter = await repository.readVersion('client-a', 'dev', firstActive.id);
  assert.equal(firstAfter.state, 'superseded');
  assert.equal(secondActive.state, 'active');
  const overview = await repository.overview('client-a', 'dev');
  assert.equal(overview.activeVersion?.id, secondActive.id);

  const rollbackDraft = await repository.cloneVersion(
    'client-a',
    'dev',
    firstAfter.id,
    new Date('2026-08-02T00:03:00.000Z'),
  );
  assert.equal(rollbackDraft.state, 'draft');
  assert.equal(rollbackDraft.clonedFromVersionId, firstAfter.id);
  assert.notEqual(rollbackDraft.id, firstAfter.id);
  assert.equal(rollbackDraft.imagePresets[0]?.quality, 82);
});

test('client ownership prevents cross-client reads and mutations', async () => {
  const repository = store();
  const draft = await repository.createDraft('client-a', {
    environment: 'dev',
    ...validDocument(),
  }, NOW);
  await assert.rejects(
    repository.readVersion('client-b', 'dev', draft.id),
    configurationError('configuration-version-not-found'),
  );
  await assert.rejects(
    repository.activateDraft('client-b', 'dev', draft.id, NOW),
    configurationError('configuration-version-not-found'),
  );
  const overview = await repository.overview('client-b', 'dev');
  assert.equal(overview.draftVersions.length, 0);
});

test('integration tokens reveal once, persist digest only, enforce scopes, rotate, expire, and revoke', async () => {
  const repository = store();
  const created = await repository.createIntegrationToken('client-a', {
    environment: 'dev',
    tokenId: 'runtime-writer',
    displayLabel: 'Runtime writer',
    scopes: ['object:write'],
    expiresAt: new Date('2026-08-03T00:00:00.000Z'),
  }, NOW);
  assert.match(created.token, /^zs_it_[A-Za-z0-9_-]+$/);
  const listing = await repository.listIntegrationTokens('client-a', 'dev', NOW);
  assert.equal(listing.length, 1);
  const serializedListing = JSON.stringify(listing);
  assert.doesNotMatch(serializedListing, new RegExp(created.token));
  assert.doesNotMatch(serializedListing, /digest/i);

  const authenticated = await repository.authenticateIntegrationToken(
    created.token,
    'object:write',
    NOW,
  );
  assert.equal(authenticated.kind, 'authenticated');
  const denied = await repository.authenticateIntegrationToken(
    created.token,
    'object:read',
    NOW,
  );
  assert.deepEqual(denied, { kind: 'scope-denied' });

  const rotated = await repository.rotateIntegrationToken(
    'client-a',
    'dev',
    'runtime-writer',
    new Date('2026-08-02T01:00:00.000Z'),
  );
  assert.notEqual(rotated.token, created.token);
  assert.deepEqual(
    await repository.authenticateIntegrationToken(created.token, 'object:write', NOW),
    { kind: 'revoked' },
  );
  assert.equal(
    (await repository.authenticateIntegrationToken(rotated.token, 'object:write', NOW)).kind,
    'authenticated',
  );

  await repository.revokeIntegrationToken(
    'client-a',
    'dev',
    rotated.metadata.tokenId,
    new Date('2026-08-02T02:00:00.000Z'),
  );
  assert.deepEqual(
    await repository.authenticateIntegrationToken(rotated.token, 'object:write', NOW),
    { kind: 'revoked' },
  );

  const expiring = await repository.createIntegrationToken('client-a', {
    environment: 'dev',
    tokenId: 'short-lived',
    displayLabel: 'Short lived',
    scopes: ['object:read'],
    expiresAt: new Date('2026-08-02T03:00:00.000Z'),
  }, NOW);
  assert.deepEqual(
    await repository.authenticateIntegrationToken(
      expiring.token,
      'object:read',
      new Date('2026-08-02T03:00:01.000Z'),
    ),
    { kind: 'expired' },
  );
});

test('provider metadata rejects secret-bearing keys before persistence', async () => {
  const repository = store();
  const unsafe = validDocument();
  unsafe.providerConnections[0] = {
    ...unsafe.providerConnections[0]!,
    safeMetadata: { credentialValue: 'redacted-fixture' },
  };
  await assert.rejects(
    repository.createDraft('client-a', { environment: 'dev', ...unsafe }, NOW),
    configurationError('unsafe-metadata-key'),
  );
});
