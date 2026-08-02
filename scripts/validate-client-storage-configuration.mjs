import { readFile } from 'node:fs/promises';

const upPath = 'db/migrations/0005_z_s_client_storage_configuration.sql';
const downPath = 'db/migrations/0005_z_s_client_storage_configuration.down.sql';
const up = await readFile(upPath, 'utf8');
const down = await readFile(downPath, 'utf8');
const errors = [];
const taskReference =
  'z-kn/08-execution/z-s_app-mvp/tasks/planning/t2-client-storage-workspace/handoffs/01-online-configuration-platform-coding.md';
const tables = [
  'storage_control_provider_connections',
  'storage_control_configuration_versions',
  'storage_control_configuration_vaults',
  'storage_control_configuration_image_presets',
  'storage_control_configuration_routes',
  'storage_control_configuration_route_targets',
  'storage_control_integration_tokens',
  'storage_control_configuration_audit_events',
];

for (const table of tables) {
  if (!new RegExp(`CREATE TABLE public\\.${table}\\s*\\(`, 'i').test(up)) {
    errors.push(`missing configuration table ${table}`);
  }
  const comment = up.match(
    new RegExp(`COMMENT ON TABLE public\\.${table} IS '([^']*)'`, 'i'),
  );
  if (!comment) errors.push(`missing configuration table comment ${table}`);
  else if (!comment[1]?.includes(taskReference)) {
    errors.push(`configuration table comment missing task reference ${table}`);
  }
  if (!new RegExp(`DROP TABLE public\\.${table};`, 'i').test(down)) {
    errors.push(`configuration rollback missing table ${table}`);
  }
}

for (const pattern of [
  /SET LOCAL lock_timeout = '5s'/i,
  /SET LOCAL statement_timeout = '60s'/i,
  /0005 preflight missing 0004 table/i,
  /0005 migration already applied/i,
  /state IN \('draft', 'active', 'superseded'\)/i,
  /validation_state IN \('unvalidated', 'valid', 'invalid'\)/i,
  /storage_control_configuration_versions_one_active_idx/i,
  /WHERE state = 'active'/i,
  /target_role IN \('primary', 'replica'\)/i,
  /storage_control_configuration_route_targets_primary_idx/i,
  /token_digest text NOT NULL UNIQUE/i,
  /token_digest ~ '\^\[a-f0-9\]\{64\}\$'/i,
  /object:write/i,
  /object:read/i,
  /object:manage/i,
  /configuration children are mutable only while the version is draft/i,
  /active configuration version is immutable except supersede transition/i,
  /configuration audit events are append-only/i,
  /COMMENT ON COLUMN public\.%I\.%I/i,
  /0005 rollback blocked/i,
]) {
  if (!pattern.test(`${up}\n${down}`)) {
    errors.push(`missing configuration migration requirement ${pattern}`);
  }
}

for (const prohibited of [
  'credential',
  'password',
  'endpoint',
  'access_key',
  'secret_key',
  'connection_string',
  'signed_url',
  'raw_token',
]) {
  if (new RegExp(`^\\s*${prohibited}\\s+`, 'im').test(up)) {
    errors.push(`prohibited configuration column ${prohibited}`);
  }
}

if (/CREATE EXTENSION/i.test(up)) errors.push('configuration migration must not add extensions');
if (/INSERT INTO public\.storage_control_/i.test(up)) {
  errors.push('configuration migration must not seed runtime rows');
}
if (!/row_total <> 0/i.test(down)) {
  errors.push('configuration rollback must reject adopted rows');
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('client storage configuration migration static validation: passed');
}
