import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool, type PoolClient } from 'pg';
import {
  PostgresRuntimeStorageRegistry,
  RuntimeStorageRegistryError,
  type DurableDuplicateResultCodec,
  type PostgresClientLike,
  type PostgresPoolLike,
  type PostgresQueryable,
} from '../src/runtime-storage-registry.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationTest = databaseUrl === undefined ? test.skip : test;

const IDS = {
  managedApp: '00000000-0000-4000-8000-000000000001',
  hotProvider: '00000000-0000-4000-8000-000000000002',
  canonicalProvider: '00000000-0000-4000-8000-000000000003',
  profile: '00000000-0000-4000-8000-000000000004',
  hotBinding: '00000000-0000-4000-8000-000000000005',
  canonicalBinding: '00000000-0000-4000-8000-000000000006',
  prefixClass: '00000000-0000-4000-8000-000000000007',
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

const codec: DurableDuplicateResultCodec = {
  async encode(value: unknown) {
    assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
    const result = value as Record<string, unknown>;
    assert.equal(typeof result.writeIntentId, 'string');
    assert.equal(typeof result.storageObjectId, 'string');
    return {
      resultKind: 'object-write-intent',
      resultReferenceId: result.writeIntentId as string,
      storageObjectId: result.storageObjectId as string,
    };
  },
  async decode(reference, client: PostgresQueryable) {
    const result = await client.query<{
      object_write_intent_id: string;
      storage_object_id: string;
    }>(
      `SELECT object_write_intent_id, storage_object_id
         FROM public.object_write_intents
        WHERE object_write_intent_id = $1 AND storage_object_id = $2`,
      [reference.resultReferenceId, reference.storageObjectId],
    );
    const row = result.rows[0];
    assert.ok(row !== undefined);
    return {
      writeIntentId: row.object_write_intent_id,
      storageObjectId: row.storage_object_id,
    };
  },
};

async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await pool.query(await readFile('db/migrations/0001_z_s_control_plane_foundation.sql', 'utf8'));
}

async function applyRuntimeMigration(pool: Pool): Promise<void> {
  await pool.query(await readFile('db/migrations/0002_z_s_runtime_registry.sql', 'utf8'));
}

async function seedControlPlane(pool: Pool): Promise<void> {
  const now = new Date('2026-07-16T00:00:00.000Z');
  await pool.query(
    `INSERT INTO public.managed_apps (id, app_id, environment, status, created_at, updated_at)
     VALUES ($1, 'video-maker_app', 'dev', 'active', $2, $2)`,
    [IDS.managedApp, now],
  );
  await pool.query(
    `INSERT INTO public.storage_providers
       (id, provider_id, provider_type, status, secret_reference_id, created_at, updated_at)
     VALUES
       ($1, 'hot-r2', 'r2', 'active', 'secret-ref-hot', $3, $3),
       ($2, 'canonical-minio', 'minio', 'active', 'secret-ref-canonical', $3, $3)`,
    [IDS.hotProvider, IDS.canonicalProvider, now],
  );
  await pool.query(
    `INSERT INTO public.storage_profiles
       (id, managed_app_id, profile_id, version, status, effective_at, created_at, updated_at)
     VALUES ($1, $2, 'video-maker-dev-default', 1, 'active', $3, $3, $3)`,
    [IDS.profile, IDS.managedApp, now],
  );
  await pool.query(
    `INSERT INTO public.storage_profile_provider_bindings
       (id, storage_profile_id, provider_role, storage_provider_id, bucket_label, required,
        created_at, updated_at)
     VALUES
       ($1, $3, 'hot', $4, 'hot-dev', true, $6, $6),
       ($2, $3, 'canonical', $5, 'canonical-dev', true, $6, $6)`,
    [
      IDS.hotBinding,
      IDS.canonicalBinding,
      IDS.profile,
      IDS.hotProvider,
      IDS.canonicalProvider,
      now,
    ],
  );
  await pool.query(
    `INSERT INTO public.storage_prefix_classes
       (id, storage_profile_id, prefix_class_id, operation_class, normalized_prefix_pattern,
        status, created_at, updated_at)
     VALUES ($1, $2, 'generated-assets', 'generated-asset', 'generated/*', 'active', $3, $3)`,
    [IDS.prefixClass, IDS.profile, now],
  );
}

function createIntentInput() {
  return {
    managedAppId: IDS.managedApp,
    callerServiceId: 'api',
    storageProfileId: IDS.profile,
    storageProfileFingerprint: 'profile-fingerprint-v1',
    storagePrefixClassId: IDS.prefixClass,
    hotProviderBindingId: IDS.hotBinding,
    canonicalProviderBindingId: IDS.canonicalBinding,
    appCorrelationReference: 'resource-01',
    sourceReference: 'pending-resource-01',
    expectedContentType: 'image/png',
    expectedByteLength: 1024,
    expectedChecksumSha256: 'a'.repeat(64),
    expiresAt: new Date('2026-07-16T01:00:00.000Z'),
    internalLocators: {
      hot: `generated/${randomUUID()}`,
      canonical: `generated/${randomUUID()}`,
    },
    safeTechnicalMetadata: { media_family: 'image' },
  } as const;
}

