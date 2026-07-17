import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool, type PoolClient } from 'pg';
import {
  PostgresObjectReadRegistry,
  createDeterministicObjectReadGrantTokenService,
  objectReadGrantTokenDigest,
  type ObjectReadGrantSnapshot,
} from '../src/runtime-read-grant.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
} from '../src/runtime-storage-registry-types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationTest = databaseUrl === undefined ? test.skip : test;
const NOW = new Date('2026-07-17T00:00:00.000Z');
const IDS = {
  managedApp: '00000000-0000-4000-8000-000000000001',
  hotProvider: '00000000-0000-4000-8000-000000000002',
  canonicalProvider: '00000000-0000-4000-8000-000000000003',
  profile: '00000000-0000-4000-8000-000000000004',
  hotBinding: '00000000-0000-4000-8000-000000000005',
  canonicalBinding: '00000000-0000-4000-8000-000000000006',
  prefixClass: '00000000-0000-4000-8000-000000000007',
  object: '00000000-0000-4000-8000-000000000008',
  hotCopy: '00000000-0000-4000-8000-000000000009',
  canonicalCopy: '00000000-0000-4000-8000-000000000010',
  grant: '00000000-0000-4000-8000-000000000011',
} as const;
const CHECKSUM = 'a'.repeat(64);

function adaptClient(client: PoolClient): PostgresClientLike {
  return {
    query: async <Row extends Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) => {
      const result = await client.query<Row>(text, values as unknown[] | undefined);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    release: () => client.release(),
  };
}

function adaptPool(pool: Pool): PostgresPoolLike {
  return { connect: async () => adaptClient(await pool.connect()) };
}

async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await pool.query(await readFile('db/migrations/0001_z_s_control_plane_foundation.sql', 'utf8'));
  await pool.query(await readFile('db/migrations/0002_z_s_runtime_registry.sql', 'utf8'));
}

async function applyReadMigration(pool: Pool): Promise<void> {
  await pool.query(await readFile('db/migrations/0003_z_s_read_delivery.sql', 'utf8'));
}

