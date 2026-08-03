import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { PostgresActiveConfigurationResolver } from '../src/runtime-active-configuration.js';
import { PostgresClientStorageConfigurationStore } from '../src/client-storage-configuration-postgres.js';
import { PostgresImageDerivativeStore } from '../src/image-derivative-postgres.js';
import type { ProviderCredentialResolver } from '../src/runtime-s3-provider.js';
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

async function apply0010(pool: Pool): Promise<void> {
  await pool.query(await readFile('db/migrations/0010_z_s_runtime_configuration_routing.sql', 'utf8'));
}

async function apply0011(pool: Pool): Promise<void> {
  await pool.query(await readFile('db/migrations/0011_z_s_image_derivatives.sql', 'utf8'));
}

async function resetAndApplyThrough0011(pool: Pool): Promise<void> {
  await resetAndApplyThrough0004(pool);
  await apply0005(pool);
  await applyConfigurationCleanupMigrations(pool);
  await apply0010(pool);
  await apply0011(pool);
}

const credentialResolver: ProviderCredentialResolver = {
  resolve: async () => Object.freeze({
    endpoint: 'https://provider.invalid',
    region: 'auto',
    forcePathStyle: false,
    accessKeyId: 'test-access-key',
    secretAccessKey: ['test', 'credential', 'material'].join('-'),
  }),
};

async function insertVerifiedObject(
  pool: Pool,
  authority: Awaited<ReturnType<PostgresActiveConfigurationResolver['resolve']>>,
  contentType: string,
): Promise<string> {
  const storageObjectId = randomUUID();
  const checksum = 'c'.repeat(64);
  const now = new Date('2026-08-03T00:02:00.000Z');
  await pool.query(`
INSERT INTO public.storage_objects (
  storage_object_id,
  managed_app_id,
  storage_profile_id,
  storage_profile_fingerprint,
  storage_prefix_class_id,
  storage_control_client_id,
  configuration_version_id,
  configuration_fingerprint,
  configuration_route_id,
  app_correlation_ref,
  source_reference,
  registry_state,
  object_protection_stage,
  expected_checksum_sha256,
  expected_byte_length,
  expected_content_type,
  verified_checksum_sha256,
  verified_byte_length,
  safe_technical_metadata,
  activated_at,
  created_at,
  updated_at
) VALUES (
  $1, NULL, NULL, NULL, NULL, $2, $3, $4, $5,
  $6, $7, 'active', 'configuration-primary-and-replicas-verified',
  $8, 128, $9, $8, 128, '{}'::jsonb, $10, $10, $10
)
`, [
    storageObjectId,
    authority.storageControlClientId,
    authority.configurationVersionId,
    authority.configurationFingerprint,
    authority.configurationRouteId,
    `derivative-source:${storageObjectId}`,
    `source:${storageObjectId}`,
    checksum,
    contentType,
    now,
  ]);
  for (const target of authority.targets) {
    await pool.query(`
INSERT INTO public.storage_object_copies (
  storage_object_copy_id,
  storage_object_id,
  storage_profile_provider_binding_id,
  provider_role,
  configuration_route_target_id,
  configuration_vault_id,
  provider_connection_id,
  target_role,
  target_order,
  internal_locator,
  copy_state,
  observed_checksum_sha256,
  observed_byte_length,
  latest_verified_at,
  created_at,
  updated_at
) VALUES (
  $1, $2, NULL, NULL, $3, $4, $5, $6, $7, $8,
  'verified', $9, 128, $10, $10, $10
)
`, [
      randomUUID(),
      storageObjectId,
      target.configurationRouteTargetId,
      target.configurationVaultId,
      target.providerConnectionId,
      target.role,
      target.order,
      target.prefixTemplate.replace(/\*$/, storageObjectId),
      checksum,
      now,
    ]);
  }
  return storageObjectId;
}

integrationTest('0011 applies with comments and rollback remains available for empty state', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    await resetAndApplyThrough0011(pool);
    const columns = await pool.query<{ table_name: string; column_name: string }>(`
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    table_name IN ('storage_image_derivative_jobs', 'storage_image_derivative_outputs')
    OR (table_name = 'storage_object_copies' AND column_name = 'image_derivative_job_id')
  )
`);
    assert.ok(columns.rows.length > 20);
    const undocumented = await pool.query<{ count: string }>(`
SELECT count(*)::text AS count
FROM information_schema.columns AS columns
JOIN pg_catalog.pg_class AS relation ON relation.relname = columns.table_name
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = relation.relnamespace AND namespace.nspname = columns.table_schema
JOIN pg_catalog.pg_attribute AS attribute
  ON attribute.attrelid = relation.oid AND attribute.attname = columns.column_name
WHERE columns.table_schema = 'public'
  AND columns.table_name IN ('storage_image_derivative_jobs', 'storage_image_derivative_outputs')
  AND COALESCE(col_description(relation.oid, attribute.attnum), '') = ''
`);
    assert.equal(undocumented.rows[0]?.count, '0');
    const reapply = await pool.connect();
    try {
      await assert.rejects(
        reapply.query(await readFile('db/migrations/0011_z_s_image_derivatives.sql', 'utf8')),
        /0011 migration already applied/,
      );
      await reapply.query('ROLLBACK');
    } finally {
      reapply.release();
    }
    await pool.query(await readFile('db/migrations/0011_z_s_image_derivatives.down.sql', 'utf8'));
    const after = await pool.query<{ value: string | null }>(`
SELECT to_regclass('public.storage_image_derivative_jobs')::text AS value
`);
    assert.equal(after.rows[0]?.value, null);
  } finally {
    await pool.end();
  }
});

