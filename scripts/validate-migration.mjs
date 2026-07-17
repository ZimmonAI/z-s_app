import { readFile } from 'node:fs/promises';

const baselineFile = 'db/migrations/0001_z_s_control_plane_foundation.sql';
const runtimeFile = 'db/migrations/0002_z_s_runtime_registry.sql';
const runtimeRollbackFile = 'db/migrations/0002_z_s_runtime_registry.down.sql';
const readFilePath = 'db/migrations/0003_z_s_read_delivery.sql';
const readRollbackFile = 'db/migrations/0003_z_s_read_delivery.down.sql';
const baselineSql = await readFile(baselineFile, 'utf8');
const runtimeSql = await readFile(runtimeFile, 'utf8');
const runtimeRollbackSql = await readFile(runtimeRollbackFile, 'utf8');
const readSql = await readFile(readFilePath, 'utf8');
const readRollbackSql = await readFile(readRollbackFile, 'utf8');
const baselineReference =
  'z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02a-package-z-s-core-control-plane-and-provider-capability-baseline.md';
const runtimeReference =
  'z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02b-04-package-runtime-storage-registry-and-schema.md';
const readReference =
  'z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02b-07-package-read-grant-delivery-fallback-and-range.md';

const baselineTables = {
  managed_apps: ['id', 'app_id', 'environment', 'status', 'created_at', 'updated_at'],
  storage_providers: [
    'id', 'provider_id', 'provider_type', 'status', 'secret_reference_id', 'created_at', 'updated_at',
  ],
  storage_profiles: [
    'id', 'managed_app_id', 'profile_id', 'version', 'status', 'effective_at', 'retired_at',
    'created_at', 'updated_at',
  ],
  storage_profile_provider_bindings: [
    'id', 'storage_profile_id', 'provider_role', 'storage_provider_id', 'bucket_label', 'required',
    'created_at', 'updated_at',
  ],
  storage_prefix_classes: [
    'id', 'storage_profile_id', 'prefix_class_id', 'operation_class',
    'normalized_prefix_pattern', 'status', 'created_at', 'updated_at',
  ],
  storage_capability_results: [
    'id', 'capability_run_id', 'storage_profile_id', 'storage_provider_id', 'bucket_label',
    'prefix_class_id', 'capability', 'result', 'verified_at', 'expires_at', 'safe_evidence_ref',
    'created_at',
  ],
  storage_profile_audit_events: [
    'id', 'event_type', 'profile_id', 'profile_version', 'actor_role', 'safe_change_summary',
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
const readColumns = [
  'object_read_grant_id',
  'storage_object_id',
  'managed_app_id',
  'caller_service_id',
  'app_correlation_ref',
  'business_authorization_ref',
  'purpose',
  'allowed_methods',
  'range_allowed',
  'disposition',
  'safe_file_name',
  'read_grant_token_digest',
  'token_purpose',
  'state',
  'expires_at',
  'revoked_at',
  'created_at',
  'updated_at',
  'row_version',
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
  if (!new RegExp(`DROP TABLE public\\.${table};`, 'i').test(runtimeRollbackSql)) {
    errors.push(`rollback missing runtime table ${table}`);
  }
}

if (!/CREATE TABLE public\.object_read_grants\s*\(/i.test(readSql)) {
  errors.push('missing read-grant table object_read_grants');
}
const readTableComment = readSql.match(
  /COMMENT ON TABLE public\.object_read_grants IS '([^']*)'/i,
);
if (!readTableComment) errors.push('missing read-grant table comment');
else if (!readTableComment[1]?.includes(readReference)) {
  errors.push('read-grant table comment missing task reference');
}
for (const column of readColumns) {
  if (!new RegExp(`^\\s*${column}\\s+`, 'im').test(readSql)) {
    errors.push(`missing read-grant column ${column}`);
  }
}
if (!/COMMENT ON COLUMN public\.object_read_grants\.%I IS %L/i.test(readSql)) {
  errors.push('missing generated read-grant column comments');
}
if (!/DROP TABLE public\.object_read_grants;/i.test(readRollbackSql)) {
  errors.push('read rollback missing object_read_grants');
}

const prohibitedColumns = [
  'credential', 'endpoint', 'account_id', 'connection_string', 'signed_url', 'object_key',
  'bearer_token', 'upload_completion_token', 'read_grant_token', 'project_id', 'series_id',
  'video_id', 'scene_id', 'slot_id', 'user_id', 'title', 'prompt',
];
for (const prohibited of prohibitedColumns) {
  if (new RegExp(`^\\s*${prohibited}\\s+`, 'im').test(`${runtimeSql}\n${readSql}`)) {
    errors.push(`prohibited runtime column ${prohibited}`);
  }
}

const requiredRuntimePatterns = [
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
for (const pattern of requiredRuntimePatterns) {
  if (!pattern.test(`${runtimeSql}\n${runtimeRollbackSql}`)) {
    errors.push(`missing runtime migration requirement ${pattern}`);
  }
}

const requiredReadPatterns = [
  /2B-07 preflight missing baseline table/i,
  /read_grant_token_digest text NOT NULL UNIQUE/i,
  /read_grant_token_digest ~ '\^\[a-f0-9\]\{64\}\$'/i,
  /token_purpose = 'object-read-grant'/i,
  /state IN \('active', 'revoked', 'expired'\)/i,
  /allowed_methods = ARRAY\['HEAD', 'GET'\]::text\[\]/i,
  /range_allowed boolean NOT NULL/i,
  /disposition IN \('inline', 'attachment'\)/i,
  /expires_at > created_at/i,
  /2B-07 rollback blocked/i,
];
for (const pattern of requiredReadPatterns) {
  if (!pattern.test(`${readSql}\n${readRollbackSql}`)) {
    errors.push(`missing read migration requirement ${pattern}`);
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
for (const index of [
  'object_read_grants_scope_object_state_idx',
  'object_read_grants_scope_expiry_idx',
  'object_read_grants_active_expiry_idx',
  'object_read_grants_object_created_idx',
]) {
  if (!new RegExp(`CREATE (?:UNIQUE )?INDEX ${index}`, 'i').test(readSql)) {
    errors.push(`missing read-grant index ${index}`);
  }
}

if (/CREATE EXTENSION/i.test(`${runtimeSql}\n${readSql}`)) {
  errors.push('runtime migrations must not add PostgreSQL extensions');
}
if (/INSERT INTO public\.(?:object_write_intents|storage_objects|storage_object_copies|storage_provider_attempts|storage_operation_events|storage_reconciliation_issues|storage_idempotency_records|object_read_grants)/i.test(`${runtimeSql}\n${readSql}`)) {
  errors.push('runtime migrations must not seed runtime rows');
}
if (!/row_total <> 0/i.test(runtimeRollbackSql) || !/row_total <> 0/i.test(readRollbackSql)) {
  errors.push('rollbacks must reject adopted runtime rows');
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('migration static validation: passed');
}
