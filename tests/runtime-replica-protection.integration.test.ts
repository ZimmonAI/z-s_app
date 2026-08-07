import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { ConfigurationDraftDocument } from '../src/client-storage-configuration.js';
import { PostgresClientStorageConfigurationStore } from '../src/client-storage-configuration-postgres.js';
import { PostgresActiveConfigurationResolver } from '../src/runtime-active-configuration.js';
import { PostgresLeasedReplicaProtectionStore } from '../src/runtime-replica-protection-postgres.js';
import {
  REPLICA_PROTECTION_LIMITS,
  ReplicaProtectionError,
} from '../src/runtime-replica-protection.js';
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
  databaseUrl,
  integrationTest,
  resetAndApplyThrough0004,
  seedClients,
} from './client-storage-configuration-integration-helpers.js';

const NOW = new Date('2026-08-07T00:00:00.000Z');
const CHECKSUM = '9'.repeat(64);
const BYTE_LENGTH = 4096;

const credentialResolver: ProviderCredentialResolver = {
  resolve: async () => Object.freeze({
    endpoint: 'https://provider.invalid',
    region: 'auto',
    forcePathStyle: false,
    accessKeyId: ['test', 'access-key'].join('-'),
    secretAccessKey: ['test', 'secret-access-key'].join('-'),
  }),
};

async function resetThrough0010(pool: Pool): Promise<void> {
  await resetAndApplyThrough0004(pool);
  await apply0005(pool);
  await applyConfigurationCleanupMigrations(pool);
  await pool.query(await readFile('db/migrations/0010_z_s_runtime_configuration_routing.sql', 'utf8'));
}

function configuration(): ConfigurationDraftDocument {
  return {
    providerConnections: [
      { connectionId: 'r2-primary', displayLabel: 'R2 primary', providerType: 'r2', secretReferenceId: 'vault:z-s:r2-primary', safeMetadata: { regionLabel: 'global-hot' } },
      { connectionId: 'minio-protection', displayLabel: 'MinIO protection', providerType: 'minio', secretReferenceId: 'vault:z-s:minio-protection', safeMetadata: { regionLabel: 'local-protection' } },
    ],
    vaults: [
      { vaultId: 'r2-primary', providerConnectionId: 'r2-primary', displayLabel: 'R2 primary', purpose: 'hot-copy', bucketLabel: 'video-maker-hot', prefixTemplate: 'video-maker/hot/*', retention: { mode: 'delete-after-days', deleteAfterDays: 7 } },
      { vaultId: 'minio-protection', providerConnectionId: 'minio-protection', displayLabel: 'MinIO protection', purpose: 'archive', bucketLabel: 'video-maker-protection', prefixTemplate: 'video-maker/protection/*', retention: { mode: 'permanent' } },
      { vaultId: 'image-derivatives', providerConnectionId: 'r2-primary', displayLabel: 'Image derivatives', purpose: 'derivatives', bucketLabel: 'video-maker-derivatives', prefixTemplate: 'video-maker/derivatives/*', retention: { mode: 'permanent' } },
    ],
    routes: [
      { routeId: 'images', assetClass: 'image', targets: [{ role: 'primary', vaultId: 'r2-primary' }, { role: 'replica', vaultId: 'minio-protection' }], imagePresetId: 'production-images' },
      { routeId: 'videos', assetClass: 'video', targets: [{ role: 'primary', vaultId: 'r2-primary' }, { role: 'replica', vaultId: 'minio-protection' }] },
      { routeId: 'documents', assetClass: 'document', targets: [{ role: 'primary', vaultId: 'r2-primary' }, { role: 'replica', vaultId: 'minio-protection' }] },
    ],
    imagePresets: [
      { presetId: 'production-images', targetVaultId: 'image-derivatives', widths: [512], outputFormat: 'png', quality: 82, fit: 'inside' },
    ],
  };
}

