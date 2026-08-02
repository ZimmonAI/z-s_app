import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { PostgresActiveConfigurationResolver } from '../src/runtime-active-configuration.js';
import { PostgresClientStorageConfigurationStore } from '../src/client-storage-configuration-postgres.js';
import { PostgresObjectReadRegistry } from '../src/runtime-read-grant.js';
import type { ConfigurationDraftDocument } from '../src/client-storage-configuration.js';
import {
  PostgresRuntimeStorageRegistry,
  createRuntimeStorageDuplicateResultCodec,
  type ConfiguredObjectWriteIntentExecutionContext,
} from '../src/runtime-storage-registry.js';
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

async function resetAndApplyThrough0010(pool: Pool): Promise<void> {
  await resetAndApplyThrough0004(pool);
  await apply0005(pool);
  await applyConfigurationCleanupMigrations(pool);
  await apply0010(pool);
}

function multiReplicaDocument(): ConfigurationDraftDocument {
  const document = configurationDraftDocument();
  return {
    ...document,
    vaults: [
      ...document.vaults,
      {
        vaultId: 'archive-copy',
        providerConnectionId: 'r2-hot',
        displayLabel: 'Archive copy',
        purpose: 'archive',
        bucketLabel: 'video-maker-archive',
        prefixTemplate: 'video-maker/archive/*',
        retention: { mode: 'permanent' },
      },
    ],
    routes: document.routes.map((route) => route.assetClass === 'video'
      ? {
          ...route,
          targets: [
            { role: 'primary' as const, vaultId: 'originals' },
            { role: 'replica' as const, vaultId: 'hot-copy' },
            { role: 'replica' as const, vaultId: 'archive-copy' },
          ],
        }
      : route),
  };
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

integrationTest('0010 migrates, documents runtime authority, rejects reapply, and rolls down empty state', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    await resetAndApplyThrough0004(pool);
    await apply0005(pool);
    await applyConfigurationCleanupMigrations(pool);
    await apply0010(pool);

    const columns = await pool.query<{ table_name: string; column_name: string }>(`
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name IN ('storage_objects', 'object_write_intents')
      AND column_name IN ('storage_control_client_id', 'configuration_version_id',
                          'configuration_fingerprint', 'configuration_route_id'))
    OR
    (table_name = 'storage_object_copies'
      AND column_name IN ('configuration_route_target_id', 'configuration_vault_id',
                          'provider_connection_id', 'target_role', 'target_order'))
  )
ORDER BY table_name, column_name
`);
    assert.equal(columns.rows.length, 13);

    const missingComments = await pool.query<{ count: string }>(`
SELECT count(*)::text AS count
FROM information_schema.columns AS columns
JOIN pg_catalog.pg_class AS relation ON relation.relname = columns.table_name
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = relation.relnamespace AND namespace.nspname = columns.table_schema
JOIN pg_catalog.pg_attribute AS attribute
  ON attribute.attrelid = relation.oid AND attribute.attname = columns.column_name
WHERE columns.table_schema = 'public'
  AND columns.table_name IN ('storage_objects', 'object_write_intents', 'storage_object_copies')
  AND columns.column_name IN (
    'storage_control_client_id', 'configuration_version_id', 'configuration_fingerprint',
    'configuration_route_id', 'configuration_route_target_id', 'configuration_vault_id',
    'provider_connection_id', 'target_role', 'target_order'
  )
  AND COALESCE(col_description(relation.oid, attribute.attnum), '') NOT LIKE '%T2 H03%'
`);
    assert.equal(missingComments.rows[0]?.count, '0');

    const reapply = await pool.connect();
    try {
      await assert.rejects(
        reapply.query(await readFile('db/migrations/0010_z_s_runtime_configuration_routing.sql', 'utf8')),
        /0010 migration already applied/,
      );
      await reapply.query('ROLLBACK');
    } finally {
      reapply.release();
    }

    await pool.query(await readFile('db/migrations/0010_z_s_runtime_configuration_routing.down.sql', 'utf8'));
    const after = await pool.query<{ count: string }>(`
SELECT count(*)::text AS count
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'storage_objects'
  AND column_name = 'configuration_version_id'
`);
    assert.equal(after.rows[0]?.count, '0');
  } finally {
    await pool.end();
  }
});

