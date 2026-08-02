import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ActiveConfigurationError,
  PostgresActiveConfigurationResolver,
  deriveRuntimeAssetClass,
  stableConfigurationFingerprint,
  type ResolvedConfigurationTarget,
} from '../src/runtime-active-configuration.js';
import type { ProviderCredentialResolver } from '../src/runtime-s3-provider.js';
import type { PostgresQueryable } from '../src/runtime-storage-registry-types.js';

const ids = {
  client: '10000000-0000-4000-8000-000000000001',
  version: '10000000-0000-4000-8000-000000000002',
  route: '10000000-0000-4000-8000-000000000003',
};

function row(role: 'primary' | 'replica', order: number, suffix: number) {
  return {
    storage_control_client_id: ids.client,
    client_id: 'client-a',
    configuration_version_id: ids.version,
    version_number: 3,
    environment: 'dev' as const,
    configuration_route_id: ids.route,
    route_id: 'videos',
    asset_class: 'video' as const,
    configuration_route_target_id: `20000000-0000-4000-8000-00000000000${suffix}`,
    target_role: role,
    target_order: order,
    configuration_vault_id: `30000000-0000-4000-8000-00000000000${suffix}`,
    vault_id: `vault-${suffix}`,
    bucket_label: `private-bucket-${suffix}`,
    prefix_template: `client-a/video/${suffix}/*`,
    provider_connection_id: `40000000-0000-4000-8000-00000000000${suffix}`,
    connection_id: `connection-${suffix}`,
    provider_type: suffix === 1 ? 'minio' as const : 'r2' as const,
    secret_reference_id: `vault:z-s:connection-${suffix}`,
  };
}

function resolver(rows: ReturnType<typeof row>[], readiness = {
  active_configuration_count: 1, route_count: 1,
  route_target_count: rows.length, active_connection_target_count: rows.length,
}) {
  const calls: readonly unknown[][] = [];
  const mutableCalls = calls as unknown as unknown[][];
  const queryable: PostgresQueryable = {
    query: (async (text: string, values: readonly unknown[] = []) => {
      mutableCalls.push([...values]);
      return text.includes('COUNT(DISTINCT versions.id)')
        ? { rows: [readiness], rowCount: 1 }
        : { rows, rowCount: rows.length };
    }) as PostgresQueryable['query'],
  };
  const resolvedSecrets: string[] = [];
  const credentialResolver: ProviderCredentialResolver = {
    resolve: async (secretReferenceId) => {
      resolvedSecrets.push(secretReferenceId);
      return Object.freeze({
        endpoint: 'https://provider.invalid', region: 'auto', forcePathStyle: false,
        accessKeyId: 'resolved-but-never-fingerprinted', secretAccessKey: 'private',
      });
    },
  };
  return {
    resolver: new PostgresActiveConfigurationResolver({ queryable, credentialResolver }),
    calls,
    resolvedSecrets,
  };
}

function configurationError(code: string) {
  return (error: unknown) => error instanceof ActiveConfigurationError && error.code === code;
}

test('authenticated client and environment bind the exact active route query', async () => {
  const harness = resolver([row('primary', 0, 1), row('replica', 1, 2), row('replica', 2, 3)]);
  const result = await harness.resolver.resolve({ clientId: 'client-a', environment: 'dev', assetClass: 'video' });
  assert.deepEqual(harness.calls, [
    ['client-a', 'dev', 'video'],
    ['client-a', 'dev', 'video'],
  ]);
  assert.equal(result.targets[0]?.role, 'primary');
  assert.deepEqual(result.targets.slice(1).map((target) => target.order), [1, 2]);
  assert.deepEqual(harness.resolvedSecrets, [
    'vault:z-s:connection-1', 'vault:z-s:connection-2', 'vault:z-s:connection-3',
  ]);
  assert.match(result.configurationFingerprint, /^[a-f0-9]{64}$/);
});

test('zero replicas is valid while missing or duplicate primary is rejected', async () => {
  const zeroReplica = await resolver([row('primary', 0, 1)]).resolver.resolve({
    clientId: 'client-a', environment: 'dev', assetClass: 'video',
  });
  assert.equal(zeroReplica.targets.length, 1);
  await assert.rejects(
    resolver([row('replica', 1, 2)]).resolver.resolve({ clientId: 'client-a', environment: 'dev', assetClass: 'video' }),
    configurationError('configuration-primary-target-not-ready'),
  );
  await assert.rejects(
    resolver([row('primary', 0, 1), row('primary', 0, 2)]).resolver.resolve({ clientId: 'client-a', environment: 'dev', assetClass: 'video' }),
    configurationError('configuration-primary-target-not-ready'),
  );
});

test('no active configuration, missing route and inactive connection are distinguished', async () => {
  await assert.rejects(
    resolver([], { active_configuration_count: 0, route_count: 0, route_target_count: 0, active_connection_target_count: 0 })
      .resolver.resolve({ clientId: 'client-b', environment: 'prod', assetClass: 'document' }),
    configurationError('active-configuration-not-ready'),
  );
  await assert.rejects(
    resolver([], { active_configuration_count: 1, route_count: 0, route_target_count: 0, active_connection_target_count: 0 })
      .resolver.resolve({ clientId: 'client-a', environment: 'dev', assetClass: 'image' }),
    configurationError('configuration-route-not-found'),
  );
  await assert.rejects(
    resolver([row('primary', 0, 1)], { active_configuration_count: 1, route_count: 1, route_target_count: 1, active_connection_target_count: 0 })
      .resolver.resolve({ clientId: 'client-a', environment: 'dev', assetClass: 'video' }),
    configurationError('configuration-provider-connection-not-ready'),
  );
});

test('stable fingerprint ignores key insertion order but changes with route authority', () => {
  const target = {
    configurationRouteTargetId: 'target', configurationVaultId: 'vault-db',
    providerConnectionId: 'connection-db', role: 'primary' as const, order: 0,
    providerType: 'minio' as const, bucketLabel: 'private-bucket', prefixTemplate: 'a/*',
    secretReferenceId: 'secret-ref', vaultId: 'vault', connectionId: 'connection',
  } satisfies ResolvedConfigurationTarget;
  const reordered = {
    connectionId: 'connection', vaultId: 'vault', secretReferenceId: 'secret-ref',
    prefixTemplate: 'a/*', bucketLabel: 'private-bucket', providerType: 'minio' as const,
    order: 0, role: 'primary' as const, providerConnectionId: 'connection-db',
    configurationVaultId: 'vault-db', configurationRouteTargetId: 'target',
  } satisfies ResolvedConfigurationTarget;
  const base = { configurationVersionId: 'version', versionNumber: 3, environment: 'dev' as const,
    routeId: 'videos', assetClass: 'video' as const, targets: [target] };
  assert.equal(stableConfigurationFingerprint(base), stableConfigurationFingerprint({ ...base, targets: [reordered] }));
  assert.notEqual(stableConfigurationFingerprint(base), stableConfigurationFingerprint({ ...base, routeId: 'videos-v2' }));
  const fingerprint = stableConfigurationFingerprint(base);
  assert.equal(fingerprint.includes('private-bucket'), false);
  assert.equal(deriveRuntimeAssetClass('image/webp'), 'image');
  assert.equal(deriveRuntimeAssetClass('video/mp4'), 'video');
  assert.equal(deriveRuntimeAssetClass('application/pdf'), 'document');
});
