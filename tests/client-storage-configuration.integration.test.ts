import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool, type PoolClient } from 'pg';
import {
  ClientStorageConfigurationError,
  type ConfigurationDraftDocument,
} from '../src/client-storage-configuration.js';
import { PostgresClientStorageConfigurationStore } from '../src/client-storage-configuration-postgres.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryable,
  PostgresQueryResult,
} from '../src/runtime-storage-registry-types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationTest = databaseUrl === undefined ? test.skip : test;

function adaptClient(client: PoolClient): PostgresClientLike {
  return {
    query: async <Row extends Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<PostgresQueryResult<Row>> => {
      const result = await client.query<Row>(text, values as unknown[] | undefined);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    release: () => client.release(),
  };
}

function adaptPool(pool: Pool): PostgresPoolLike & PostgresQueryable {
  return {
    connect: async () => adaptClient(await pool.connect()),
    query: async <Row extends Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<PostgresQueryResult<Row>> => {
      const result = await pool.query<Row>(text, values as unknown[] | undefined);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
}

async function resetAndApplyThrough0004(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  for (const migration of [
    '0001_z_s_control_plane_foundation.sql',
    '0002_z_s_runtime_registry.sql',
    '0003_z_s_read_delivery.sql',
    '0004_z_s_storage_control_vaults.sql',
  ]) {
    await pool.query(await readFile(`db/migrations/${migration}`, 'utf8'));
  }
}

async function apply0005(pool: Pool): Promise<void> {
  await pool.query(
    await readFile('db/migrations/0005_z_s_client_storage_configuration.sql', 'utf8'),
  );
}

async function seedClients(pool: Pool): Promise<void> {
  const now = new Date('2026-08-02T00:00:00.000Z');
  await pool.query(`
INSERT INTO public.storage_control_clients (
  id, client_id, display_label, status, created_at, updated_at
) VALUES
  ($1, 'video-maker_app', 'Video Maker', 'active', $3, $3),
  ($2, 'other-client', 'Other Client', 'active', $3, $3)
`, [randomUUID(), randomUUID(), now]);
}

function document(): ConfigurationDraftDocument {
  return {
    providerConnections: [
      {
        connectionId: 'minio-primary',
        displayLabel: 'MinIO primary',
        providerType: 'minio',
        secretReferenceId: 'vault:z-s:minio-primary',
        safeMetadata: { regionLabel: 'local-primary' },
      },
      {
        connectionId: 'r2-hot',
        displayLabel: 'R2 hot',
        providerType: 'r2',
        secretReferenceId: 'vault:z-s:r2-hot',
        safeMetadata: { regionLabel: 'global-hot' },
      },
    ],
    vaults: [
      {
        vaultId: 'originals',
        providerConnectionId: 'minio-primary',
        displayLabel: 'Originals',
        purpose: 'originals',
        bucketLabel: 'video-maker-originals',
        prefixTemplate: 'video-maker/originals/*',
        retention: { mode: 'permanent' },
      },
      {
        vaultId: 'hot-copy',
        providerConnectionId: 'r2-hot',
        displayLabel: 'Hot copy',
        purpose: 'hot-copy',
        bucketLabel: 'video-maker-hot',
        prefixTemplate: 'video-maker/hot/*',
        retention: { mode: 'delete-after-days', deleteAfterDays: 7 },
      },
      {
        vaultId: 'derivatives',
        providerConnectionId: 'r2-hot',
        displayLabel: 'Derivatives',
        purpose: 'derivatives',
        bucketLabel: 'video-maker-derivatives',
        prefixTemplate: 'video-maker/derivatives/*',
        retention: { mode: 'permanent' },
      },
    ],
    imagePresets: [
      {
        presetId: 'web-images',
        targetVaultId: 'derivatives',
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
          { role: 'primary', vaultId: 'originals' },
          { role: 'replica', vaultId: 'hot-copy' },
        ],
        imagePresetId: 'web-images',
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
  };
}

function configurationError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ClientStorageConfigurationError && error.code === code;
}

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
    await seedClients(pool);
    const store = new PostgresClientStorageConfigurationStore(adaptPool(pool));
    const firstDraft = await store.createDraft('video-maker_app', {
      environment: 'dev',
      ...document(),
    }, new Date('2026-08-02T00:00:00.000Z'));
    const firstActive = await store.activateDraft(
      'video-maker_app',
      'dev',
      firstDraft.id,
      new Date('2026-08-02T00:01:00.000Z'),
    );
    assert.equal(firstActive.state, 'active');
    await assert.rejects(
      store.replaceDraft('video-maker_app', 'dev', firstActive.id, document()),
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
