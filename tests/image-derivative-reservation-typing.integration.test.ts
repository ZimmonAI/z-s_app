import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';

import { PostgresClientStorageConfigurationStore } from '../src/client-storage-configuration-postgres.js';
import {
  ImageDerivativeError,
  type ImageDerivativeJob,
} from '../src/image-derivative.js';
import {
  PostgresImageDerivativeStore as BasePostgresImageDerivativeStore,
} from '../src/image-derivative-postgres.js';
import {
  PostgresImageDerivativeStore as RecoveryPostgresImageDerivativeStore,
} from '../src/image-derivative-postgres-recovery.js';
import {
  adaptPool,
  apply0005,
  applyConfigurationCleanupMigrations,
  configurationDraftDocument,
  databaseUrl,
  resetAndApplyThrough0004,
  seedClients,
} from './client-storage-configuration-integration-helpers.js';

const integrationTest = databaseUrl === undefined ? test.skip : test;

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

interface ReservationStore {
  enqueueVerifiedSource(
    storageObjectId: string,
    now?: Date,
  ): Promise<number>;

  claimNext(input: Readonly<{
    workerId: string;
    leaseDurationMs: number;
    maximumAttempts: number;
    now?: Date;
  }>): Promise<Readonly<ImageDerivativeJob> | null>;

  reserveOutput(
    job: Readonly<ImageDerivativeJob>,
    output: Readonly<{
      mediaType: string;
      byteLength: number;
      checksumSha256: string;
    }>,
    now?: Date,
  ): Promise<Readonly<{
    storageObjectId: string;
    storageObjectCopyId: string;
  }>>;
}

interface MetadataRow extends Record<string, unknown> {
  safe_technical_metadata: Readonly<{
    derivative_preset_id?: unknown;
    derivative_width?: unknown;
    derivative_format?: unknown;
  }>;
}

interface CountRow extends Record<string, unknown> {
  object_count: number;
  copy_count: number;
}

