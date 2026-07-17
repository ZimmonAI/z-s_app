import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import {
  ObjectReadGrantError,
  READ_GRANT_TOKEN_PURPOSE,
  createObjectReadGrantTokenService,
  parseObjectReadGrantRequest,
  PostgresObjectReadGrantRegistry,
  sanitizeReadFileName,
  type ObjectReadGrantClaims,
} from '../src/runtime-read-grant.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
} from '../src/runtime-storage-registry-types.js';

const IDS = {
  grant: '00000000-0000-4000-8000-000000000101',
  object: '00000000-0000-4000-8000-000000000102',
} as const;

function claims(overrides: Partial<ObjectReadGrantClaims> = {}): ObjectReadGrantClaims {
  return {
    purpose: READ_GRANT_TOKEN_PURPOSE,
    objectReadGrantId: IDS.grant,
    storageObjectId: IDS.object,
    callerAppId: 'video-maker_app',
    callerServiceId: 'api',
    grantPurpose: 'resource-preview',
    allowedMethods: ['HEAD', 'GET'],
    allowRange: true,
    disposition: 'inline',
    fileName: 'preview.mp4',
    contractVersion: '1.0',
    expiresAt: '2026-07-17T12:05:00.000Z',
    ...overrides,
  };
}

test('read-grant request parser accepts the exact frozen contract', () => {
  const result = parseObjectReadGrantRequest({
    storageObjectId: IDS.object,
    purpose: 'resource-preview',
    allowedMethods: ['GET', 'HEAD'],
    allowRange: true,
    disposition: 'attachment',
    fileName: 'safe file.mp4',
    requestedTtlSeconds: 30,
    businessAuthorizationReference: 'permission-check-01',
  });
  assert.deepEqual(result.allowedMethods, ['HEAD', 'GET']);
  assert.equal(result.fileName, 'safe file.mp4');
  assert.equal(result.requestedTtlSeconds, 30);
});

test('read-grant request parser rejects invalid fields and legacy identity', () => {
  const valid = {
    storageObjectId: IDS.object,
    purpose: 'resource-preview',
    allowedMethods: ['GET'],
    allowRange: false,
    disposition: 'inline',
    requestedTtlSeconds: 300,
    businessAuthorizationReference: 'permission-check-01',
  } as const;
  const invalid: unknown[] = [
    { ...valid, storageObjectId: ['507f1f77', 'bcf86cd7', '99439011'].join('') },
    { ...valid, requestedTtlSeconds: 29 },
    { ...valid, requestedTtlSeconds: 301 },
    { ...valid, allowedMethods: [] },
    { ...valid, allowedMethods: ['GET', 'GET'] },
    { ...valid, allowedMethods: ['POST'] },
    { ...valid, allowRange: 'true' },
    { ...valid, disposition: 'download' },
    { ...valid, purpose: '../unsafe' },
    { ...valid, extra: true },
    { ...valid, fileName: '../secret.mp4' },
    { ...valid, fileName: 'bad\r\nheader.mp4' },
  ];
  for (const value of invalid) {
    assert.throws(() => parseObjectReadGrantRequest(value), ObjectReadGrantError);
  }
  assert.throws(() => sanitizeReadFileName('.hidden'), ObjectReadGrantError);
});

test('opaque token is deterministic, bound, expiring, and digest-only persistable', () => {
  const service = createObjectReadGrantTokenService(Buffer.alloc(32, 7));
  const token = service.issue(claims());
  assert.equal(token, service.issue(claims()));
  assert.match(service.digest(token), /^[a-f0-9]{64}$/);
  assert.ok(!token.includes(IDS.object));
  const verified = service.verify(token, {
    objectReadGrantId: IDS.grant,
    storageObjectId: IDS.object,
    callerAppId: 'video-maker_app',
    callerServiceId: 'api',
    method: 'GET',
    rangeRequested: true,
    contractVersion: '1.0',
    now: new Date('2026-07-17T12:00:00.000Z'),
  });
  assert.equal(verified.grantPurpose, 'resource-preview');

  const refusals = [
    () => service.verify(`${token}x`),
    () => service.verify(token, { callerAppId: 'z-x_app' }),
    () => service.verify(token, { storageObjectId: '00000000-0000-4000-8000-000000000199' }),
    () => service.verify(token, { contractVersion: '9.9' as '1.0' }),
    () => service.verify(service.issue(claims({ allowedMethods: ['HEAD'] })), { method: 'GET' }),
    () => service.verify(service.issue(claims({ allowRange: false })), { rangeRequested: true }),
    () => service.verify(token, { now: new Date('2026-07-17T12:05:00.000Z') }),
  ];
  for (const refusal of refusals) assert.throws(refusal, ObjectReadGrantError);
});