integrationTest('configured registry persists immutable provenance, degrades replicas, and retries one target only', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    await resetAndApplyThrough0010(pool);
    await seedClients(pool);
    const adapted = adaptPool(pool);
    const store = new PostgresClientStorageConfigurationStore(adapted);
    const draft = await store.createDraft('video-maker_app', {
      environment: 'dev',
      ...multiReplicaDocument(),
    }, new Date('2026-08-02T00:00:00.000Z'));
    const firstActive = await store.activateDraft(
      'video-maker_app', 'dev', draft.id, new Date('2026-08-02T00:01:00.000Z'),
    );
    const resolver = new PostgresActiveConfigurationResolver({
      queryable: adapted,
      credentialResolver,
    });
    const authority = await resolver.resolve({
      clientId: 'video-maker_app',
      environment: 'dev',
      assetClass: 'video',
    });
    assert.deepEqual(authority.targets.map((target) => [target.role, target.order]), [
      ['primary', 0], ['replica', 1], ['replica', 2],
    ]);

    const registry = new PostgresRuntimeStorageRegistry({
      pool: adapted,
      duplicateResultCodec: createRuntimeStorageDuplicateResultCodec(),
      now: () => new Date('2026-08-02T00:02:00.000Z'),
    });
    const storageObjectId = randomUUID();
    const created = await registry.createConfiguredObjectWriteIntent({
      storageObjectId,
      storageControlClientId: authority.storageControlClientId,
      configurationVersionId: authority.configurationVersionId,
      configurationFingerprint: authority.configurationFingerprint,
      configurationRouteId: authority.configurationRouteId,
      callerServiceId: 'integration-token',
      appCorrelationReference: 'resource-configured-01',
      sourceReference: 'pending-resource-configured-01',
      expectedContentType: 'video/mp4',
      expectedByteLength: 1024,
      expectedChecksumSha256: 'c'.repeat(64),
      expiresAt: new Date('2026-08-02T01:00:00.000Z'),
      targets: authority.targets.map((target) => Object.freeze({
        configurationRouteTargetId: target.configurationRouteTargetId,
        configurationVaultId: target.configurationVaultId,
        providerConnectionId: target.providerConnectionId,
        role: target.role,
        order: target.order,
        providerType: target.providerType,
        bucketLabel: target.bucketLabel,
        prefixTemplate: target.prefixTemplate,
        secretReferenceId: target.secretReferenceId,
        internalLocator: target.prefixTemplate.replace(/\*$/, storageObjectId),
      })),
      safeTechnicalMetadata: Object.freeze({ route_id: authority.routeId }),
    });
    assert.equal(created.object.configuredCopies?.length, 3);

    const nextDraft = await store.cloneVersion(
      'video-maker_app', 'dev', firstActive.id, new Date('2026-08-02T00:03:00.000Z'),
    );
    const nextActive = await store.activateDraft(
      'video-maker_app', 'dev', nextDraft.id, new Date('2026-08-02T00:04:00.000Z'),
    );
    assert.notEqual(nextActive.id, firstActive.id);
    const persisted = await registry.getObjectWriteIntentExecutionContext(
      created.intent.objectWriteIntentId,
    );
    assert.ok(persisted !== null && persisted.authorityKind === 'configuration');
    assert.equal(persisted.configurationVersionId, firstActive.id);
    assert.equal(persisted.configurationFingerprint, authority.configurationFingerprint);

    const uploading = await registry.beginObjectUpload({
      objectWriteIntentId: created.intent.objectWriteIntentId,
      expectedRowVersion: created.intent.rowVersion,
    }) as ConfiguredObjectWriteIntentExecutionContext;
    const reservation = await registry.beginConfiguredProviderWrite({
      objectWriteIntentId: uploading.objectWriteIntentId,
      storageObjectId: uploading.storageObjectId,
      expectedIntentRowVersion: uploading.rowVersion,
      expectedObjectRowVersion: uploading.objectRowVersion,
      expectedChecksumSha256: uploading.expectedChecksumSha256,
      expectedByteLength: uploading.expectedByteLength,
      copies: uploading.configuredCopies,
    });
    const primary = uploading.configuredCopies.find((copy) => copy.role === 'primary')!;
    const replicas = uploading.configuredCopies.filter((copy) => copy.role === 'replica')
      .sort((left, right) => left.order - right.order);
    const degraded = await registry.completeConfiguredProviderWrite({
      reservation,
      checksumSha256: uploading.expectedChecksumSha256,
      byteLength: uploading.expectedByteLength,
      verifiedMedia: Object.freeze({
        mediaType: 'video/mp4', mediaFamily: 'video',
        video: Object.freeze({ durationMs: 1000, container: 'mp4' }),
      }),
      outcomes: Object.freeze([
        Object.freeze({ configurationRouteTargetId: primary.configurationRouteTargetId, outcome: Object.freeze({
          state: 'verified' as const, retryable: false,
          observedChecksumSha256: uploading.expectedChecksumSha256,
          observedByteLength: uploading.expectedByteLength,
        }) }),
        Object.freeze({ configurationRouteTargetId: replicas[0]!.configurationRouteTargetId, outcome: Object.freeze({
          state: 'verified' as const, retryable: false,
          observedChecksumSha256: uploading.expectedChecksumSha256,
          observedByteLength: uploading.expectedByteLength,
        }) }),
        Object.freeze({ configurationRouteTargetId: replicas[1]!.configurationRouteTargetId, outcome: Object.freeze({
          state: 'failed' as const, retryable: true,
          diagnostic: Object.freeze({ category: 'dependency-unavailable' as const, code: 'provider-write-failed', retryable: true }),
        }) }),
      ]),
    });
    assert.equal(degraded.storageState, 'degraded');
    assert.deepEqual(degraded.targetCopies?.map((copy) => copy.state), ['verified', 'verified', 'failed']);

    const readRegistry = new PostgresObjectReadRegistry({
      pool: adapted,
      now: () => new Date('2026-08-02T00:02:30.000Z'),
    });
    const readGrant = await readRegistry.createObjectReadGrant({
      objectReadGrantId: randomUUID(),
      storageObjectId,
      callerAppId: 'video-maker_app',
      callerServiceId: 'integration-token',
      appCorrelationReference: 'configured-read-grant-01',
      businessAuthorizationReference: 'configured-read-policy-01',
      purpose: 'configured-read',
      allowedMethods: Object.freeze(['HEAD', 'GET'] as const),
      allowRange: true,
      disposition: 'inline',
      tokenDigest: 'd'.repeat(64),
      expiresAt: new Date('2026-08-02T00:07:30.000Z'),
    });
    assert.equal(readGrant.callerAppId, 'video-maker_app');
    const deliverySnapshot = await readRegistry.getObjectReadDeliverySnapshot({
      storageObjectId,
      callerAppId: 'video-maker_app',
      callerServiceId: 'integration-token',
    });
    assert.deepEqual(deliverySnapshot?.configuredCopies?.map((copy) => [copy.role, copy.order]), [
      ['replica', 1], ['replica', 2], ['primary', 0],
    ]);

    const beforeRetry = await pool.query<{
      configuration_route_target_id: string;
      copy_state: string;
      row_version: number;
    }>(`
SELECT configuration_route_target_id, copy_state, row_version
FROM public.storage_object_copies
WHERE storage_object_id = $1
ORDER BY target_order
`, [storageObjectId]);
    const failedRow = beforeRetry.rows.find(
      (row) => row.configuration_route_target_id === replicas[1]!.configurationRouteTargetId,
    )!;
    const peerVersions = new Map(
      beforeRetry.rows
        .filter((row) => row.configuration_route_target_id !== replicas[1]!.configurationRouteTargetId)
        .map((row) => [row.configuration_route_target_id, row.row_version]),
    );
    const retryReservation = await registry.reserveConfiguredTargetRetry({
      clientId: 'client-a',
      storageObjectId,
      configurationRouteTargetId: replicas[1]!.configurationRouteTargetId,
      expectedFailedCopyVersion: failedRow.row_version,
    });
    const repaired = await registry.completeConfiguredTargetRetry({
      reservation: retryReservation,
      outcome: Object.freeze({
        state: 'verified', retryable: false,
        observedChecksumSha256: uploading.expectedChecksumSha256,
        observedByteLength: uploading.expectedByteLength,
      }),
    });
    assert.equal(repaired.storageState, 'ready');
    const afterRetry = await pool.query<{
      configuration_route_target_id: string;
      copy_state: string;
      row_version: number;
    }>(`
SELECT configuration_route_target_id, copy_state, row_version
FROM public.storage_object_copies
WHERE storage_object_id = $1
ORDER BY target_order
`, [storageObjectId]);
    for (const row of afterRetry.rows) {
      if (row.configuration_route_target_id === replicas[1]!.configurationRouteTargetId) {
        assert.equal(row.copy_state, 'verified');
        assert.equal(row.row_version, failedRow.row_version + 2);
      } else {
        assert.equal(row.row_version, peerVersions.get(row.configuration_route_target_id));
      }
    }
    const attemptCounts = await pool.query<{
      configuration_route_target_id: string;
      count: string;
    }>(`
SELECT copy.configuration_route_target_id, count(attempt.*)::text AS count
FROM public.storage_object_copies AS copy
JOIN public.storage_provider_attempts AS attempt
  ON attempt.storage_object_copy_id = copy.storage_object_copy_id
WHERE copy.storage_object_id = $1
GROUP BY copy.configuration_route_target_id
`, [storageObjectId]);
    const countByTarget = new Map(attemptCounts.rows.map((row) => [row.configuration_route_target_id, row.count]));
    assert.equal(countByTarget.get(replicas[1]!.configurationRouteTargetId), '2');
    assert.equal(countByTarget.get(primary.configurationRouteTargetId), '1');
    assert.equal(countByTarget.get(replicas[0]!.configurationRouteTargetId), '1');

    const rollback = await pool.connect();
    try {
      await assert.rejects(
        rollback.query(await readFile('db/migrations/0010_z_s_runtime_configuration_routing.down.sql', 'utf8')),
        /0010 rollback blocked: configuration-routed runtime rows exist/,
      );
      await rollback.query('ROLLBACK');
    } finally {
      rollback.release();
    }
  } finally {
    await pool.end();
  }
});

if (databaseUrl === undefined) {
  test('runtime configuration routing PostgreSQL integration requires TEST_DATABASE_URL', () => {
    assert.equal(databaseUrl, undefined);
  });
}