async function insertVerifiedObject(
  pool: Pool,
  authority: AuthorityRow,
  contentType: string,
  fingerprint: string,
): Promise<string> {
  const objectId = randomUUID();
  const copyId = randomUUID();
  const now = new Date('2026-08-06T12:00:00.000Z');

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

async function configureImageAuthority(
  pool: Pool,
): Promise<Readonly<{
  authority: AuthorityRow;
  fingerprint: string;
}>> {
  await resetAndApplyThrough0004(pool);
  await apply0005(pool);
  await applyConfigurationCleanupMigrations(pool);
  await pool.query(
    await readFile(
      'db/migrations/0010_z_s_runtime_configuration_routing.sql',
      'utf8',
    ),
  );
  await pool.query(
    await readFile(
      'db/migrations/0011_z_s_image_derivatives.sql',
      'utf8',
    ),
  );
  await seedClients(pool);

  const queryable = adaptPool(pool);
  const configurationStore =
    new PostgresClientStorageConfigurationStore(queryable);
  const base = configurationDraftDocument();
  const draft = await configurationStore.createDraft(
    'video-maker_app',
    {
      environment: 'dev',
      ...base,
      imagePresets: base.imagePresets.map((preset) => ({
        ...preset,
        outputFormat: 'png' as const,
      })),
    },
  );

  await configurationStore.activateDraft(
    'video-maker_app',
    'dev',
    draft.id,
  );

  const authority = (
    await pool.query<AuthorityRow>(
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
         ON versions.storage_control_client_id = clients.id
        AND versions.state = 'active'
       JOIN public.storage_control_configuration_routes AS routes
         ON routes.configuration_version_id = versions.id
        AND routes.asset_class = 'image'
       JOIN public.storage_control_configuration_route_targets AS targets
         ON targets.configuration_route_id = routes.id
        AND targets.target_role = 'primary'
       JOIN public.storage_control_configuration_vaults AS vaults
         ON vaults.id = targets.vault_id
       WHERE clients.client_id = 'video-maker_app'`,
    )
  ).rows[0];

  assert.ok(authority);

  return Object.freeze({
    authority,
    fingerprint: 'b'.repeat(64),
  });
}

function storeCases(
  pool: Pool,
  now: Date,
): readonly Readonly<{
  name: string;
  create(): ReservationStore;
}>[] {
  return [
    {
      name: 'base',
      create: () =>
        new BasePostgresImageDerivativeStore(
          adaptPool(pool),
        ),
    },
    {
      name: 'recovery',
      create: () =>
        new RecoveryPostgresImageDerivativeStore(
          adaptPool(pool),
          randomUUID,
          () => now,
        ),
    },
  ];
}

integrationTest(
  'base and recovery reservations preserve typed metadata and replay idempotently',
  async () => {
    assert.ok(databaseUrl);

    const pool = new Pool({
      connectionString: databaseUrl,
      max: 4,
    });

    const now =
      new Date('2026-08-06T12:00:00.000Z');

    try {
      for (const testCase of storeCases(pool, now)) {
        const {
          authority,
          fingerprint,
        } = await configureImageAuthority(pool);

        const sourceId =
          await insertVerifiedObject(
            pool,
            authority,
            'image/png',
            fingerprint,
          );

        const store = testCase.create();

        assert.equal(
          await store.enqueueVerifiedSource(
            sourceId,
            now,
          ),
          2,
        );

        const job = await store.claimNext({
          workerId:
            `h06c-${testCase.name}-reservation`,
          leaseDurationMs: 60_000,
          maximumAttempts: 3,
          now,
        });

        assert.ok(job);

        const output = Object.freeze({
          mediaType: 'image/png',
          byteLength: 120_631,
          checksumSha256: 'c'.repeat(64),
        });

        const first =
          await store.reserveOutput(
            job,
            output,
            now,
          );

        const replay =
          await store.reserveOutput(
            job,
            output,
            now,
          );

        assert.equal(
          replay.storageObjectId,
          first.storageObjectId,
        );
        assert.equal(
          replay.storageObjectCopyId,
          first.storageObjectCopyId,
        );

        const metadataRow = (
          await pool.query<MetadataRow>(
            `SELECT safe_technical_metadata
               FROM public.storage_objects
              WHERE storage_object_id = $1`,
            [first.storageObjectId],
          )
        ).rows[0];

        assert.ok(metadataRow);
        assert.deepEqual(
          metadataRow.safe_technical_metadata,
          {
            derivative_preset_id:
              job.presetId,
            derivative_width:
              job.requestedWidth,
            derivative_format:
              job.outputFormat,
          },
        );
        assert.equal(
          typeof metadataRow
            .safe_technical_metadata
            .derivative_width,
          'number',
        );

        const countRow = (
          await pool.query<CountRow>(
            `SELECT
               (
                 SELECT count(*)::integer
                   FROM public.storage_objects
                  WHERE image_derivative_job_id = $1
               ) AS object_count,
               (
                 SELECT count(*)::integer
                   FROM public.storage_object_copies
                  WHERE image_derivative_job_id = $1
               ) AS copy_count`,
            [job.id],
          )
        ).rows[0];

        assert.ok(countRow);
        assert.equal(countRow.object_count, 1);
        assert.equal(countRow.copy_count, 1);
      }
    } finally {
      await pool.end();
    }
  },
);

integrationTest(
  'base and recovery reservations roll back the object when copy insertion fails',
  async () => {
    assert.ok(databaseUrl);

    const pool = new Pool({
      connectionString: databaseUrl,
      max: 4,
    });

    const now =
      new Date('2026-08-06T12:30:00.000Z');

    try {
      for (const testCase of storeCases(pool, now)) {
        const {
          authority,
          fingerprint,
        } = await configureImageAuthority(pool);

        const sourceId =
          await insertVerifiedObject(
            pool,
            authority,
            'image/png',
            fingerprint,
          );

        const store = testCase.create();

        assert.equal(
          await store.enqueueVerifiedSource(
            sourceId,
            now,
          ),
          2,
        );

        const job = await store.claimNext({
          workerId:
            `h06c-${testCase.name}-atomicity`,
          leaseDurationMs: 60_000,
          maximumAttempts: 3,
          now,
        });

        assert.ok(job);

        await pool.query(`
          CREATE FUNCTION
            public.h06c_reject_derivative_copy()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF NEW.image_derivative_job_id
              IS NOT NULL
            THEN
              RAISE EXCEPTION
                'h06c forced derivative copy failure';
            END IF;

            RETURN NEW;
          END;
          $$;

          CREATE TRIGGER
            h06c_reject_derivative_copy
          BEFORE INSERT
          ON public.storage_object_copies
          FOR EACH ROW
          EXECUTE FUNCTION
            public.h06c_reject_derivative_copy();
        `);

        await assert.rejects(
          store.reserveOutput(
            job,
            {
              mediaType: 'image/png',
              byteLength: 120_631,
              checksumSha256:
                'd'.repeat(64),
            },
            now,
          ),
          (error: unknown) =>
            error instanceof
              ImageDerivativeError &&
            error.category ===
              'dependency-unavailable' &&
            error.code ===
              'image-derivative-output-reservation-unavailable' &&
            error.retryable,
        );

        const countRow = (
          await pool.query<CountRow>(
            `SELECT
               (
                 SELECT count(*)::integer
                   FROM public.storage_objects
                  WHERE image_derivative_job_id = $1
               ) AS object_count,
               (
                 SELECT count(*)::integer
                   FROM public.storage_object_copies
                  WHERE image_derivative_job_id = $1
               ) AS copy_count`,
            [job.id],
          )
        ).rows[0];

        assert.ok(countRow);
        assert.equal(countRow.object_count, 0);
        assert.equal(countRow.copy_count, 0);
      }
    } finally {
      await pool.end();
    }
  },
);
