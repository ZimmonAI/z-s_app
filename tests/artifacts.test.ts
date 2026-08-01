import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationPath = 'db/migrations/0001_z_s_control_plane_foundation.sql';
const vaultMigrationPath = 'db/migrations/0004_z_s_storage_control_vaults.sql';
const seedPath = 'db/seeds/0001_video_maker_dev_profiles.sql';
const installSmokePath = 'scripts/install-smoke.mjs';

const requiredTables = [
  'managed_apps',
  'storage_providers',
  'storage_profiles',
  'storage_profile_provider_bindings',
  'storage_prefix_classes',
  'storage_capability_results',
  'storage_profile_audit_events',
];

test('migration contains every required table and table reference comment', async () => {
  const sql = await readFile(migrationPath, 'utf8');
  for (const table of requiredTables) {
    assert.match(sql, new RegExp(`CREATE TABLE public\\.${table}\\b`, 'i'));
    assert.match(sql, new RegExp(`COMMENT ON TABLE public\\.${table}\\b`, 'i'));
  }
  assert.match(
    sql,
    /z-kn\/08-execution\/zimspace-storage-server-dev\/tasks\/in-progress\/storage-platform-development\/02a-package-z-s-core-control-plane-and-provider-capability-baseline\.md/,
  );
});

test('seed is idempotent and leaves capability readiness empty', async () => {
  const sql = await readFile(seedPath, 'utf8');
  const inserts = [...sql.matchAll(/INSERT INTO public\.[a-z_]+/gi)];
  const conflicts = [...sql.matchAll(/ON CONFLICT/gi)];
  assert.ok(inserts.length > 0);
  assert.equal(conflicts.length, inserts.length);
  assert.doesNotMatch(sql, /INSERT INTO public\.storage_capability_results/i);
  assert.match(sql, /video-maker-dev-default/);
  assert.match(sql, /video-maker-dev-private/);
});

test('tests and production sources contain no legacy fixed-length delivery identifier fixture', async () => {
  const files = [
    'src/domain.ts',
    'src/profile-registry.ts',
    'src/service.ts',
    'tests/control-plane.test.ts',
    'tests/integrity.test.ts',
  ];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    assert.doesNotMatch(content, /['"][a-f0-9]{24}['"]/);
  }
});

test('storage vault migration models dynamic clients, vaults, routes, image derivatives and token digests safely', async () => {
  const sql = await readFile(vaultMigrationPath, 'utf8');
  for (const table of [
    'storage_control_clients',
    'storage_control_vaults',
    'storage_control_route_rules',
    'storage_control_image_derivative_rules',
    'storage_control_client_tokens',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE public\\.${table}\\b`, 'i'));
    assert.match(sql, new RegExp(`COMMENT ON TABLE public\\.${table}\\b`, 'i'));
  }
  assert.match(sql, /provider_type IN \('minio', 'r2', 's3-compatible'\)/);
  assert.match(sql, /retention_policy IN \('permanent', 'hot-cache-short', 'custom'\)/);
  assert.match(sql, /asset_class IN \('raw-image', 'raw-video', 'image-derivative', 'document'\)/);
  assert.match(sql, /UNIQUE \(storage_control_client_id, id\)/);
  assert.match(sql, /FOREIGN KEY \(storage_control_client_id, primary_vault_id\)/);
  assert.match(sql, /FOREIGN KEY \(storage_control_client_id, target_vault_id\)/);
  assert.match(sql, /retention_policy IN \('hot-cache-short', 'custom'\) AND delete_after_days IS NOT NULL/);
  assert.match(sql, /token_digest text NOT NULL UNIQUE/);
  assert.match(sql, /CHECK \(jsonb_typeof\(resize_widths\) = 'array'\)/);
  assert.doesNotMatch(sql, /^\s*(endpoint|access_key_id|secret_access_key|credential|bearer_token|client_token)\s+/im);
});

test('package smoke resolves npm through the current Node process', async () => {
  const script = await readFile(installSmokePath, 'utf8');
  assert.match(script, /process\.env\.npm_execpath/);
  assert.match(script, /process\.execPath/);
  assert.doesNotMatch(script, /execFileAsync\(\s*'npm'/);
});
