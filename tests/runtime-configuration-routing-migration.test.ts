import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const upPath = 'db/migrations/0010_z_s_runtime_configuration_routing.sql';
const downPath = 'db/migrations/0010_z_s_runtime_configuration_routing.down.sql';

test('0010 is additive, guarded and persists provider-neutral authority', async () => {
  const [up, down] = await Promise.all([readFile(upPath, 'utf8'), readFile(downPath, 'utf8')]);
  for (const value of [
    'storage_control_client_id', 'configuration_version_id', 'configuration_fingerprint',
    'configuration_route_id', 'configuration_route_target_id', 'configuration_vault_id',
    'provider_connection_id', 'target_role', 'target_order',
  ]) assert.match(up, new RegExp(value));
  assert.match(up, /target_role IS NULL OR target_role IN \('primary', 'replica'\)/);
  assert.match(up, /target_role = 'primary' AND target_order = 0/);
  assert.match(up, /target_role = 'replica' AND target_order > 0/);
  assert.match(up, /storage_object_copies_configuration_target_idx/);
  assert.match(up, /0010 migration already applied/);
  assert.doesNotMatch(up, /INSERT INTO public\./);
  assert.match(down, /row_total <> 0/);
  assert.match(down, /0010 rollback blocked: configuration-routed runtime rows exist/);
});
