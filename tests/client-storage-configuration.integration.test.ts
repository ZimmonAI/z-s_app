import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

integrationTest('0005 migrates up, comments all columns, refuses reapply, and rolls down empty state', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    await resetAndApplyThrough0004(pool);
    await apply0005(pool);
    const tables = await pool.query<{ count: string }>(`
SELECT count(*)::text AS count
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
`);
    assert.equal(tables.rows[0]?.count, '28');

    const missingComments = await pool.query<{ count: string }>(`
SELECT count(*)::text AS count
FROM information_schema.columns AS columns
JOIN pg_catalog.pg_class AS relation ON relation.relname = columns.table_name
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = relation.relnamespace AND namespace.nspname = columns.table_schema
JOIN pg_catalog.pg_attribute AS attribute
  ON attribute.attrelid = relation.oid AND attribute.attname = columns.column_name
WHERE columns.table_schema = 'public'
  AND columns.table_name LIKE 'storage_control_configuration_%'
  AND COALESCE(col_description(relation.oid, attribute.attnum), '') NOT LIKE '%01-online-configuration-platform-coding.md%'
`);
    assert.equal(missingComments.rows[0]?.count, '0');

    const reapplyClient = await pool.connect();
    try {
      await assert.rejects(
        reapplyClient.query(
          await readFile('db/migrations/0005_z_s_client_storage_configuration.sql', 'utf8'),
        ),
        /migration already applied/,
      );
      await reapplyClient.query('ROLLBACK');
    } finally {
      reapplyClient.release();
    }

    await pool.query(
      await readFile('db/migrations/0005_z_s_client_storage_configuration.down.sql', 'utf8'),
    );
    const after = await pool.query<{ count: string }>(`
SELECT count(*)::text AS count
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
`);
    assert.equal(after.rows[0]?.count, '20');
  } finally {
    await pool.end();
  }
});

integrationTest('PostgreSQL store enforces one active immutable version, client ownership, and digest-only tokens', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    await resetAndApplyThrough0004(pool);
    await apply0005(pool);
    await applyConfigurationCleanupMigrations(pool);
    await seedClients(pool);
    const store = new PostgresClientStorageConfigurationStore(adaptPool(pool));
    const firstDraft = await store.createDraft('video-maker_app', {
      environment: 'dev',
      ...configurationDraftDocument(),
    }, new Date('2026-08-02T00:00:00.000Z'));
    const firstActive = await store.activateDraft(
      'video-maker_app',
      'dev',
      firstDraft.id,
      new Date('2026-08-02T00:01:00.000Z'),
    );
    assert.equal(firstActive.state, 'active');
    await assert.rejects(
      store.replaceDraft('video-maker_app', 'dev', firstActive.id, configurationDraftDocument()),
      configurationError('configuration-version-immutable'),
    );

    const secondDraft = await store.cloneVersion(
      'video-maker_app',
      'dev',
      firstActive.id,
      new Date('2026-08-02T00:02:00.000Z'),
    );
    const secondActive = await store.activateDraft(
      'video-maker_app',
      'dev',
      secondDraft.id,
      new Date('2026-08-02T00:03:00.000Z'),
    );
    assert.equal(secondActive.state, 'active');
    assert.equal(
      (await store.readVersion('video-maker_app', 'dev', firstActive.id)).state,
      'superseded',
    );
    const activeCount = await pool.query<{ count: string }>(`
SELECT count(*)::text AS count
FROM public.storage_control_configuration_versions
WHERE state = 'active'
`);
    assert.equal(activeCount.rows[0]?.count, '1');

    await assert.rejects(
      store.readVersion('other-client', 'dev', secondActive.id),
      configurationError('configuration-version-not-found'),
    );

    const created = await store.createIntegrationToken('video-maker_app', {
      environment: 'dev',
      tokenId: 'runtime-reader',
      displayLabel: 'Runtime reader',
      scopes: ['object:read'],
    }, new Date('2026-08-02T00:04:00.000Z'));
    const persisted = await pool.query<{
      token_digest: string;
      token_id: string;
    }>(`
SELECT token_digest, token_id
FROM public.storage_control_integration_tokens
WHERE token_id = 'runtime-reader'
`);
    assert.match(persisted.rows[0]?.token_digest ?? '', /^[a-f0-9]{64}$/);
    assert.notEqual(persisted.rows[0]?.token_digest, created.token);
    assert.equal(
      (await store.authenticateIntegrationToken(
        created.token,
        'object:read',
        new Date('2026-08-02T00:05:00.000Z'),
      )).kind,
      'authenticated',
    );
    assert.deepEqual(
      await store.authenticateIntegrationToken(
        created.token,
        'object:write',
        new Date('2026-08-02T00:05:00.000Z'),
      ),
      { kind: 'scope-denied' },
    );
  } finally {
    await pool.end();
  }
});
