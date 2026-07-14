import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationPath = 'db/migrations/0001_z_s_control_plane_foundation.sql';
const seedPath = 'db/seeds/0001_video_maker_dev_profiles.sql';

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
