import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PostgresClientStorageConfigurationStore } from '../src/client-storage-configuration-postgres.js';
import { ImageDerivativeError, type ImageDerivativeJob } from '../src/image-derivative.js';
import {
  IMAGE_DERIVATIVE_FINAL_LEASE_EXPIRY_CODE,
  PostgresImageDerivativeStore,
} from '../src/image-derivative-postgres-recovery.js';
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

interface RecoveryRow {
  image_derivative_job_id: string;
  state: ImageDerivativeJob['state'];
  attempt_count: number;
  maximum_attempts: number;
  next_retry_at: Date | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  safe_diagnostic_category: string | null;
  safe_diagnostic_code: string | null;
  finished_at: Date | null;
  row_version: number;
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

async function configureImageAuthority(pool: Pool): Promise<Readonly<{
  authority: AuthorityRow;
  fingerprint: string;
}>> {
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

  const authority = (await pool.query<AuthorityRow>(
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
  assert.ok(authority);
  return Object.freeze({ authority, fingerprint: 'b'.repeat(64) });
}

integrationTest('0011 enqueues only verified configured images and isolates status by client', async () => {
  assert.ok(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const { authority: imageAuthority, fingerprint } = await configureImageAuthority(pool);
    const imageObjectId = await insertVerifiedObject(
      pool,
      imageAuthority,
      'image/png',
      fingerprint,
    );

    const derivativeStore = new PostgresImageDerivativeStore(adaptPool(pool));
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

integrationTest('expired final leases terminalize atomically while lower attempts reclaim and valid leases remain authoritative', async () => {
  assert.ok(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  let current = new Date('2026-08-03T08:00:00.000Z');
  try {
    const { authority, fingerprint } = await configureImageAuthority(pool);
    const sourceIds = await Promise.all([
      insertVerifiedObject(pool, authority, 'image/png', fingerprint),
      insertVerifiedObject(pool, authority, 'image/png', fingerprint),
      insertVerifiedObject(pool, authority, 'image/png', fingerprint),
    ]);
    const store = new PostgresImageDerivativeStore(
      adaptPool(pool),
      randomUUID,
      () => current,
    );
    for (const sourceId of sourceIds) {
      assert.equal(await store.enqueueVerifiedSource(sourceId, current), 2);
    }

    const claims: Readonly<ImageDerivativeJob>[] = [];
    for (let index = 0; index < 6; index += 1) {
      const job = await store.claimNext({
        workerId: `fixture-worker-${index}`,
        leaseDurationMs: 60_000,
        maximumAttempts: 3,
        now: current,
      });
      assert.ok(job);
      claims.push(job);
    }
    const bySource = new Map<string, Readonly<ImageDerivativeJob>[]>();
    for (const claim of claims) {
      const existing = bySource.get(claim.sourceStorageObjectId) ?? [];
      existing.push(claim);
      bySource.set(claim.sourceStorageObjectId, existing);
    }
    const [expiredFinal, succeeded] = bySource.get(sourceIds[0] ?? '') ?? [];
    const [futureFinal, terminalFailed] = bySource.get(sourceIds[1] ?? '') ?? [];
    const [expiredBelowMaximum, nonExpired] = bySource.get(sourceIds[2] ?? '') ?? [];
    assert.ok(expiredFinal);
    assert.ok(succeeded);
    assert.ok(futureFinal);
    assert.ok(terminalFailed);
    assert.ok(expiredBelowMaximum);
    assert.ok(nonExpired);

    await pool.query(
      `UPDATE public.storage_image_derivative_jobs
          SET attempt_count = maximum_attempts,
              lease_expires_at = $2,
              updated_at = $3,
              row_version = row_version + 1
        WHERE image_derivative_job_id = $1`,
      [
        expiredFinal.id,
        new Date('2026-08-03T08:00:30.000Z'),
        new Date('2026-08-03T08:00:20.000Z'),
      ],
    );
    await pool.query(
      `UPDATE public.storage_image_derivative_jobs
          SET state = 'succeeded',
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              finished_at = $2,
              updated_at = $2,
              row_version = row_version + 1
        WHERE image_derivative_job_id = $1`,
      [succeeded.id, new Date('2026-08-03T08:00:20.000Z')],
    );
    await pool.query(
      `UPDATE public.storage_image_derivative_jobs
          SET attempt_count = maximum_attempts,
              lease_expires_at = $2,
              updated_at = $3,
              row_version = row_version + 1
        WHERE image_derivative_job_id = $1`,
      [
        futureFinal.id,
        new Date('2026-08-03T08:30:00.000Z'),
        new Date('2026-08-03T08:00:20.000Z'),
      ],
    );
    current = new Date('2026-08-03T08:00:10.000Z');
    await store.fail({
      job: terminalFailed,
      category: 'invalid-request',
      code: 'fixture-terminal-failure',
      retryable: false,
      retryDelayMs: 60_000,
      now: current,
    });
    await pool.query(
      `UPDATE public.storage_image_derivative_jobs
          SET lease_expires_at = $2,
              updated_at = $3,
              row_version = row_version + 1
        WHERE image_derivative_job_id = $1`,
      [
        expiredBelowMaximum.id,
        new Date('2026-08-03T08:00:30.000Z'),
        new Date('2026-08-03T08:00:20.000Z'),
      ],
    );
    await pool.query(
      `UPDATE public.storage_image_derivative_jobs
          SET lease_expires_at = $2,
              updated_at = $3,
              row_version = row_version + 1
        WHERE image_derivative_job_id = $1`,
      [
        nonExpired.id,
        new Date('2026-08-03T08:30:00.000Z'),
        new Date('2026-08-03T08:00:20.000Z'),
      ],
    );

    current = new Date('2026-08-03T08:05:00.000Z');
    const concurrentClaims = await Promise.all([
      store.claimNext({
        workerId: 'recovery-a',
        leaseDurationMs: 60_000,
        maximumAttempts: 3,
        now: current,
      }),
      store.claimNext({
        workerId: 'recovery-b',
        leaseDurationMs: 60_000,
        maximumAttempts: 3,
        now: current,
      }),
    ]);
    const reclaimed = concurrentClaims.filter(
      (value): value is Readonly<ImageDerivativeJob> => value !== null,
    );
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0]?.id, expiredBelowMaximum.id);
    assert.equal(reclaimed[0]?.attemptCount, 2);

    const rows = (await pool.query<RecoveryRow>(
      `SELECT image_derivative_job_id, state, attempt_count, maximum_attempts,
              next_retry_at, lease_owner, lease_token, lease_expires_at,
              safe_diagnostic_category, safe_diagnostic_code, finished_at, row_version
         FROM public.storage_image_derivative_jobs
        WHERE image_derivative_job_id = ANY($1::uuid[])`,
      [claims.map((claim) => claim.id)],
    )).rows;
    const rowById = new Map(rows.map((row) => [row.image_derivative_job_id, row]));

    const expiredFinalRow = rowById.get(expiredFinal.id);
    assert.ok(expiredFinalRow);
    assert.equal(expiredFinalRow.state, 'failed');
    assert.equal(expiredFinalRow.attempt_count, 3);
    assert.equal(expiredFinalRow.maximum_attempts, 3);
    assert.equal(expiredFinalRow.next_retry_at, null);
    assert.equal(expiredFinalRow.lease_owner, null);
    assert.equal(expiredFinalRow.lease_token, null);
    assert.equal(expiredFinalRow.lease_expires_at, null);
    assert.equal(expiredFinalRow.safe_diagnostic_category, 'dependency-unavailable');
    assert.equal(expiredFinalRow.safe_diagnostic_code, IMAGE_DERIVATIVE_FINAL_LEASE_EXPIRY_CODE);
    assert.ok(expiredFinalRow.finished_at);
    assert.equal(expiredFinalRow.row_version, 4, 'concurrent finalizers must update once');

    const futureFinalRow = rowById.get(futureFinal.id);
    assert.ok(futureFinalRow);
    assert.equal(futureFinalRow.state, 'processing');
    assert.equal(futureFinalRow.attempt_count, 3);
    assert.equal(futureFinalRow.lease_token, futureFinal.leaseToken);

    const nonExpiredRow = rowById.get(nonExpired.id);
    assert.ok(nonExpiredRow);
    assert.equal(nonExpiredRow.state, 'processing');
    assert.equal(nonExpiredRow.attempt_count, 1);
    assert.equal(nonExpiredRow.lease_token, nonExpired.leaseToken);

    const succeededRow = rowById.get(succeeded.id);
    assert.ok(succeededRow);
    assert.equal(succeededRow.state, 'succeeded');
    assert.equal(succeededRow.safe_diagnostic_code, null);

    const terminalFailedRow = rowById.get(terminalFailed.id);
    assert.ok(terminalFailedRow);
    assert.equal(terminalFailedRow.state, 'failed');
    assert.equal(terminalFailedRow.safe_diagnostic_code, 'fixture-terminal-failure');

    const retryableTimeoutJob = reclaimed[0];
    assert.ok(retryableTimeoutJob);
    await store.fail({
      job: retryableTimeoutJob,
      category: 'dependency-unavailable',
      code: 'image-derivative-source-read-timeout',
      retryable: true,
      retryDelayMs: 60_000,
      now: current,
    });
    const retryableTimeoutRow = (await pool.query<RecoveryRow>(
      `SELECT image_derivative_job_id, state, attempt_count, maximum_attempts,
              next_retry_at, lease_owner, lease_token, lease_expires_at,
              safe_diagnostic_category, safe_diagnostic_code, finished_at, row_version
         FROM public.storage_image_derivative_jobs
        WHERE image_derivative_job_id = $1`,
      [retryableTimeoutJob.id],
    )).rows[0];
    assert.ok(retryableTimeoutRow);
    assert.equal(retryableTimeoutRow.state, 'failed');
    assert.equal(retryableTimeoutRow.attempt_count, 2);
    assert.equal(retryableTimeoutRow.safe_diagnostic_code, 'image-derivative-source-read-timeout');
    assert.equal(retryableTimeoutRow.finished_at, null);
    assert.equal(
      retryableTimeoutRow.next_retry_at?.toISOString(),
      '2026-08-03T08:06:00.000Z',
    );

    current = new Date('2026-08-03T08:06:01.000Z');
    const finalTimeoutJob = await store.claimNext({
      workerId: 'timeout-final-attempt',
      leaseDurationMs: 60_000,
      maximumAttempts: 3,
      now: current,
    });
    assert.ok(finalTimeoutJob);
    assert.equal(finalTimeoutJob.id, retryableTimeoutJob.id);
    assert.equal(finalTimeoutJob.attemptCount, 3);
    await store.fail({
      job: finalTimeoutJob,
      category: 'dependency-unavailable',
      code: 'image-derivative-source-read-timeout',
      retryable: true,
      retryDelayMs: 60_000,
      now: current,
    });
    const finalTimeoutRow = (await pool.query<RecoveryRow>(
      `SELECT image_derivative_job_id, state, attempt_count, maximum_attempts,
              next_retry_at, lease_owner, lease_token, lease_expires_at,
              safe_diagnostic_category, safe_diagnostic_code, finished_at, row_version
         FROM public.storage_image_derivative_jobs
        WHERE image_derivative_job_id = $1`,
      [finalTimeoutJob.id],
    )).rows[0];
    assert.ok(finalTimeoutRow);
    assert.equal(finalTimeoutRow.state, 'failed');
    assert.equal(finalTimeoutRow.attempt_count, 3);
    assert.equal(finalTimeoutRow.next_retry_at, null);
    assert.ok(finalTimeoutRow.finished_at);
    assert.equal(finalTimeoutRow.safe_diagnostic_code, 'image-derivative-source-read-timeout');

    await assert.rejects(
      store.fail({
        job: expiredFinal,
        category: 'internal',
        code: 'fixture-stale-failure',
        retryable: false,
        retryDelayMs: 60_000,
        now: current,
      }),
      (error: unknown) => error instanceof ImageDerivativeError &&
        error.code === 'image-derivative-lease-lost',
    );
    await assert.rejects(
      store.complete(expiredFinal, {
        storageObjectId: randomUUID(),
        byteLength: 1,
        checksumSha256: 'c'.repeat(64),
      }, current),
      (error: unknown) => error instanceof ImageDerivativeError &&
        error.code === 'image-derivative-lease-lost',
    );
    await assert.rejects(
      store.reserveOutput(expiredFinal, {
        mediaType: 'image/png',
        byteLength: 1,
        checksumSha256: 'c'.repeat(64),
      }, current),
      (error: unknown) => error instanceof ImageDerivativeError &&
        error.code === 'image-derivative-lease-lost',
    );

    const lineage = await pool.query(
      `SELECT 1
         FROM public.storage_image_derivative_outputs
        WHERE image_derivative_job_id = $1`,
      [expiredFinal.id],
    );
    assert.equal(lineage.rowCount, 0);
    const derivativeObjects = await pool.query(
      `SELECT 1
         FROM public.storage_objects
        WHERE image_derivative_job_id = $1`,
      [expiredFinal.id],
    );
    assert.equal(derivativeObjects.rowCount, 0);
  } finally {
    await pool.end();
  }
});
