import { readFile } from 'node:fs/promises';

const file = 'db/migrations/0001_z_s_control_plane_foundation.sql';
const sql = await readFile(file, 'utf8');
const reference = 'z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02a-package-z-s-core-control-plane-and-provider-capability-baseline.md';
const tables = {
  managed_apps: ['id', 'app_id', 'environment', 'status', 'created_at', 'updated_at'],
  storage_providers: ['id', 'provider_id', 'provider_type', 'status', 'secret_reference_id', 'created_at', 'updated_at'],
  storage_profiles: ['id', 'managed_app_id', 'profile_id', 'version', 'status', 'effective_at', 'retired_at', 'created_at', 'updated_at'],
  storage_profile_provider_bindings: ['id', 'storage_profile_id', 'provider_role', 'storage_provider_id', 'bucket_label', 'required', 'created_at', 'updated_at'],
  storage_prefix_classes: ['id', 'storage_profile_id', 'prefix_class_id', 'operation_class', 'normalized_prefix_pattern', 'status', 'created_at', 'updated_at'],
  storage_capability_results: ['id', 'capability_run_id', 'storage_profile_id', 'storage_provider_id', 'bucket_label', 'prefix_class_id', 'capability', 'result', 'verified_at', 'expires_at', 'safe_evidence_ref', 'created_at'],
  storage_profile_audit_events: ['id', 'event_type', 'profile_id', 'profile_version', 'actor_role', 'safe_change_summary', 'created_at'],
};

const errors = [];
for (const [table, columns] of Object.entries(tables)) {
  if (!new RegExp(`CREATE TABLE public\\.${table}\\s*\\(`, 'i').test(sql)) {
    errors.push(`missing table ${table}`);
  }
  const tableComment = sql.match(new RegExp(`COMMENT ON TABLE public\\.${table} IS '([^']*)'`, 'i'));
  if (!tableComment) errors.push(`missing table comment ${table}`);
  else if (!tableComment[1]?.includes(reference)) errors.push(`table comment missing reference ${table}`);
  for (const column of columns) {
    if (!new RegExp(`COMMENT ON COLUMN public\\.${table}\\.${column} IS '`, 'i').test(sql)) {
      errors.push(`missing column comment ${table}.${column}`);
    }
  }
}

const prohibitedColumns = [
  'credential',
  'endpoint',
  'account_id',
  'connection_string',
  'token',
  'signed_url',
  'object_key',
];
for (const prohibited of prohibitedColumns) {
  const columnPattern = new RegExp(`^\\s*${prohibited}\\s+`, 'im');
  if (columnPattern.test(sql)) errors.push(`prohibited column ${prohibited}`);
}

const requiredPatterns = [
  /UNIQUE \(app_id, environment\)/i,
  /UNIQUE \(managed_app_id, profile_id, version\)/i,
  /UNIQUE \(storage_profile_id, provider_role\)/i,
  /UNIQUE \(storage_profile_id, prefix_class_id\)/i,
  /WHERE status = 'active'/i,
  /capability_run_id, storage_provider_id, prefix_class_id, capability/i,
];
for (const pattern of requiredPatterns) {
  if (!pattern.test(sql)) errors.push(`missing required constraint ${pattern}`);
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('migration static validation: passed');
}