integrationTest('verified image completion enqueues one immutable job per width and persists output lineage', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    await resetAndApplyThrough0011(pool);
    await seedClients(pool);
    const adapted = adaptPool(pool);
    const configurationStore = new PostgresClientStorageConfigurationStore(adapted);
    const draft = await configurationStore.createDraft('video-maker_app', {
      environment: 'dev',
      ...configurationDraftDocument(),
    }, new Date('2026-08-03T00:00:00.000Z'));
    await configurationStore.activateDraft(
      'video-maker_app',
      'dev',
      draft.id,
      new Date('2026-08-03T00:01:00.000Z'),
    );
    const resolver = new PostgresActiveConfigurationResolver({
      queryable: adapted,
      credentialResolver,
    });
    const imageAuthority = await resolver.resolve({
      clientId: 'video-maker_app', environment: 'dev', assetClass: 'image',
    });
    const sourceStorageObjectId = await insertVerifiedObject(pool, imageAuthority, 'image/png');
    const store = new PostgresImageDerivativeStore({
      pool: adapted,
      now: () => new Date('2026-08-03T00:03:00.000Z'),
    });
    assert.equal(await store.enqueueVerifiedSource(sourceStorageObjectId), 2);
    assert.equal(await store.enqueueVerifiedSource(sourceStorageObjectId), 0);
    const videoAuthority = await resolver.resolve({
      clientId: 'video-maker_app', environment: 'dev', assetClass: 'video',
    });
    const videoStorageObjectId = await insertVerifiedObject(pool, videoAuthority, 'video/mp4');
    assert.equal(await store.enqueueVerifiedSource(videoStorageObjectId), 0);
    const statuses = await store.listStatus('video-maker_app', 'dev');
    assert.deepEqual(
      statuses
        .map((row) => [row.width, row.outputFormat, row.state])
        .sort((left, right) => Number(left[0]) - Number(right[0])),
      [
        [512, 'webp', 'queued'],
        [1024, 'webp', 'queued'],
      ],
    );
    assert.equal((await store.listStatus('other-client', 'dev')).length, 0);

    const claimed = await store.claimNext('worker-1');
    assert.ok(claimed !== null);
    assert.equal(claimed.configurationVersionId, draft.id);
    assert.equal(claimed.presetId, 'web-images');
    assert.equal(claimed.targetVaultId !== imageAuthority.targets[0]?.configurationVaultId, true);
    const source = await store.readSource(claimed);
    assert.equal(source.storageObjectId, sourceStorageObjectId);
    assert.equal(source.copies.length, 2);

    const outputChecksum = 'd'.repeat(64);
    const reservation = await store.reserveOutput({
      job: claimed,
      checksumSha256: outputChecksum,
      byteLength: 64,
      contentType: 'image/webp',
    });
    assert.equal(reservation.target.bucketLabel, 'video-maker-derivatives');
    assert.equal(reservation.target.internalLocator.includes(reservation.storageObjectId), true);
    const completed = await store.completeOutput({
      job: claimed,
      reservation,
      checksumSha256: outputChecksum,
      byteLength: 64,
    });
    assert.equal(completed.state, 'succeeded');
    assert.equal(completed.outputStorageObjectId, reservation.storageObjectId);

    const lineage = await pool.query<{
      source_storage_object_id: string;
      output_storage_object_id: string;
      verified_checksum_sha256: string;
    }>(`
SELECT source_storage_object_id, output_storage_object_id, verified_checksum_sha256
FROM public.storage_image_derivative_outputs
WHERE image_derivative_job_id = $1
`, [claimed.jobId]);
    assert.deepEqual(lineage.rows[0], {
      source_storage_object_id: sourceStorageObjectId,
      output_storage_object_id: reservation.storageObjectId,
      verified_checksum_sha256: outputChecksum,
    });
    const derivativeCopy = await pool.query<{
      configuration_route_target_id: string | null;
      image_derivative_job_id: string;
      target_role: string | null;
    }>(`
SELECT configuration_route_target_id, image_derivative_job_id, target_role
FROM public.storage_object_copies
WHERE storage_object_id = $1
`, [reservation.storageObjectId]);
    assert.equal(derivativeCopy.rows[0]?.configuration_route_target_id, null);
    assert.equal(derivativeCopy.rows[0]?.image_derivative_job_id, claimed.jobId);
    assert.equal(derivativeCopy.rows[0]?.target_role, null);

    const rollback = await pool.connect();
    try {
      await assert.rejects(
        rollback.query(await readFile('db/migrations/0011_z_s_image_derivatives.down.sql', 'utf8')),
        /0011 rollback blocked: adopted image derivative rows exist/,
      );
      await rollback.query('ROLLBACK');
    } finally {
      rollback.release();
    }
  } finally {
    await pool.end();
  }
});

test('0011 migration is additive and names bounded derivative limits', async () => {
  const [up, down] = await Promise.all([
    readFile('db/migrations/0011_z_s_image_derivatives.sql', 'utf8'),
    readFile('db/migrations/0011_z_s_image_derivatives.down.sql', 'utf8'),
  ]);
  for (const value of [
    'storage_image_derivative_jobs',
    'storage_image_derivative_outputs',
    'requested_width BETWEEN 16 AND 16384',
    'quality BETWEEN 1 AND 100',
    'attempt_count BETWEEN 0 AND 3',
    'FOR EACH ROW EXECUTE FUNCTION public.z_s_image_derivative_job_guard()',
    'storage_object_copies_image_derivative_job_idx',
  ]) assert.match(up, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(up, /INSERT INTO public\.storage_image_derivative_jobs[\s\S]*VALUES/);
  assert.match(down, /rollback blocked: adopted image derivative rows exist/);
});
