import { readFile } from 'node:fs/promises';

const upPath = 'db/migrations/0005_z_s_client_storage_configuration.sql';
const downPath = 'db/migrations/0005_z_s_client_storage_configuration.down.sql';
const cleanupUpPath = 'db/migrations/0006_z_s_configuration_audit_cleanup.sql';
const cleanupDownPath = 'db/migrations/0006_z_s_configuration_audit_cleanup.down.sql';
const childCleanupUpPath = 'db/migrations/0007_z_s_configuration_child_cleanup.sql';
const childCleanupDownPath = 'db/migrations/0007_z_s_configuration_child_cleanup.down.sql';
const auditNullificationUpPath = 'db/migrations/0008_z_s_configuration_audit_nullification.sql';
const auditNullificationDownPath = 'db/migrations/0008_z_s_configuration_audit_nullification.down.sql';
const childFkDeferralUpPath = 'db/migrations/0009_z_s_configuration_child_fk_deferral.sql';
const childFkDeferralDownPath = 'db/migrations/0009_z_s_configuration_child_fk_deferral.down.sql';
const up = await readFile(upPath, 'utf8');
const down = await readFile(downPath, 'utf8');
const cleanupUp = await readFile(cleanupUpPath, 'utf8');
const cleanupDown = await readFile(cleanupDownPath, 'utf8');
const childCleanupUp = await readFile(childCleanupUpPath, 'utf8');
const childCleanupDown = await readFile(childCleanupDownPath, 'utf8');
const auditNullificationUp = await readFile(auditNullificationUpPath, 'utf8');
const auditNullificationDown = await readFile(auditNullificationDownPath, 'utf8');
const childFkDeferralUp = await readFile(childFkDeferralUpPath, 'utf8');
const childFkDeferralDown = await readFile(childFkDeferralDownPath, 'utf8');
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
for (const pattern of [
  /DROP CONSTRAINT storage_control_configuration_aud_configuration_version_id_fkey/i,
  /DROP CONSTRAINT storage_control_configuration_audit_e_integration_token_id_fkey/i,
  /FOREIGN KEY \(configuration_version_id\)[\s\S]*ON DELETE SET NULL/i,
  /FOREIGN KEY \(integration_token_id\)[\s\S]*ON DELETE SET NULL/i,
  /Audit history survives draft cleanup/i,
  /Audit history survives integration-token metadata cleanup/i,
]) {
  if (!pattern.test(cleanupUp)) {
    errors.push(`missing configuration audit cleanup migration requirement ${pattern}`);
  }
}
for (const pattern of [
  /FOREIGN KEY \(configuration_version_id\)[\s\S]*ON DELETE RESTRICT/i,
  /FOREIGN KEY \(integration_token_id\)[\s\S]*ON DELETE RESTRICT/i,
]) {
  if (!pattern.test(cleanupDown)) {
    errors.push(`missing configuration audit cleanup rollback requirement ${pattern}`);
  }
}
for (const pattern of [
  /CREATE OR REPLACE FUNCTION public\.storage_control_configuration_child_guard\(\)/i,
  /version_state IS NULL AND TG_OP = 'DELETE'/i,
  /Allows draft-version cascade cleanup/i,
]) {
  if (!pattern.test(childCleanupUp)) {
    errors.push(`missing configuration child cleanup migration requirement ${pattern}`);
  }
}
if (/version_state IS NULL AND TG_OP = 'DELETE'/i.test(childCleanupDown)) {
  errors.push('configuration child cleanup rollback must restore strict guard');
}
for (const pattern of [
  /pg_trigger_depth\(\) > 1/i,
  /OLD\.configuration_version_id IS NOT NULL AND NEW\.configuration_version_id IS NULL/i,
  /OLD\.integration_token_id IS NOT NULL AND NEW\.integration_token_id IS NULL/i,
  /NEW\.safe_summary IS NOT DISTINCT FROM OLD\.safe_summary/i,
  /FK-triggered nullification/i,
]) {
  if (!pattern.test(auditNullificationUp)) {
    errors.push(`missing audit nullification migration requirement ${pattern}`);
  }
}
if (!/configuration audit events are append-only/i.test(auditNullificationDown)) {
  errors.push('audit nullification rollback must restore append-only rejection');
}
for (const pattern of [
  /DEFERRABLE INITIALLY DEFERRED/i,
  /whole-draft cleanup can delete all children atomically/i,
  /storage_control_configuratio_storage_control_client_id_co_fkey2/i,
  /storage_control_configuratio_storage_control_client_id_co_fkey4/i,
  /storage_control_configuratio_storage_control_client_id_co_fkey6/i,
]) {
  if (!pattern.test(childFkDeferralUp)) {
    errors.push(`missing child FK deferral migration requirement ${pattern}`);
  }
}
if (/DEFERRABLE INITIALLY DEFERRED/i.test(childFkDeferralDown)) {
  errors.push('child FK deferral rollback must restore immediate references');
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('client storage configuration migration static validation: passed');
}