async function seedReadyObject(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO public.managed_apps (id, app_id, environment, status, created_at, updated_at)
     VALUES ($1, 'video-maker_app', 'dev', 'active', $2, $2)`,
    [IDS.managedApp, NOW],
  );
  await pool.query(
    `INSERT INTO public.storage_providers
       (id, provider_id, provider_type, status, secret_reference_id, created_at, updated_at)
     VALUES
       ($1, 'r2_video_maker_dev_01', 'r2', 'active', 'secret-ref-hot', $3, $3),
       ($2, 'minio_zimspace_local_pc_01', 'minio', 'active', 'secret-ref-canonical', $3, $3)`,
    [IDS.hotProvider, IDS.canonicalProvider, NOW],
  );
  await pool.query(
    `INSERT INTO public.storage_profiles
       (id, managed_app_id, profile_id, version, status, effective_at, created_at, updated_at)
     VALUES ($1, $2, 'video-maker-dev-default', 1, 'active', $3, $3, $3)`,
    [IDS.profile, IDS.managedApp, NOW],
  );
  await pool.query(
    `INSERT INTO public.storage_profile_provider_bindings
       (id, storage_profile_id, provider_role, storage_provider_id, bucket_label, required,
        created_at, updated_at)
     VALUES
       ($1, $3, 'hot', $4, 'video-maker-hot', true, $6, $6),
       ($2, $3, 'canonical', $5, 'zs-dev-app-video-maker-canon', true, $6, $6)`,
    [
      IDS.hotBinding,
      IDS.canonicalBinding,
      IDS.profile,
      IDS.hotProvider,
      IDS.canonicalProvider,
      NOW,
    ],
  );
  await pool.query(
    `INSERT INTO public.storage_prefix_classes
       (id, storage_profile_id, prefix_class_id, operation_class, normalized_prefix_pattern,
        status, created_at, updated_at)
     VALUES ($1, $2, 'user-resources', 'generated-asset',
             'video-maker/user-resources/*', 'active', $3, $3)`,
    [IDS.prefixClass, IDS.profile, NOW],
  );
  await pool.query(
    `INSERT INTO public.storage_objects (
       storage_object_id, managed_app_id, storage_profile_id, storage_profile_fingerprint,
       storage_prefix_class_id, app_correlation_ref, source_reference, registry_state,
       object_protection_stage, expected_checksum_sha256, expected_byte_length,
       expected_content_type, verified_checksum_sha256, verified_byte_length,
       safe_technical_metadata, activated_at, created_at, updated_at
     ) VALUES ($1, $2, $3, 'profile-fingerprint-v1', $4, 'resource-01', 'source-01',
               'active', 'canonical-and-hot-verified', $5, 10, 'video/mp4', $5, 10,
               '{}'::jsonb, $6, $6, $6)`,
    [IDS.object, IDS.managedApp, IDS.profile, IDS.prefixClass, CHECKSUM, NOW],
  );
  await pool.query(
    `INSERT INTO public.storage_object_copies (
       storage_object_copy_id, storage_object_id, storage_profile_provider_binding_id,
       provider_role, internal_locator, copy_state, observed_checksum_sha256,
       observed_byte_length, latest_verified_at, created_at, updated_at
     ) VALUES
       ($1, $3, $4, 'hot', 'video-maker/user-resources/hot/object-01', 'verified',
        $6, 10, $7, $7, $7),
       ($2, $3, $5, 'canonical', 'video-maker/user-resources/canonical/object-01', 'verified',
        $6, 10, $7, $7, $7)`,
    [
      IDS.hotCopy,
      IDS.canonicalCopy,
      IDS.object,
      IDS.hotBinding,
      IDS.canonicalBinding,
      CHECKSUM,
      NOW,
    ],
  );
}

integrationTest('0003 migrates, documents its columns, rejects reapply, and rolls down when empty', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    await resetDatabase(pool);
    await applyReadMigration(pool);
    const table = await pool.query<{ value: string | null }>(
      `SELECT to_regclass('public.object_read_grants')::text AS value`,
    );
    assert.equal(table.rows[0]?.value, 'object_read_grants');
    const missingComments = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM information_schema.columns AS column_info
         JOIN pg_catalog.pg_class AS relation ON relation.relname = column_info.table_name
         JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace AND namespace.nspname = column_info.table_schema
         JOIN pg_catalog.pg_attribute AS attribute
           ON attribute.attrelid = relation.oid AND attribute.attname = column_info.column_name
        WHERE column_info.table_schema = 'public'
          AND column_info.table_name = 'object_read_grants'
          AND COALESCE(col_description(relation.oid, attribute.attnum), '')
              NOT LIKE '%02b-07-package-read-grant-delivery-fallback-and-range.md%'`,
    );
    assert.equal(missingComments.rows[0]?.count, '0');
    const client = await pool.connect();
    try {
      await assert.rejects(
        client.query(await readFile('db/migrations/0003_z_s_read_delivery.sql', 'utf8')),
        /migration already applied/,
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await pool.query(await readFile('db/migrations/0003_z_s_read_delivery.down.sql', 'utf8'));
    const after = await pool.query<{ value: string | null }>(
      `SELECT to_regclass('public.object_read_grants')::text AS value`,
    );
    assert.equal(after.rows[0]?.value, null);
  } finally {
    await pool.end();
  }
});

