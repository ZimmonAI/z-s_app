import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function gitBlobSha(content: Buffer): string {
  const header = Buffer.from(`blob ${content.byteLength}\0`, 'utf8');
  return createHash('sha1').update(header).update(content).digest('hex');
}

test('migration 0004 remains byte-for-byte immutable', async () => {
  const up = await readFile('db/migrations/0004_z_s_storage_control_vaults.sql');
  const down = await readFile('db/migrations/0004_z_s_storage_control_vaults.down.sql');
  assert.equal(gitBlobSha(up), '6fdccc94f29ab942acdf54bab6950ef6d6fc8b59');
  assert.equal(gitBlobSha(down), '123b3b98b93d12c89df2337403d51c26d3f5b881');
});

test('migration 0005 is additive, guarded, client-scoped, immutable, and digest-only', async () => {
  const up = await readFile('db/migrations/0005_z_s_client_storage_configuration.sql', 'utf8');
  const down = await readFile(
    'db/migrations/0005_z_s_client_storage_configuration.down.sql',
    'utf8',
  );
  for (const table of [
    'storage_control_provider_connections',
    'storage_control_configuration_versions',
    'storage_control_configuration_vaults',
    'storage_control_configuration_image_presets',
    'storage_control_configuration_routes',
    'storage_control_configuration_route_targets',
    'storage_control_integration_tokens',
    'storage_control_configuration_audit_events',
  ]) {
    assert.match(up, new RegExp(`CREATE TABLE public\\.${table}\\s*\\(`, 'i'));
    assert.match(up, new RegExp(`COMMENT ON TABLE public\\.${table} IS`, 'i'));
    assert.match(down, new RegExp(`DROP TABLE public\\.${table};`, 'i'));
  }
  assert.match(up, /0005 preflight missing 0004 table/i);
  assert.match(up, /0005 migration already applied/i);
  assert.match(down, /0005 rollback blocked/i);
  assert.match(up, /WHERE state = 'active'/i);
  assert.match(up, /storage_control_configuration_versions_one_active_idx/i);
  assert.match(up, /target_role IN \('primary', 'replica'\)/i);
  assert.match(up, /storage_control_configuration_route_targets_primary_idx/i);
  assert.match(up, /configuration children are mutable only while the version is draft/i);
  assert.match(up, /active configuration version is immutable except supersede transition/i);
  assert.match(up, /configuration audit events are append-only/i);
  assert.match(up, /token_digest text NOT NULL UNIQUE/i);
  assert.match(up, /object:write/i);
  assert.match(up, /object:read/i);
  assert.match(up, /object:manage/i);
  assert.match(up, /secret_reference_id text NOT NULL/i);
  assert.match(up, /COMMENT ON COLUMN public\.%I\.%I/i);
  assert.doesNotMatch(up, /^\s*(?:credential|password|endpoint|access_key|secret_key)\s+/im);
  assert.doesNotMatch(up, /INSERT INTO public\.storage_control_/i);
  assert.doesNotMatch(up, /CREATE EXTENSION/i);
});