integrationTest('0002 migrates up, documents all runtime columns, rejects reapply, and rolls down cleanly', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    await resetDatabase(pool);
    await applyRuntimeMigration(pool);

    const tableResult = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    assert.equal(tableResult.rows.length, 14);

    const missingComments = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM information_schema.columns AS column_info
         LEFT JOIN pg_catalog.pg_class AS relation
           ON relation.relname = column_info.table_name
         LEFT JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace AND namespace.nspname = column_info.table_schema
         LEFT JOIN pg_catalog.pg_attribute AS attribute
           ON attribute.attrelid = relation.oid AND attribute.attname = column_info.column_name
        WHERE column_info.table_schema = 'public'
          AND column_info.table_name = ANY($1::text[])
          AND COALESCE(col_description(relation.oid, attribute.attnum), '') NOT LIKE '%02b-04-package-runtime-storage-registry-and-schema.md%'`,
      [[
        'object_write_intents',
        'storage_objects',
        'storage_object_copies',
        'storage_provider_attempts',
        'storage_operation_events',
        'storage_reconciliation_issues',
        'storage_idempotency_records',
      ]],
    );
    assert.equal(missingComments.rows[0]?.count, '0');

    const reapplyClient = await pool.connect();
    try {
      await assert.rejects(
        reapplyClient.query(await readFile('db/migrations/0002_z_s_runtime_registry.sql', 'utf8')),
        /migration already applied/,
      );
      await reapplyClient.query('ROLLBACK');
    } finally {
      reapplyClient.release();
    }
    await pool.query(await readFile('db/migrations/0002_z_s_runtime_registry.down.sql', 'utf8'));
    const afterRollback = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    assert.equal(afterRollback.rows[0]?.count, '7');
  } finally {
    await pool.end();
  }
});

integrationTest('durable duplicate protection creates one intent/object/copy set across 20 concurrent calls', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 24 });
  try {
    await resetDatabase(pool);
    await applyRuntimeMigration(pool);
    await seedControlPlane(pool);
    const registry = new PostgresRuntimeStorageRegistry({
      pool: adaptPool(pool),
      duplicateResultCodec: codec,
      now: () => new Date('2026-07-16T00:00:00.000Z'),
    });
    let operationCalls = 0;

    const execute = () =>
      registry.execute({
        scope: 'video-maker_app:api:object-write-intent',
        key: 'write-01',
        fingerprint: 'b'.repeat(64),
        operation: async () => {
          operationCalls += 1;
          const created = await registry.createObjectWriteIntent(createIntentInput());
          return {
            writeIntentId: created.intent.objectWriteIntentId,
            storageObjectId: created.object.storageObjectId,
          };
        },
      });

    const results = await Promise.all(Array.from({ length: 20 }, execute));
    assert.equal(operationCalls, 1);
    assert.equal(new Set(results.map((entry) => entry.value.writeIntentId)).size, 1);
    assert.equal(new Set(results.map((entry) => entry.value.storageObjectId)).size, 1);
    assert.equal(results.filter((entry) => entry.replayed).length, 19);

    const counts = await pool.query<{
      intents: string;
      objects: string;
      copies: string;
      records: string;
    }>(
      `SELECT
         (SELECT count(*) FROM public.object_write_intents)::text AS intents,
         (SELECT count(*) FROM public.storage_objects)::text AS objects,
         (SELECT count(*) FROM public.storage_object_copies)::text AS copies,
         (SELECT count(*) FROM public.storage_idempotency_records)::text AS records`,
    );
    assert.deepEqual(counts.rows[0], { intents: '1', objects: '1', copies: '2', records: '1' });

    await assert.rejects(
      registry.execute({
        scope: 'video-maker_app:api:object-write-intent',
        key: 'write-01',
        fingerprint: 'c'.repeat(64),
        operation: async () => ({ writeIntentId: randomUUID(), storageObjectId: randomUUID() }),
      }),
      (error: unknown) =>
        error instanceof RuntimeStorageRegistryError && error.code === 'idempotency-key-reused',
    );
  } finally {
    await pool.end();
  }
});

integrationTest('copy truth stays independent and provider/issue leases are exclusive with stale recovery', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    await resetDatabase(pool);
    await applyRuntimeMigration(pool);
    await seedControlPlane(pool);
    const registry = new PostgresRuntimeStorageRegistry({
      pool: adaptPool(pool),
      duplicateResultCodec: codec,
      now: () => new Date('2026-07-16T00:00:00.000Z'),
    });
    const created = await registry.createObjectWriteIntent(createIntentInput());
    const hot = created.object.copies.hot;
    const canonical = created.object.copies.canonical;

    await registry.updateCopyState({
      storageObjectCopyId: hot.storageObjectCopyId,
      expectedState: 'pending',
      nextState: 'failed',
      expectedRowVersion: hot.rowVersion,
    });
    await registry.updateCopyState({
      storageObjectCopyId: canonical.storageObjectCopyId,
      expectedState: 'pending',
      nextState: 'verified',
      expectedRowVersion: canonical.rowVersion,
      observedChecksumSha256: 'a'.repeat(64),
      observedByteLength: 1024,
      verifiedAt: new Date('2026-07-16T00:10:00.000Z'),
    });
    const afterCopies = await registry.getStorageObject(created.object.storageObjectId);
    assert.equal(afterCopies?.copies.hot.state, 'failed');
    assert.equal(afterCopies?.copies.canonical.state, 'verified');

    const attemptId = await registry.appendProviderAttempt({
      storageObjectCopyId: hot.storageObjectCopyId,
      storageObjectId: created.object.storageObjectId,
      operation: 'write',
      operationReference: 'write-hot-01',
      attemptNumber: 1,
      retryable: true,
    });
    const [workerA, workerB] = await Promise.all([
      registry.claimProviderAttempts({ owner: 'worker-a', limit: 1, leaseDurationMs: 60_000 }),
      registry.claimProviderAttempts({ owner: 'worker-b', limit: 1, leaseDurationMs: 60_000 }),
    ]);
    assert.equal(workerA.length + workerB.length, 1);
    const claimed = workerA[0] ?? workerB[0];
    assert.ok(claimed !== undefined && claimed.lease_owner !== null && claimed.lease_token !== null);
    await registry.finishProviderAttempt({
      providerAttemptId: attemptId,
      leaseOwner: claimed.lease_owner,
      leaseToken: claimed.lease_token,
      nextState: 'failed',
      retryable: true,
      nextRetryAt: new Date('2026-07-16T00:20:00.000Z'),
      diagnostic: { category: 'dependency-unavailable', code: 'provider-write-failed', retryable: true },
    });
    await assert.rejects(
      pool.query(
        `UPDATE public.storage_provider_attempts SET state = 'succeeded'
          WHERE storage_provider_attempt_id = $1`,
        [attemptId],
      ),
      /immutable/,
    );

    const issueId = await registry.openOrTouchReconciliationIssue({
      storageObjectId: created.object.storageObjectId,
      storageObjectCopyId: hot.storageObjectCopyId,
      providerRole: 'hot',
      category: 'copy-mismatch',
      summaryCode: 'hot-copy-write-failed',
      issueFingerprint: 'd'.repeat(64),
      safeDetail: { evidence: 'checksum-missing' },
    });
    const touchedId = await registry.openOrTouchReconciliationIssue({
      storageObjectId: created.object.storageObjectId,
      category: 'copy-mismatch',
      summaryCode: 'hot-copy-write-failed',
      issueFingerprint: 'd'.repeat(64),
      safeDetail: { evidence: 'retry-required' },
    });
    assert.equal(touchedId, issueId);

    const [issueWorkerA, issueWorkerB] = await Promise.all([
      registry.claimReconciliationIssues({ owner: 'worker-a', limit: 1, leaseDurationMs: 60_000 }),
      registry.claimReconciliationIssues({ owner: 'worker-b', limit: 1, leaseDurationMs: 60_000 }),
    ]);
    assert.equal(issueWorkerA.length + issueWorkerB.length, 1);
  } finally {
    await pool.end();
  }
});

integrationTest('safe event persistence rejects business/private fields and enforces dedupe', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    await resetDatabase(pool);
    await applyRuntimeMigration(pool);
    await seedControlPlane(pool);
    const registry = new PostgresRuntimeStorageRegistry({
      pool: adaptPool(pool),
      duplicateResultCodec: codec,
      now: () => new Date('2026-07-16T00:00:00.000Z'),
    });
    await assert.rejects(
      registry.appendStorageEvent({
        eventId: randomUUID(),
        dedupeKey: 'event-unsafe-01',
        eventType: 'object.accepted',
        contractVersion: '1.0',
        occurredAt: new Date(),
        managedAppId: IDS.managedApp,
        appCorrelationReference: 'resource-01',
        payload: { project_title: 'must-not-persist' },
      }),
      (error: unknown) =>
        error instanceof RuntimeStorageRegistryError && error.code === 'unsafe-event-payload-field',
    );

    const eventId = randomUUID();
    const event = {
      eventId,
      dedupeKey: 'event-safe-01',
      eventType: 'object.accepted',
      contractVersion: '1.0',
      occurredAt: new Date('2026-07-16T00:00:00.000Z'),
      managedAppId: IDS.managedApp,
      callerServiceId: 'api',
      appCorrelationReference: 'resource-01',
      payload: { state: 'accepted' },
    } as const;
    await registry.appendStorageEvent(event);
    await assert.rejects(registry.appendStorageEvent({ ...event, eventId: randomUUID() }), /duplicate key/);
    await assert.rejects(
      pool.query('UPDATE public.storage_operation_events SET event_type = $1 WHERE dedupe_key = $2', [
        'object.changed',
        event.dedupeKey,
      ]),
      /append-only/,
    );
  } finally {
    await pool.end();
  }
});
