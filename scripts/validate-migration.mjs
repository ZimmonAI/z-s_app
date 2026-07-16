import { readFile } from 'node:fs/promises';

const baselineFile = 'db/migrations/0001_z_s_control_plane_foundation.sql';
const runtimeFile = 'db/migrations/0002_z_s_runtime_registry.sql';
const rollbackFile = 'db/migrations/0002_z_s_runtime_registry.down.sql';
const baselineSql = await readFile(baselineFile, 'utf8');
const runtimeSql = await readFile(runtimeFile, 'utf8');
const rollbackSql = await readFile(rollbackFile, 'utf8');
const baselineReference =
  'z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02a-package-z-s-core-control-plane-and-provider-capability-baseline.md';
const runtimeReference =
  'z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02b-04-package-runtime-storage-registry-and-schema.md';

const baselineTables = {
  managed_apps: ['id', 'app_id', 'environment', 'status', 'created_at', 'updated_at'],
  storage_providers: [
    'id',
    'provider_id',
    'provider_type',
    'status',
    'secret_reference_id',
    'created_at',
    'updated_at',
  ],
  storage_profiles: [
    'id',
    'managed_app_id',
    'profile_id',
    'version',
    'status',
    'effective_at',
    'retired_at',
    'created_at',
    'updated_at',
  ],
  storage_profile_provider_bindings: [
    'id',
    'storage_profile_id',
    'provider_role',
    'storage_provider_id',
    'bucket_label',
    'required',
    'created_at',
    'updated_at',
  ],
  storage_prefix_classes: [
    'id',
    'storage_profile_id',
    'prefix_class_id',
    'operation_class',
    'normalized_prefix_pattern',
    'status',
    'created_at',
    'updated_at',
  ],
  storage_capability_results: [
    'id',
    'capability_run_id',
    'storage_profile_id',
    'storage_provider_id',
    'bucket_label',
    'prefix_class_id',
    'capability',
    'result',
    'verified_at',
    'expires_at',
    'safe_evidence_ref',
    'created_at',
  ],
  storage_profile_audit_events: [
    'id',
    'event_type',
    'profile_id',
    'profile_version',
    'actor_role',
    'safe_change_summary',
    'created_at',
  ],
};

const runtimeTables = [
  'object_write_intents',
  'storage_objects',
  'storage_object_copies',
  'storage_provider_attempts',
  'storage_operation_events',
  'storage_reconciliation_issues',
  'storage_idempotency_records',
];

const errors = [];
for (const [table, columns] of Object.entries(baselineTables)) {
  if (!new RegExp(`CREATE TABLE public\\.${table}\\s*\\(`, 'i').test(baselineSql)) {
    errors.push(`missing baseline table ${table}`);
  }
  const tableComment = baselineSql.match(
    new RegExp(`COMMENT ON TABLE public\\.${table} IS '([^']*)'`, 'i'),
  );
  if (!tableComment) errors.push(`missing baseline table comment ${table}`);
  else if (!tableComment[1]?.includes(baselineReference)) {
    errors.push(`baseline table comment missing reference ${table}`);
  }
  for (const column of columns) {
    if (!new RegExp(`COMMENT ON COLUMN public\\.${table}\\.${column} IS '`, 'i').test(baselineSql)) {
      errors.push(`missing baseline column comment ${table}.${column}`);
    }
  }
}

for (const table of runtimeTables) {
  if (!new RegExp(`CREATE TABLE public\\.${table}\\s*\\(`, 'i').test(runtimeSql)) {
    errors.push(`missing runtime table ${table}`);
  }
  const tableComment = runtimeSql.match(
    new RegExp(`COMMENT ON TABLE public\\.${table} IS '([^']*)'`, 'i'),
  );
  if (!tableComment) errors.push(`missing runtime table comment ${table}`);
  else if (!tableComment[1]?.includes(runtimeReference)) {
    errors.push(`runtime table comment missing reference ${table}`);
  }
  if (!new RegExp(`DROP TABLE public\\.${table};`, 'i').test(rollbackSql)) {
    errors.push(`rollback missing runtime table ${table}`);
  }
}

const prohibitedColumns = [
  'credential',
  'endpoint',
  'account_id',
  'connection_string',
  'signed_url',
  'object_key',
  'bearer_token',
  'upload_completion_token',
  'project_id',
  'series_id',
  'video_id',
  'scene_id',
  'slot_id',
  'user_id',
  'title',
  'prompt',
];
for (const prohibited of prohibitedColumns) {
  if (new RegExp(`^\\s*${prohibited}\\s+`, 'im').test(runtimeSql)) {
    errors.push(`prohibited runtime column ${prohibited}`);
  }
}

const requiredPatterns = [
  /SET LOCAL lock_timeout = '5s'/i,
  /SET LOCAL statement_timeout = '60s'/i,
  /2B-04 preflight missing baseline table/i,
  /storage_object_id uuid NOT NULL UNIQUE REFERENCES public\.storage_objects/i,
  /UNIQUE \(storage_object_id, provider_role\)/i,
  /UNIQUE \(storage_object_copy_id, operation, operation_reference, attempt_number\)/i,
  /UNIQUE \(caller_app_id, caller_service_id, operation_scope, idempotency_key\)/i,
  /WHERE state IN \('open', 'acknowledged'\)/i,
  /expected_checksum_sha256 ~ '\^\[a-f0-9\]\{64\}\$'/i,
  /jsonb_typeof\(safe_technical_metadata\) = 'object'/i,
  /octet_length\(safe_payload::text\) <= 8192/i,
  /lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL/i,
  /claim_owner IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL/i,
  /storage_operation_events_append_only_trigger/i,
  /storage_provider_attempts_history_trigger/i,
  /COMMENT ON COLUMN public\.%I\.%I/i,
  /0002_z_s_runtime_registry\.down\.sql|2B-04 rollback blocked/i,
];
for (const pattern of requiredPatterns) {
  if (!pattern.test(`${runtimeSql}\n${rollbackSql}`)) {
    errors.push(`missing runtime migration requirement ${pattern}`);
  }
}

const requiredIndexes = [
  'object_write_intents_app_state_expiry_idx',
  'object_write_intents_correlation_created_idx',
  'storage_objects_correlation_created_idx',
  'storage_objects_state_stage_updated_idx',
  'storage_object_copies_object_role_idx',
  'storage_object_copies_state_updated_idx',
  'storage_provider_attempts_claim_idx',
  'storage_provider_attempts_history_idx',
  'storage_operation_events_object_occurred_idx',
  'storage_reconciliation_issues_claim_idx',
  'storage_reconciliation_issues_object_category_idx',
  'storage_reconciliation_issues_unresolved_fingerprint_idx',
  'storage_idempotency_records_lookup_idx',
  'storage_idempotency_records_expiry_idx',
];
for (const index of requiredIndexes) {
  if (!new RegExp(`CREATE (?:UNIQUE )?INDEX ${index}`, 'i').test(runtimeSql)) {
    errors.push(`missing runtime index ${index}`);
  }
}

if (/CREATE EXTENSION/i.test(runtimeSql)) {
  errors.push('runtime migration must not add PostgreSQL extensions');
}
if (/INSERT INTO public\.(?:object_write_intents|storage_objects|storage_object_copies|storage_provider_attempts|storage_operation_events|storage_reconciliation_issues|storage_idempotency_records)/i.test(runtimeSql)) {
  errors.push('runtime migration must not seed runtime rows');
}
if (!/row_total <> 0/i.test(rollbackSql)) {
  errors.push('rollback must reject adopted runtime rows');
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('migration static validation: passed');
}
