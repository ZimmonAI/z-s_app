import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PostgresClientStorageConfigurationStore } from '../src/client-storage-configuration-postgres.js';
import { PostgresImageDerivativeStore } from '../src/image-derivative-postgres.js';
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

interface AuthorityRow {
  client_id: string;
  version_id: string;
  route_id: string;
  route_target_id: string;
  vault_id: string;
  provider_connection_id: string;
  target_role: 'primary' | 'replica';
  target_order: number;
}

async function insertVerifiedObject(
  pool: Pool,
  authority: AuthorityRow,
  contentType: string,
  fingerprint: string,
): Promise<string> {
  const objectId = randomUUID();
  const copyId = randomUUID();
  const now = new Date('2026-08-03T08:00:00.000Z');
  await pool.query(
    `INSERT INTO public.storage_objects (
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
       updated_at,
       row_version
     ) VALUES (
       $1, NULL, NULL, NULL, NULL, $2, $3, $4, $5,
       $6, $7, 'active', 'upload-completion-recorded', $8, 128, $9,
       $8, 128, '{}'::jsonb, $10, $10, $10, 1
     )`,
    [
      objectId,
      authority.client_id,
      authority.version_id,
      fingerprint,
      authority.route_id,
      `test:${objectId}`,
      `fixture:${objectId}`,
      'a'.repeat(64),
      contentType,
      now,
    ],
  );
  await pool.query(
    `INSERT INTO public.storage_object_copies (
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
       updated_at,
       row_version
     ) VALUES (
       $1, $2, NULL, NULL, $3, $4, $5, $6, $7, $8,
       'verified', $9, 128, $10, $10, $10, 1
     )`,
    [
      copyId,
      objectId,
      authority.route_target_id,
      authority.vault_id,
      authority.provider_connection_id,
      authority.target_role,
      authority.target_order,
      `fixture/${objectId}`,
      'a'.repeat(64),
      now,
    ],
  );
  return objectId;
}

integrationTest('0011 enqueues only verified configured images and isolates status by client', async () => {
  assert.ok(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    await resetAndApplyThrough0004(pool);
    await apply0005(pool);
    await applyConfigurationCleanupMigrations(pool);
    await pool.query(await readFile('db/migrations/0010_z_s_runtime_configuration_routing.sql', 'utf8'));
    await pool.query(await readFile('db/migrations/0011_z_s_image_derivatives.sql', 'utf8'));
    await seedClients(pool);

    const queryable = adaptPool(pool);
    const configurationStore = new PostgresClientStorageConfigurationStore(queryable);
    const base = configurationDraftDocument();
    const draft = await configurationStore.createDraft('video-maker_app', {
      environment: 'dev',
      ...base,
      imagePresets: base.imagePresets.map((preset) => ({ ...preset, outputFormat: 'png' as const })),
    });
    await configurationStore.activateDraft('video-maker_app', 'dev', draft.id);

    const imageAuthority = (await pool.query<AuthorityRow>(
      `SELECT
         clients.id AS client_id,
         versions.id AS version_id,
         routes.id AS route_id,
         targets.id AS route_target_id,
         targets.vault_id,
         vaults.provider_connection_id,
         targets.target_role,
         targets.target_order
       FROM public.storage_control_clients AS clients
       JOIN public.storage_control_configuration_versions AS versions
         ON versions.storage_control_client_id = clients.id AND versions.state = 'active'
       JOIN public.storage_control_configuration_routes AS routes
         ON routes.configuration_version_id = versions.id AND routes.asset_class = 'image'
       JOIN public.storage_control_configuration_route_targets AS targets
         ON targets.configuration_route_id = routes.id AND targets.target_role = 'primary'
       JOIN public.storage_control_configuration_vaults AS vaults ON vaults.id = targets.vault_id
      WHERE clients.client_id = 'video-maker_app'`,
    )).rows[0];
    assert.ok(imageAuthority);
    const fingerprint = 'b'.repeat(64);
    const imageObjectId = await insertVerifiedObject(
      pool,
      imageAuthority,
      'image/png',
      fingerprint,
    );

    const derivativeStore = new PostgresImageDerivativeStore(queryable);
    assert.equal(await derivativeStore.enqueueVerifiedSource(imageObjectId), 2);
    assert.equal(await derivativeStore.enqueueVerifiedSource(imageObjectId), 0);

    const ownStatus = await derivativeStore.listStatus('video-maker_app', 'dev', 50);
    assert.equal(ownStatus.length, 2);
    assert.ok(ownStatus.every((job) => job.state === 'queued' && job.format === 'png'));
    assert.deepEqual(await derivativeStore.listStatus('other-client', 'dev', 50), []);

    const claims = await Promise.all([
      derivativeStore.claimNext({ workerId: 'worker-a', leaseDurationMs: 60_000, maximumAttempts: 3 }),
      derivativeStore.claimNext({ workerId: 'worker-b', leaseDurationMs: 60_000, maximumAttempts: 3 }),
    ]);
    assert.ok(claims[0]);
    assert.ok(claims[1]);
    assert.notEqual(claims[0]?.id, claims[1]?.id);

    const videoAuthority = (await pool.query<AuthorityRow>(
      `SELECT
         clients.id AS client_id,
         versions.id AS version_id,
         routes.id AS route_id,
         targets.id AS route_target_id,
         targets.vault_id,
         vaults.provider_connection_id,
         targets.target_role,
         targets.target_order
       FROM public.storage_control_clients AS clients
       JOIN public.storage_control_configuration_versions AS versions
         ON versions.storage_control_client_id = clients.id AND versions.state = 'active'
       JOIN public.storage_control_configuration_routes AS routes
         ON routes.configuration_version_id = versions.id AND routes.asset_class = 'video'
       JOIN public.storage_control_configuration_route_targets AS targets
         ON targets.configuration_route_id = routes.id AND targets.target_role = 'primary'
       JOIN public.storage_control_configuration_vaults AS vaults ON vaults.id = targets.vault_id
      WHERE clients.client_id = 'video-maker_app'`,
    )).rows[0];
    assert.ok(videoAuthority);
    const videoObjectId = await insertVerifiedObject(
      pool,
      videoAuthority,
      'video/mp4',
      fingerprint,
    );
    assert.equal(await derivativeStore.enqueueVerifiedSource(videoObjectId), 0);

    await assert.rejects(
      pool.query(
        `UPDATE public.storage_image_derivative_jobs
            SET preset_id = 'mutated', updated_at = now(), row_version = row_version + 1
          WHERE image_derivative_job_id = $1`,
        [claims[0]?.id],
      ),
      /immutable authority changed/,
    );
  } finally {
    await pool.end();
  }
});