async function activate(pool: Pool): Promise<void> {
  const adapted = adaptPool(pool);
  const store = new PostgresClientStorageConfigurationStore(adapted);
  const draft = await store.createDraft('video-maker_app', { environment: 'dev', ...configuration() }, NOW);
  await store.activateDraft('video-maker_app', 'dev', draft.id, new Date(NOW.getTime() + 1_000));
}

async function createDegradedObject(pool: Pool, suffix: string) {
  const adapted = adaptPool(pool);
  const authority = await new PostgresActiveConfigurationResolver({ queryable: adapted, credentialResolver })
    .resolve({ clientId: 'video-maker_app', environment: 'dev', assetClass: 'video' });
  const registry = new PostgresRuntimeStorageRegistry({
    pool: adapted,
    duplicateResultCodec: createRuntimeStorageDuplicateResultCodec(),
    now: () => NOW,
  });
  const storageObjectId = randomUUID();
  const created = await registry.createConfiguredObjectWriteIntent({
    storageObjectId,
    storageControlClientId: authority.storageControlClientId,
    configurationVersionId: authority.configurationVersionId,
    configurationFingerprint: authority.configurationFingerprint,
    configurationRouteId: authority.configurationRouteId,
    callerServiceId: 'integration-token',
    appCorrelationReference: `repair-${suffix}`,
    sourceReference: `pending-repair-${suffix}`,
    expectedContentType: 'video/mp4',
    expectedByteLength: BYTE_LENGTH,
    expectedChecksumSha256: CHECKSUM,
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
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
  const replica = uploading.configuredCopies.find((copy) => copy.role === 'replica')!;
  const result = await registry.completeConfiguredProviderWrite({
    reservation,
    checksumSha256: CHECKSUM,
    byteLength: BYTE_LENGTH,
    verifiedMedia: Object.freeze({ mediaType: 'video/mp4', mediaFamily: 'video', video: Object.freeze({ durationMs: 1_000, container: 'mp4' }) }),
    outcomes: Object.freeze([Object.freeze({
      configurationRouteTargetId: primary.configurationRouteTargetId,
      outcome: Object.freeze({ state: 'verified' as const, retryable: false, observedChecksumSha256: CHECKSUM, observedByteLength: BYTE_LENGTH }),
    })]),
  });
  assert.equal(result.storageState, 'degraded');
  assert.equal(result.objectProtectionStage, 'configuration-replica-repair-required');
  return { storageObjectId, replica };
}

function errorCode(code: string) {
  return (error: unknown) => error instanceof ReplicaProtectionError && error.code === code;
}

integrationTest('PostgreSQL repair claims are single-owner, stale-safe, and retry-bounded', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  try {
    await resetThrough0010(pool);
    await seedClients(pool);
    await activate(pool);
    const store = new PostgresLeasedReplicaProtectionStore(adaptPool(pool));
    const first = await createDegradedObject(pool, 'concurrent');

    const claims = await Promise.all(Array.from({ length: 6 }, (_, index) => store.claimRepair({
      clientId: 'video-maker_app', environment: 'dev', workerId: `worker-${index + 1}`, now: NOW,
    })));
    const claimed = claims.filter((job): job is NonNullable<typeof job> => job !== null);
    assert.equal(claimed.length, 1);
    const stale = claimed[0]!;
    assert.equal(stale.targetStorageObjectCopyId, first.replica.storageObjectCopyId);

    const afterExpiry = new Date(NOW.getTime() + REPLICA_PROTECTION_LIMITS.leaseDurationMs + 1);
    const replacement = await store.claimRepair({ clientId: 'video-maker_app', environment: 'dev', workerId: 'replacement', now: afterExpiry });
    assert.ok(replacement !== null);
    assert.equal(replacement.attemptNumber, 2);
    await assert.rejects(store.completeRepair(stale, afterExpiry), errorCode('storage-replica-lease-lost'));
    await store.completeRepair(replacement, afterExpiry);

    const truth = await pool.query<{ registry_state: string; object_protection_stage: string; replica_state: string; repair_attempts: string; expired_attempts: string }>(`
SELECT object_record.registry_state, object_record.object_protection_stage,
       replica.copy_state AS replica_state,
       (SELECT count(*)::text FROM public.storage_provider_attempts AS attempt WHERE attempt.storage_object_copy_id = replica.storage_object_copy_id AND attempt.operation = 'repair') AS repair_attempts,
       (SELECT count(*)::text FROM public.storage_provider_attempts AS attempt WHERE attempt.storage_object_copy_id = replica.storage_object_copy_id AND attempt.operation = 'repair' AND attempt.safe_diagnostic_code = 'storage-replica-lease-expired') AS expired_attempts
  FROM public.storage_objects AS object_record
  JOIN public.storage_object_copies AS replica ON replica.storage_object_id = object_record.storage_object_id AND replica.target_role = 'replica'
 WHERE object_record.storage_object_id = $1
`, [first.storageObjectId]);
    assert.deepEqual(truth.rows[0], {
      registry_state: 'active', object_protection_stage: 'configuration-primary-and-replicas-verified', replica_state: 'verified', repair_attempts: '2', expired_attempts: '1',
    });

    const retryObject = await createDegradedObject(pool, 'retry');
    const retry1 = await store.claimRepair({ clientId: 'video-maker_app', environment: 'dev', workerId: 'retry-1', now: NOW });
    assert.ok(retry1 !== null && retry1.storageObjectId === retryObject.storageObjectId);
    await store.failRepair({ job: retry1, category: 'dependency-unavailable', code: 'provider-write-failed', retryable: true, now: NOW });
    assert.equal(await store.claimRepair({
      clientId: 'video-maker_app', environment: 'dev', workerId: 'too-early',
      now: new Date(NOW.getTime() + REPLICA_PROTECTION_LIMITS.retryDelayMs - 1),
    }), null);
    const retry2 = await store.claimRepair({
      clientId: 'video-maker_app', environment: 'dev', workerId: 'retry-2',
      now: new Date(NOW.getTime() + REPLICA_PROTECTION_LIMITS.retryDelayMs),
    });
    assert.ok(retry2 !== null);
    assert.equal(retry2.attemptNumber, 2);
  } finally {
    await pool.end();
  }
});

integrationTest('PostgreSQL retention stays blocked until protection is verified, then deletes only primary authority', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    await resetThrough0010(pool);
    await seedClients(pool);
    await activate(pool);
    const store = new PostgresLeasedReplicaProtectionStore(adaptPool(pool));
    const object = await createDegradedObject(pool, 'retention');
    const due = new Date(NOW.getTime() + 8 * 24 * 60 * 60_000);

    const blocked = await store.claimRetention({ clientId: 'video-maker_app', environment: 'dev', workerId: 'blocked', now: due });
    assert.equal(blocked.kind, 'blocked');

    const repair = await store.claimRepair({ clientId: 'video-maker_app', environment: 'dev', workerId: 'repair', now: due });
    assert.ok(repair !== null);
    await store.completeRepair(repair, due);
    const claim = await store.claimRetention({ clientId: 'video-maker_app', environment: 'dev', workerId: 'retention', now: due });
    assert.equal(claim.kind, 'job');
    if (claim.kind !== 'job') assert.fail('expected retention job');
    await store.completeRetention(claim.job, due);

    const truth = await pool.query<{ registry_state: string; object_protection_stage: string; primary_state: string; replica_state: string }>(`
SELECT object_record.registry_state, object_record.object_protection_stage,
       primary_copy.copy_state AS primary_state, replica.copy_state AS replica_state
  FROM public.storage_objects AS object_record
  JOIN public.storage_object_copies AS primary_copy ON primary_copy.storage_object_id = object_record.storage_object_id AND primary_copy.target_role = 'primary'
  JOIN public.storage_object_copies AS replica ON replica.storage_object_id = object_record.storage_object_id AND replica.target_role = 'replica'
 WHERE object_record.storage_object_id = $1
`, [object.storageObjectId]);
    assert.deepEqual(truth.rows[0], {
      registry_state: 'active', object_protection_stage: 'configuration-primary-retention-cleaned', primary_state: 'deleted', replica_state: 'verified',
    });
  } finally {
    await pool.end();
  }
});
