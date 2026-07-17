import { readFile } from 'node:fs/promises';

const baselineFile = 'db/migrations/0001_z_s_control_plane_foundation.sql';
const runtimeFile = 'db/migrations/0002_z_s_runtime_registry.sql';
const runtimeRollbackFile = 'db/migrations/0002_z_s_runtime_registry.down.sql';
const readDeliveryFile = 'db/migrations/0003_z_s_read_delivery.sql';
const readDeliveryRollbackFile = 'db/migrations/0003_z_s_read_delivery.down.sql';
const baselineSql = await readFile(baselineFile, 'utf8');
const runtimeSql = await readFile(runtimeFile, 'utf8');
const runtimeRollbackSql = await readFile(runtimeRollbackFile, 'utf8');
const readDeliverySql = await readFile(readDeliveryFile, 'utf8');
const readDeliveryRollbackSql = await readFile(readDeliveryRollbackFile, 'utf8');
const baselineReference =
  'z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02a-package-z-s-core-control-plane-and-provider-capability-baseline.md';
const runtimeReference =
  'z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02b-04-package-runtime-storage-registry-and-schema.md';
const readDeliveryReference =
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

const readDeliveryColumns = [
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

const prohibitedRuntimeColumns = [
  'credential', 'endpoint', 'account_id', 'connection_string', 'signed_url', 'object_key',
  'bearer_token', 'upload_completion_token', 'project_id', 'series_id', 'video_id', 'scene_id',
  'slot_id', 'user_id', 'title', 'prompt',
];
for (const prohibited of prohibitedRuntimeColumns) {
  if (new RegExp(`^\\s*${prohibited}\\s+`, 'im').test(runtimeSql)) {
    errors.push(`prohibited runtime column ${prohibited}`);
  }
}

const runtimeRequiredPatterns = [
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
for (const pattern of runtimeRequiredPatterns) {
  if (!pattern.test(`${runtimeSql}\n${runtimeRollbackSql}`)) {
    errors.push(`missing runtime migration requirement ${pattern}`);
  }
}

const runtimeIndexes = [
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
for (const index of runtimeIndexes) {
  if (!new RegExp(`CREATE (?:UNIQUE )?INDEX ${index}`, 'i').test(runtimeSql)) {
    errors.push(`missing runtime index ${index}`);
  }
}

if (!/CREATE TABLE public\.object_read_grants\s*\(/i.test(readDeliverySql)) {
  errors.push('missing read-delivery table object_read_grants');
}
const readTableComment = readDeliverySql.match(
  /COMMENT ON TABLE public\.object_read_grants IS\s*'([^']*)'/i,
);
if (!readTableComment) errors.push('missing read-delivery table comment');
else if (!readTableComment[1]?.includes(readDeliveryReference)) {
  errors.push('read-delivery table comment missing reference');
}
for (const column of readDeliveryColumns) {
  if (!new RegExp(`^\\s*${column}\\s+`, 'im').test(readDeliverySql)) {
    errors.push(`missing read-delivery column ${column}`);
  }
}

const readRequiredPatterns = [
  /2B-07 preflight missing baseline table/i,
  /2B-07 migration already applied/i,
  /migration owner mismatch/i,
  /storage_object_id uuid NOT NULL REFERENCES public\.storage_objects\(storage_object_id\) ON DELETE RESTRICT/i,
  /managed_app_id uuid NOT NULL REFERENCES public\.managed_apps\(id\) ON DELETE RESTRICT/i,
  /allowed_methods text\[\] NOT NULL/i,
  /allowed_methods <@ ARRAY\['HEAD', 'GET'\]::text\[\]/i,
  /read_grant_token_digest text NOT NULL CHECK \(read_grant_token_digest ~ '\^\[a-f0-9\]\{64\}\$'\)/i,
  /token_purpose = 'z-s-object-read-grant-v1'/i,
  /state IN \('active', 'revoked', 'expired'\)/i,
  /row_version integer NOT NULL DEFAULT 1 CHECK \(row_version > 0\)/i,
  /COMMENT ON COLUMN public\.object_read_grants\.%I/i,
  /2B-07 rollback blocked/i,
  /DROP TABLE public\.object_read_grants;/i,
];
for (const pattern of readRequiredPatterns) {
  if (!pattern.test(`${readDeliverySql}\n${readDeliveryRollbackSql}`)) {
    errors.push(`missing read-delivery migration requirement ${pattern}`);
  }
}

const readIndexes = [
  'object_read_grants_object_created_idx',
  'object_read_grants_caller_state_expiry_idx',
  'object_read_grants_state_expiry_idx',
];
for (const index of readIndexes) {
  if (!new RegExp(`CREATE INDEX ${index}`, 'i').test(readDeliverySql)) {
    errors.push(`missing read-delivery index ${index}`);
  }
}

for (const prohibited of [
  'read_grant_token', 'delivery_token', 'provider_id', 'provider_alias', 'bucket', 'endpoint',
  'internal_locator', 'object_key', 'credential_reference_id', 'signed_url',
]) {
  if (new RegExp(`^\\s*${prohibited}\\s+`, 'im').test(readDeliverySql)) {
    errors.push(`prohibited read-delivery column ${prohibited}`);
  }
}
if (/CREATE EXTENSION/i.test(`${runtimeSql}\n${readDeliverySql}`)) {
  errors.push('runtime migrations must not add PostgreSQL extensions');
}
if (/INSERT INTO public\.object_read_grants/i.test(readDeliverySql)) {
  errors.push('read-delivery migration must not seed grants');
}
if (!/row_total <> 0/i.test(readDeliveryRollbackSql)) {
  errors.push('read-delivery rollback must reject adopted rows');
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('migration static validation: passed');
}
