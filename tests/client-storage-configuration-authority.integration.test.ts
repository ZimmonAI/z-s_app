import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { PostgresClientStorageConfigurationStore } from '../src/client-storage-configuration-postgres.js';
import { SafeClientStorageConfigurationStore } from '../src/client-storage-configuration-safe.js';
import {
  adaptPool,
  apply0005,
  applyConfigurationCleanupMigrations,
  configurationDraftDocument,
  databaseUrl,
  integrationTest,
  resetAndApplyThrough0004,
  seedClients,
} from './client-storage-configuration-integration-helpers.js';

integrationTest('PostgreSQL browser-safe draft replacement preserves provider authority through activation', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    await resetAndApplyThrough0004(pool);
    await apply0005(pool);
    await applyConfigurationCleanupMigrations(pool);
    await seedClients(pool);

    const base = new PostgresClientStorageConfigurationStore(adaptPool(pool));
    const safe = new SafeClientStorageConfigurationStore(base);
    const source = configurationDraftDocument();
    const firstDraft = await base.createDraft('video-maker_app', {
      environment: 'dev',
      ...source,
    }, new Date('2026-08-05T16:00:00.000Z'));
    const firstActive = await base.activateDraft(
      'video-maker_app',
      'dev',
      firstDraft.id,
      new Date('2026-08-05T16:01:00.000Z'),
    );
    const cloned = await safe.cloneVersion(
      'video-maker_app',
      'dev',
      firstActive.id,
      new Date('2026-08-05T16:02:00.000Z'),
    );
    const rawClone = await base.readVersion('video-maker_app', 'dev', cloned.id);
    const expectedAuthority = new Map(rawClone.providerConnections.map((connection) => [
      connection.connectionId,
      connection.secretReferenceId,
    ]));

    const replaced = await safe.replaceDraft(
      'video-maker_app',
      'dev',
      cloned.id,
      {
        providerConnections: cloned.providerConnections.map((connection) => ({
          connectionId: connection.connectionId,
          displayLabel: connection.displayLabel,
          providerType: connection.providerType,
          secretReferenceId: '',
        })),
        vaults: cloned.vaults,
        routes: cloned.routes,
        imagePresets: cloned.imagePresets.map((preset) =>
          preset.presetId === 'web-images'
            ? { ...preset, outputFormat: 'png' as const }
            : preset),
      },
      new Date('2026-08-05T16:03:00.000Z'),
    );
    assert.equal(replaced.validationState, 'valid');
    assert.equal(replaced.imagePresets[0]?.outputFormat, 'png');
    assert.equal(
      replaced.providerConnections.every((connection) => connection.secretReferenceId === ''),
      true,
    );

    const persisted = await pool.query<{
      connection_id: string;
      secret_reference_id: string;
    }>(`
SELECT connection.connection_id, connection.secret_reference_id
FROM public.storage_control_provider_connections AS connection
JOIN public.storage_control_clients AS client
  ON client.id = connection.storage_control_client_id
WHERE client.client_id = 'video-maker_app'
  AND connection.environment = 'dev'
ORDER BY connection.connection_id
`);
    assert.equal(persisted.rows.length, expectedAuthority.size);
    assert.equal(
      persisted.rows.every((row) =>
        expectedAuthority.get(row.connection_id) === row.secret_reference_id),
      true,
    );

    const crossClient = await pool.query<{ count: string }>(`
SELECT count(*)::text AS count
FROM public.storage_control_provider_connections AS connection
JOIN public.storage_control_clients AS client
  ON client.id = connection.storage_control_client_id
WHERE client.client_id = 'other-client'
  AND connection.connection_id = ANY($1::text[])
`, [[...expectedAuthority.keys()]]);
    assert.equal(crossClient.rows[0]?.count, '0');

    const activated = await safe.activateDraft(
      'video-maker_app',
      'dev',
      cloned.id,
      new Date('2026-08-05T16:04:00.000Z'),
    );
    assert.equal(activated.state, 'active');
    assert.equal(activated.imagePresets[0]?.outputFormat, 'png');
    assert.equal(
      (await base.readVersion('video-maker_app', 'dev', firstActive.id)).state,
      'superseded',
    );
    const rawActive = await base.readVersion('video-maker_app', 'dev', cloned.id);
    assert.equal(
      rawActive.providerConnections.every((connection) =>
        expectedAuthority.get(connection.connectionId) === connection.secretReferenceId),
      true,
    );
  } finally {
    await pool.end();
  }
});