const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationTest = databaseUrl === undefined ? test.skip : test;

const DB_IDS = {
  managedApp: '00000000-0000-4000-8000-000000000201',
  hotProvider: '00000000-0000-4000-8000-000000000202',
  canonicalProvider: '00000000-0000-4000-8000-000000000203',
  profile: '00000000-0000-4000-8000-000000000204',
  hotBinding: '00000000-0000-4000-8000-000000000205',
  canonicalBinding: '00000000-0000-4000-8000-000000000206',
  prefixClass: '00000000-0000-4000-8000-000000000207',
  object: '00000000-0000-4000-8000-000000000208',
  hotCopy: '00000000-0000-4000-8000-000000000209',
  canonicalCopy: '00000000-0000-4000-8000-000000000210',
} as const;

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

async function migrationSql(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

async function resetAndMigrate(pool: Pool, includeReadDelivery = true): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await pool.query(await migrationSql('db/migrations/0001_z_s_control_plane_foundation.sql'));
  await pool.query(await migrationSql('db/migrations/0002_z_s_runtime_registry.sql'));
  if (includeReadDelivery) {
    await pool.query(await migrationSql('db/migrations/0003_z_s_read_delivery.sql'));
  }
}

async function seedReadableObject(pool: Pool): Promise<void> {
  const createdAt = new Date('2026-07-17T10:00:00.000Z');
  const checksum = 'a'.repeat(64);
  await pool.query(
    `INSERT INTO public.managed_apps (id, app_id, environment, status, created_at, updated_at)
     VALUES ($1, 'video-maker_app', 'dev', 'active', $2, $2)`,
    [DB_IDS.managedApp, createdAt],
  );
  await pool.query(
    `INSERT INTO public.storage_providers
       (id, provider_id, provider_type, status, secret_reference_id, created_at, updated_at)
     VALUES
       ($1, 'hot-r2', 'r2', 'active', 'secret-ref-hot', $3, $3),
       ($2, 'canonical-minio', 'minio', 'active', 'secret-ref-canonical', $3, $3)`,
    [DB_IDS.hotProvider, DB_IDS.canonicalProvider, createdAt],
  );
  await pool.query(
    `INSERT INTO public.storage_profiles
       (id, managed_app_id, profile_id, version, status, effective_at, created_at, updated_at)
     VALUES ($1, $2, 'video-maker-dev-default', 1, 'active', $3, $3, $3)`,
    [DB_IDS.profile, DB_IDS.managedApp, createdAt],
  );
  await pool.query(
    `INSERT INTO public.storage_profile_provider_bindings
       (id, storage_profile_id, provider_role, storage_provider_id, bucket_label, required,
        created_at, updated_at)
     VALUES
       ($1, $3, 'hot', $4, 'hot-dev', true, $6, $6),
       ($2, $3, 'canonical', $5, 'canonical-dev', true, $6, $6)`,
    [
      DB_IDS.hotBinding,
      DB_IDS.canonicalBinding,
      DB_IDS.profile,
      DB_IDS.hotProvider,
      DB_IDS.canonicalProvider,
      createdAt,
    ],
  );
  await pool.query(
    `INSERT INTO public.storage_prefix_classes
       (id, storage_profile_id, prefix_class_id, operation_class, normalized_prefix_pattern,
        status, created_at, updated_at)
     VALUES ($1, $2, 'generated-assets', 'generated-asset', 'generated/*', 'active', $3, $3)`,
    [DB_IDS.prefixClass, DB_IDS.profile, createdAt],
  );
  await pool.query(
    `INSERT INTO public.storage_objects
       (storage_object_id, managed_app_id, storage_profile_id, storage_profile_fingerprint,
        storage_prefix_class_id, app_correlation_ref, source_reference, registry_state,
        object_protection_stage, expected_checksum_sha256, expected_byte_length,
        expected_content_type, verified_checksum_sha256, verified_byte_length,
        safe_technical_metadata, activated_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'profile-fingerprint-v1', $4, 'resource-01', 'source-01',
             'active', 'canonical-and-hot-verified', $5, 16, 'video/mp4', $5, 16,
             '{}'::jsonb, $6, $6, $6)`,
    [DB_IDS.object, DB_IDS.managedApp, DB_IDS.profile, DB_IDS.prefixClass, checksum, createdAt],
  );
  await pool.query(
    `INSERT INTO public.storage_object_copies
       (storage_object_copy_id, storage_object_id, storage_profile_provider_binding_id,
        provider_role, internal_locator, copy_state, observed_checksum_sha256,
        observed_byte_length, latest_verified_at, created_at, updated_at)
     VALUES
       ($1, $3, $4, 'hot', 'safe/hot/object', 'verified', $6, 16, $7, $7, $7),
       ($2, $3, $5, 'canonical', 'safe/canonical/object', 'verified', $6, 16, $7, $7, $7)`,
    [
      DB_IDS.hotCopy,
      DB_IDS.canonicalCopy,
      DB_IDS.object,
      DB_IDS.hotBinding,
      DB_IDS.canonicalBinding,
      checksum,
      createdAt,
    ],
  );
}