integrationTest('grant issuance is concurrent-safe, digest-only, revocable and auditable', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 16 });
  try {
    await resetDatabase(pool);
    await applyReadMigration(pool);
    await seedReadyObject(pool);
    const registry = new PostgresObjectReadRegistry({
      pool: adaptPool(pool),
      now: () => NOW,
      createId: randomUUID,
    });
    const tokenService = createDeterministicObjectReadGrantTokenService({
      signingKey: 'deterministic-read-token-key',
      now: () => NOW,
    });
    const claims = Object.freeze({
      tokenPurpose: 'object-read-grant' as const,
      objectReadGrantId: IDS.grant,
      storageObjectId: IDS.object,
      callerAppId: 'video-maker_app',
      callerServiceId: 'api',
      purpose: 'video-playback',
      allowedMethods: ['HEAD', 'GET'] as const,
      allowRange: true,
      contractVersion: '1.0' as const,
      expiresAt: '2026-07-17T00:02:00.000Z',
    });
    const token = tokenService.issue(claims) as string;
    let operationCalls = 0;
    const execute = () => registry.execute({
      scope: 'video-maker_app:api:object-read-grant',
      key: 'read-grant-01',
      fingerprint: 'b'.repeat(64),
      operation: async (): Promise<Readonly<ObjectReadGrantSnapshot>> => {
        operationCalls += 1;
        return registry.createObjectReadGrant({
          objectReadGrantId: IDS.grant,
          storageObjectId: IDS.object,
          callerAppId: 'video-maker_app',
          callerServiceId: 'api',
          appCorrelationReference: 'resource-01',
          businessAuthorizationReference: 'resource-policy-01',
          purpose: 'video-playback',
          allowedMethods: ['HEAD', 'GET'],
          allowRange: true,
          disposition: 'inline',
          fileName: 'clip.mp4',
          tokenDigest: objectReadGrantTokenDigest(token),
          expiresAt: new Date(claims.expiresAt),
        });
      },
    });
    const results = await Promise.all(Array.from({ length: 10 }, execute));
    assert.equal(operationCalls, 1);
    assert.equal(results.filter((entry) => entry.replayed).length, 9);
    const persisted = await pool.query<{
      read_grant_token_digest: string;
      row_json: string;
    }>(
      `SELECT read_grant_token_digest,
              row_to_json(object_read_grants)::text AS row_json
         FROM public.object_read_grants
        WHERE object_read_grant_id = $1`,
      [IDS.grant],
    );
    assert.equal(persisted.rows[0]?.read_grant_token_digest, objectReadGrantTokenDigest(token));
    assert.equal(persisted.rows[0]?.row_json.includes(token), false);

    const authorized = await registry.getObjectReadGrant({
      objectReadGrantId: IDS.grant,
      storageObjectId: IDS.object,
      callerAppId: 'video-maker_app',
      callerServiceId: 'api',
      tokenDigest: objectReadGrantTokenDigest(token),
    });
    assert.equal(authorized?.state, 'active');
    const delivery = await registry.getObjectReadDeliverySnapshot({
      storageObjectId: IDS.object,
      callerAppId: 'video-maker_app',
      callerServiceId: 'api',
    });
    assert.equal(delivery?.copies.hot.state, 'verified');
    assert.equal(delivery?.copies.canonical.state, 'verified');

    const attempt = await registry.beginObjectReadAttempt({
      storageObjectCopyId: IDS.hotCopy,
      storageObjectId: IDS.object,
      operationReference: 'object-read:request-01',
      expectedChecksumSha256: CHECKSUM,
      expectedByteLength: 10,
    });
    await registry.finishObjectReadAttempt({
      providerAttemptId: attempt.providerAttemptId,
      nextState: 'succeeded',
      observedByteLength: 10,
    });
    const attemptState = await pool.query<{ state: string }>(
      `SELECT state FROM public.storage_provider_attempts
        WHERE storage_provider_attempt_id = $1`,
      [attempt.providerAttemptId],
    );
    assert.equal(attemptState.rows[0]?.state, 'succeeded');

    const revoked = await registry.execute({
      scope: 'video-maker_app:api:object-read-grant-revoke',
      key: 'revoke-01',
      fingerprint: 'c'.repeat(64),
      operation: () => registry.revokeObjectReadGrant({
        objectReadGrantId: IDS.grant,
        callerAppId: 'video-maker_app',
        callerServiceId: 'api',
        appCorrelationReference: 'resource-01',
      }),
    });
    assert.equal(revoked.value.state, 'revoked');
    const blocked = await registry.getObjectReadGrant({
      objectReadGrantId: IDS.grant,
      storageObjectId: IDS.object,
      callerAppId: 'video-maker_app',
      callerServiceId: 'api',
      tokenDigest: objectReadGrantTokenDigest(token),
    });
    assert.equal(blocked?.state, 'revoked');
    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM public.storage_operation_events
        WHERE storage_object_id = $1 ORDER BY event_type`,
      [IDS.object],
    );
    assert.deepEqual(events.rows.map((row) => row.event_type), [
      'object-read-grant-issued',
      'object-read-grant-revoked',
    ]);
    await assert.rejects(
      pool.query(await readFile('db/migrations/0003_z_s_read_delivery.down.sql', 'utf8')),
      /rollback blocked/,
    );
  } finally {
    await pool.end();
  }
});
