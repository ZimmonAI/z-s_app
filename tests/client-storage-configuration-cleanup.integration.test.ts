import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { PostgresClientStorageConfigurationStore } from '../src/client-storage-configuration-postgres.js';
import {
  adaptPool,
  apply0005,
  applyConfigurationCleanupMigrations,
  configurationDraftDocument,
  configurationError,
  databaseUrl,
  integrationTest,
  resetAndApplyThrough0004,
  seedClients,
} from './client-storage-configuration-integration-helpers.js';

integrationTest('PostgreSQL store deletes draft rows while preserving append-only audit history', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    await resetAndApplyThrough0004(pool);
    await apply0005(pool);
    await applyConfigurationCleanupMigrations(pool);
    await seedClients(pool);
    const store = new PostgresClientStorageConfigurationStore(adaptPool(pool));

    const draft = await store.createDraft('video-maker_app', {
      environment: 'dev',
      ...configurationDraftDocument(),
    }, new Date('2026-08-02T00:00:00.000Z'));

    await assert.rejects(
      pool.query(
        `
UPDATE public.storage_control_configuration_audit_events
SET configuration_version_id = NULL
WHERE configuration_version_id = $1
`,
        [draft.id],
      ),
      /configuration audit events are append-only/,
    );

    await store.deleteDraft('video-maker_app', 'dev', draft.id);

    await assert.rejects(
      store.readVersion('video-maker_app', 'dev', draft.id),
      configurationError('configuration-version-not-found'),
    );
    const auditEvents = await pool.query<{
      event_type: string;
      configuration_version_id: string | null;
    }>(`
SELECT event_type, configuration_version_id
FROM public.storage_control_configuration_audit_events
WHERE event_type IN ('configuration-draft-created', 'configuration-draft-deleted')
ORDER BY occurred_at, event_type
`);
    assert.deepEqual(
      auditEvents.rows.map((row) => row.event_type),
      ['configuration-draft-created', 'configuration-draft-deleted'],
    );
    assert.deepEqual(
      auditEvents.rows.map((row) => row.configuration_version_id),
      [null, null],
    );
    await assert.rejects(
      pool.query(`
UPDATE public.storage_control_configuration_audit_events
SET safe_summary = '{}'::jsonb
WHERE event_type = 'configuration-draft-deleted'
`),
      /configuration audit events are append-only/,
    );
  } finally {
    await pool.end();
  }
});