integrationTest('0003 applies on exact 0001+0002, documents the catalog, refuses reapply, and rolls back to 14 tables', async () => {
  const { Pool: PgPool } = await import('pg');
  const pool = new PgPool({ connectionString: databaseUrl, max: 4 });
  try {
    await resetAndMigrate(pool);
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    assert.equal(tables.rows.length, 15);
    assert.ok(tables.rows.some((row) => row.table_name === 'object_read_grants'));

    const expectedColumns = [
      'object_read_grant_id', 'storage_object_id', 'managed_app_id', 'caller_service_id',
      'app_correlation_ref', 'business_authorization_ref', 'purpose', 'allowed_methods',
      'range_allowed', 'disposition', 'safe_file_name', 'read_grant_token_digest',
      'token_purpose', 'state', 'expires_at', 'revoked_at', 'created_at', 'updated_at',
      'row_version',
    ];
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'object_read_grants'
        ORDER BY ordinal_position`,
    );
    assert.deepEqual(columns.rows.map((row) => row.column_name), expectedColumns);

    const catalog = await pool.query<{
      table_comment: string;
      owner_name: string;
      baseline_owner: string;
      uncommented_columns: string;
    }>(
      `SELECT obj_description(grant_table.oid, 'pg_class') AS table_comment,
              pg_get_userbyid(grant_table.relowner) AS owner_name,
              pg_get_userbyid(baseline_table.relowner) AS baseline_owner,
              (SELECT count(*)::text
                 FROM pg_attribute AS attribute
                WHERE attribute.attrelid = grant_table.oid
                  AND attribute.attnum > 0
                  AND NOT attribute.attisdropped
                  AND COALESCE(col_description(grant_table.oid, attribute.attnum), '')
                      NOT LIKE '%02b-07-package-read-grant-delivery-fallback-and-range.md%')
                AS uncommented_columns
         FROM pg_class AS grant_table
         JOIN pg_namespace AS namespace ON namespace.oid = grant_table.relnamespace
         JOIN pg_class AS baseline_table ON baseline_table.relname = 'storage_objects'
        WHERE namespace.nspname = 'public' AND grant_table.relname = 'object_read_grants'`,
    );
    assert.match(catalog.rows[0]?.table_comment ?? '', /02b-07-package-read-grant-delivery-fallback-and-range\.md/);
    assert.equal(catalog.rows[0]?.owner_name, catalog.rows[0]?.baseline_owner);
    assert.equal(catalog.rows[0]?.uncommented_columns, '0');

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'object_read_grants'`,
    );
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));
    for (const name of [
      'object_read_grants_object_created_idx',
      'object_read_grants_caller_state_expiry_idx',
      'object_read_grants_state_expiry_idx',
    ]) assert.ok(indexNames.has(name));

    const prohibited = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'object_read_grants'
          AND column_name = ANY($1::text[])`,
      [[
        'read_grant_token', 'delivery_token', 'provider_id', 'provider_alias', 'bucket',
        'endpoint', 'internal_locator', 'object_key', 'credential_reference_id', 'signed_url',
      ]],
    );
    assert.deepEqual(prohibited.rows, []);

    const constraints = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(constraint_record.oid) AS definition
         FROM pg_constraint AS constraint_record
         JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
        WHERE relation.relname = 'object_read_grants'`,
    );
    const constraintText = constraints.rows.map((row) => row.definition).join('\n');
    assert.match(constraintText, /HEAD/);
    assert.match(constraintText, /GET/);
    assert.match(constraintText, /z-s-object-read-grant-v1/);
    assert.match(constraintText, /revoked/);
    assert.match(constraintText, /expired/);

    const reapply = await pool.connect();
    try {
      await assert.rejects(
        reapply.query(await migrationSql('db/migrations/0003_z_s_read_delivery.sql')),
        /2B-07 migration already applied/,
      );
      await reapply.query('ROLLBACK');
    } finally {
      reapply.release();
    }

    await pool.query(await migrationSql('db/migrations/0003_z_s_read_delivery.down.sql'));
    const afterRollback = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    assert.equal(afterRollback.rows[0]?.count, '14');
  } finally {
    await pool.end();
  }
});

integrationTest('PostgreSQL issuance is concurrent-safe and revoke, expiry, attempts, and events remain deterministic', async () => {
  const { Pool: PgPool } = await import('pg');
  const pool = new PgPool({ connectionString: databaseUrl, max: 24 });
  try {
    await resetAndMigrate(pool);
    await seedReadableObject(pool);
    const clock = { value: new Date('2026-07-17T10:01:00.000Z') };
    const registry = new PostgresObjectReadGrantRegistry({
      pool: adaptPool(pool),
      now: () => new Date(clock.value),
    });
    const request = parseObjectReadGrantRequest({
      storageObjectId: DB_IDS.object,
      purpose: 'resource-preview',
      allowedMethods: ['HEAD', 'GET'],
      allowRange: true,
      disposition: 'inline',
      fileName: 'preview.mp4',
      requestedTtlSeconds: 60,
      businessAuthorizationReference: 'permission-check-01',
    });
    const tokenService = createObjectReadGrantTokenService(Buffer.alloc(32, 8));
    const issue = () => {
      const proposedGrantId = randomUUID();
      const expiresAt = new Date(clock.value.getTime() + 60_000);
      const token = tokenService.issue({
        purpose: READ_GRANT_TOKEN_PURPOSE,
        objectReadGrantId: proposedGrantId,
        storageObjectId: DB_IDS.object,
        callerAppId: 'video-maker_app',
        callerServiceId: 'api',
        grantPurpose: request.purpose,
        allowedMethods: request.allowedMethods,
        allowRange: request.allowRange,
        disposition: request.disposition,
        ...(request.fileName === undefined ? {} : { fileName: request.fileName }),
        contractVersion: '1.0',
        expiresAt: expiresAt.toISOString(),
      });
      return registry.issue({
        caller: Object.freeze({ appId: 'video-maker_app', serviceId: 'api' }),
        contractVersion: '1.0',
        appCorrelationReference: 'resource-01',
        duplicateProtectionKey: 'read-grant-01',
        requestFingerprint: createHash('sha256').update('read-grant-request').digest('hex'),
        request,
        proposedGrantId,
        proposedExpiresAt: expiresAt,
        proposedTokenDigest: tokenService.digest(token),
      });
    };

    const issued = await Promise.all(Array.from({ length: 20 }, issue));
    assert.equal(new Set(issued.map((entry) => entry.grant.objectReadGrantId)).size, 1);
    assert.equal(issued.filter((entry) => entry.replayed).length, 19);
    const counts = await pool.query<{ grants: string; idempotency: string }>(
      `SELECT (SELECT count(*) FROM public.object_read_grants)::text AS grants,
              (SELECT count(*) FROM public.storage_idempotency_records
                WHERE operation_scope = 'object-read-grant-issue')::text AS idempotency`,
    );
    assert.deepEqual(counts.rows[0], { grants: '1', idempotency: '1' });

    const grant = issued[0]?.grant;
    assert.ok(grant !== undefined);
    const object = await registry.resolveObjectForRead({
      storageObjectId: grant.storageObjectId,
      managedAppId: grant.managedAppId,
    });
    assert.ok(object !== null);
    assert.equal(object.targets.hot?.providerRole, 'hot');
    assert.equal(object.targets.canonical?.providerRole, 'canonical');

    const attemptId = await registry.beginReadAttempt({
      grant,
      target: object.targets.hot!,
      requestId: '00000000-0000-4000-8000-000000000299',
      method: 'GET',
      rangeRequested: false,
      attemptNumber: 1,
      expectedChecksumSha256: object.verifiedChecksumSha256,
      expectedByteLength: object.verifiedByteLength,
    });
    await registry.completeReadAttempt({
      providerAttemptId: attemptId,
      succeeded: true,
      observedChecksumSha256: object.verifiedChecksumSha256,
      observedByteLength: object.verifiedByteLength,
    });
    await registry.appendReadEvent({
      dedupeKey: `read-delivery:${grant.objectReadGrantId}:test`,
      eventType: 'object-read.delivered',
      grant,
      occurredAt: clock.value,
      payload: Object.freeze({ objectReadGrantId: grant.objectReadGrantId, outcome: 'succeeded' }),
    });
    const history = await pool.query<{ attempts: string; events: string }>(
      `SELECT (SELECT count(*) FROM public.storage_provider_attempts
                WHERE operation = 'read')::text AS attempts,
              (SELECT count(*) FROM public.storage_operation_events
                WHERE event_type LIKE 'object-read%')::text AS events`,
    );
    assert.equal(history.rows[0]?.attempts, '1');
    assert.ok(Number(history.rows[0]?.events ?? '0') >= 2);

    const revoke = () => registry.revoke({
      caller: Object.freeze({ appId: 'video-maker_app', serviceId: 'api' }),
      contractVersion: '1.0',
      appCorrelationReference: 'resource-01',
      duplicateProtectionKey: 'read-revoke-01',
      requestFingerprint: createHash('sha256').update('read-revoke-request').digest('hex'),
      objectReadGrantId: grant.objectReadGrantId,
    });
    const revoked = await Promise.all(Array.from({ length: 10 }, revoke));
    assert.equal(revoked.filter((entry) => entry.replayed).length, 9);
    assert.ok(revoked.every((entry) => entry.grant.state === 'revoked'));
    const rowVersion = await pool.query<{ row_version: number }>(
      `SELECT row_version FROM public.object_read_grants WHERE object_read_grant_id = $1`,
      [grant.objectReadGrantId],
    );
    assert.equal(rowVersion.rows[0]?.row_version, 2);

    const second = await registry.issue({
      caller: Object.freeze({ appId: 'video-maker_app', serviceId: 'api' }),
      contractVersion: '1.0',
      appCorrelationReference: 'resource-02',
      duplicateProtectionKey: 'read-grant-02',
      requestFingerprint: createHash('sha256').update('read-grant-request-02').digest('hex'),
      request,
      proposedGrantId: randomUUID(),
      proposedExpiresAt: new Date(clock.value.getTime() + 30_000),
      proposedTokenDigest: 'b'.repeat(64),
    });
    clock.value = new Date('2026-07-17T10:02:00.000Z');
    const expired = await registry.getForDelivery({
      objectReadGrantId: second.grant.objectReadGrantId,
      storageObjectId: second.grant.storageObjectId,
      caller: Object.freeze({ appId: 'video-maker_app', serviceId: 'api' }),
      now: clock.value,
    });
    assert.equal(expired?.state, 'expired');
    const expiredAgain = await registry.getForDelivery({
      objectReadGrantId: second.grant.objectReadGrantId,
      storageObjectId: second.grant.storageObjectId,
      caller: Object.freeze({ appId: 'video-maker_app', serviceId: 'api' }),
      now: clock.value,
    });
    assert.equal(expiredAgain?.rowVersion, expired?.rowVersion);
  } finally {
    await pool.end();
  }
});
