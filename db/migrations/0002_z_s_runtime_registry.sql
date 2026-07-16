BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  expected_table text;
BEGIN
  FOREACH expected_table IN ARRAY ARRAY[
    'managed_apps',
    'storage_providers',
    'storage_profiles',
    'storage_profile_provider_bindings',
    'storage_prefix_classes',
    'storage_capability_results',
    'storage_profile_audit_events'
  ]
  LOOP
    IF to_regclass(format('public.%I', expected_table)) IS NULL THEN
      RAISE EXCEPTION '2B-04 preflight missing baseline table public.%', expected_table;
    END IF;
  END LOOP;

  FOREACH expected_table IN ARRAY ARRAY[
    'object_write_intents',
    'storage_objects',
    'storage_object_copies',
    'storage_provider_attempts',
    'storage_operation_events',
    'storage_reconciliation_issues',
    'storage_idempotency_records'
  ]
  LOOP
    IF to_regclass(format('public.%I', expected_table)) IS NOT NULL THEN
      RAISE EXCEPTION '2B-04 migration already applied: public.% exists', expected_table;
    END IF;
  END LOOP;
END
$$;

CREATE TABLE public.storage_objects (
  storage_object_id uuid PRIMARY KEY,
  managed_app_id uuid NOT NULL REFERENCES public.managed_apps(id) ON DELETE RESTRICT,
  storage_profile_id uuid NOT NULL REFERENCES public.storage_profiles(id) ON DELETE RESTRICT,
  storage_profile_fingerprint text NOT NULL CHECK (char_length(storage_profile_fingerprint) BETWEEN 1 AND 128),
  storage_prefix_class_id uuid NOT NULL REFERENCES public.storage_prefix_classes(id) ON DELETE RESTRICT,
  app_correlation_ref text NOT NULL CHECK (char_length(app_correlation_ref) BETWEEN 1 AND 128),
  source_reference text NOT NULL CHECK (char_length(source_reference) BETWEEN 1 AND 256),
  registry_state text NOT NULL CHECK (registry_state IN ('reserved', 'active', 'degraded', 'delete_pending', 'deleted')),
  object_protection_stage text NOT NULL CHECK (object_protection_stage ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  expected_checksum_sha256 text NOT NULL CHECK (expected_checksum_sha256 ~ '^[a-f0-9]{64}$'),
  expected_byte_length bigint NOT NULL CHECK (expected_byte_length > 0),
  expected_content_type text NOT NULL CHECK (char_length(expected_content_type) BETWEEN 3 AND 160),
  verified_checksum_sha256 text NULL CHECK (verified_checksum_sha256 IS NULL OR verified_checksum_sha256 ~ '^[a-f0-9]{64}$'),
  verified_byte_length bigint NULL CHECK (verified_byte_length IS NULL OR verified_byte_length >= 0),
  safe_technical_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  activated_at timestamptz NULL,
  deletion_requested_at timestamptz NULL,
  deleted_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CHECK (jsonb_typeof(safe_technical_metadata) = 'object'),
  CHECK (octet_length(safe_technical_metadata::text) <= 8192),
  CHECK (NOT (safe_technical_metadata ?| ARRAY['credential', 'secret', 'endpoint', 'bucket', 'locator', 'object_key', 'signed_url', 'prompt', 'user_name', 'project_title', 'scene_title'])),
  CHECK ((registry_state = 'deleted') = (deleted_at IS NOT NULL)),
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.object_write_intents (
  object_write_intent_id uuid PRIMARY KEY,
  managed_app_id uuid NOT NULL REFERENCES public.managed_apps(id) ON DELETE RESTRICT,
  caller_service_id text NULL CHECK (caller_service_id IS NULL OR char_length(caller_service_id) BETWEEN 1 AND 96),
  storage_profile_id uuid NOT NULL REFERENCES public.storage_profiles(id) ON DELETE RESTRICT,
  storage_profile_fingerprint text NOT NULL CHECK (char_length(storage_profile_fingerprint) BETWEEN 1 AND 128),
  storage_prefix_class_id uuid NOT NULL REFERENCES public.storage_prefix_classes(id) ON DELETE RESTRICT,
  app_correlation_ref text NOT NULL CHECK (char_length(app_correlation_ref) BETWEEN 1 AND 128),
  source_reference text NOT NULL CHECK (char_length(source_reference) BETWEEN 1 AND 256),
  expected_content_type text NOT NULL CHECK (char_length(expected_content_type) BETWEEN 3 AND 160),
  expected_byte_length bigint NOT NULL CHECK (expected_byte_length > 0),
  expected_checksum_sha256 text NOT NULL CHECK (expected_checksum_sha256 ~ '^[a-f0-9]{64}$'),
  requested_object_protection_stage text NULL CHECK (
    requested_object_protection_stage IS NULL OR
    requested_object_protection_stage ~ '^[a-z0-9][a-z0-9-]{0,63}$'
  ),
  storage_object_id uuid NOT NULL UNIQUE REFERENCES public.storage_objects(storage_object_id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('accepted', 'uploading', 'completed', 'expired', 'cancelled', 'failed')),
  expires_at timestamptz NOT NULL,
  terminal_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CHECK (expires_at > created_at),
  CHECK ((state IN ('completed', 'expired', 'cancelled', 'failed')) = (terminal_at IS NOT NULL)),
  CHECK (terminal_at IS NULL OR terminal_at >= created_at),
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.storage_object_copies (
  storage_object_copy_id uuid PRIMARY KEY,
  storage_object_id uuid NOT NULL REFERENCES public.storage_objects(storage_object_id) ON DELETE RESTRICT,
  storage_profile_provider_binding_id uuid NOT NULL REFERENCES public.storage_profile_provider_bindings(id) ON DELETE RESTRICT,
  provider_role text NOT NULL CHECK (provider_role IN ('hot', 'canonical')),
  internal_locator text NOT NULL CHECK (char_length(internal_locator) BETWEEN 1 AND 1024),
  copy_state text NOT NULL CHECK (copy_state IN ('pending', 'verified', 'failed', 'missing', 'delete_pending', 'deleted')),
  observed_checksum_sha256 text NULL CHECK (observed_checksum_sha256 IS NULL OR observed_checksum_sha256 ~ '^[a-f0-9]{64}$'),
  observed_byte_length bigint NULL CHECK (observed_byte_length IS NULL OR observed_byte_length >= 0),
  latest_verified_at timestamptz NULL,
  absent_at timestamptz NULL,
  delete_requested_at timestamptz NULL,
  deleted_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (storage_object_id, provider_role),
  UNIQUE (storage_object_copy_id, storage_object_id),
  CHECK ((copy_state = 'deleted') = (deleted_at IS NOT NULL)),
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.storage_provider_attempts (
  storage_provider_attempt_id uuid PRIMARY KEY,
  storage_object_copy_id uuid NOT NULL,
  storage_object_id uuid NOT NULL REFERENCES public.storage_objects(storage_object_id) ON DELETE RESTRICT,
  FOREIGN KEY (storage_object_copy_id, storage_object_id)
    REFERENCES public.storage_object_copies(storage_object_copy_id, storage_object_id)
    ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN ('write', 'verify', 'read', 'delete', 'repair')),
  operation_reference text NOT NULL CHECK (char_length(operation_reference) BETWEEN 1 AND 128),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  state text NOT NULL CHECK (state IN ('pending', 'in_progress', 'succeeded', 'failed')),
  retryable boolean NOT NULL DEFAULT false,
  next_retry_at timestamptz NULL,
  lease_owner text NULL CHECK (lease_owner IS NULL OR char_length(lease_owner) BETWEEN 1 AND 128),
  lease_token text NULL CHECK (lease_token IS NULL OR char_length(lease_token) BETWEEN 32 AND 128),
  lease_expires_at timestamptz NULL,
  expected_checksum_sha256 text NULL CHECK (expected_checksum_sha256 IS NULL OR expected_checksum_sha256 ~ '^[a-f0-9]{64}$'),
  expected_byte_length bigint NULL CHECK (expected_byte_length IS NULL OR expected_byte_length >= 0),
  observed_checksum_sha256 text NULL CHECK (observed_checksum_sha256 IS NULL OR observed_checksum_sha256 ~ '^[a-f0-9]{64}$'),
  observed_byte_length bigint NULL CHECK (observed_byte_length IS NULL OR observed_byte_length >= 0),
  safe_diagnostic_category text NULL CHECK (safe_diagnostic_category IS NULL OR safe_diagnostic_category IN ('invalid-request', 'unauthenticated', 'unauthorized', 'incompatible-version', 'duplicate-conflict', 'not-ready', 'dependency-unavailable', 'internal')),
  safe_diagnostic_code text NULL CHECK (safe_diagnostic_code IS NULL OR safe_diagnostic_code ~ '^[a-z0-9][a-z0-9-]{0,95}$'),
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  verified_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (storage_object_copy_id, operation, operation_reference, attempt_number),
  CHECK (
    (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL) OR
    (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK ((state IN ('succeeded', 'failed')) = (finished_at IS NOT NULL)),
  CHECK (state <> 'in_progress' OR started_at IS NOT NULL),
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.storage_operation_events (
  storage_operation_event_id uuid PRIMARY KEY,
  dedupe_key text NOT NULL UNIQUE CHECK (char_length(dedupe_key) BETWEEN 1 AND 160),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z0-9][a-z0-9.-]{0,95}$'),
  contract_version text NOT NULL CHECK (contract_version ~ '^[0-9]+\.[0-9]+$'),
  occurred_at timestamptz NOT NULL,
  managed_app_id uuid NOT NULL REFERENCES public.managed_apps(id) ON DELETE RESTRICT,
  caller_service_id text NULL CHECK (caller_service_id IS NULL OR char_length(caller_service_id) BETWEEN 1 AND 96),
  storage_object_id uuid NULL REFERENCES public.storage_objects(storage_object_id) ON DELETE RESTRICT,
  app_correlation_ref text NOT NULL CHECK (char_length(app_correlation_ref) BETWEEN 1 AND 128),
  safe_payload jsonb NOT NULL,
  safe_diagnostic_category text NULL CHECK (safe_diagnostic_category IS NULL OR safe_diagnostic_category IN ('invalid-request', 'unauthenticated', 'unauthorized', 'incompatible-version', 'duplicate-conflict', 'not-ready', 'dependency-unavailable', 'internal')),
  safe_diagnostic_code text NULL CHECK (safe_diagnostic_code IS NULL OR safe_diagnostic_code ~ '^[a-z0-9][a-z0-9-]{0,95}$'),
  created_at timestamptz NOT NULL,
  CHECK (jsonb_typeof(safe_payload) = 'object'),
  CHECK (octet_length(safe_payload::text) <= 8192),
  CHECK (NOT (safe_payload ?| ARRAY['credential', 'secret', 'endpoint', 'bucket', 'locator', 'object_key', 'signed_url', 'bearer', 'prompt', 'user_name', 'project_title', 'scene_title']))
);

CREATE TABLE public.storage_reconciliation_issues (
  storage_reconciliation_issue_id uuid PRIMARY KEY,
  storage_object_id uuid NULL REFERENCES public.storage_objects(storage_object_id) ON DELETE RESTRICT,
  storage_object_copy_id uuid NULL REFERENCES public.storage_object_copies(storage_object_copy_id) ON DELETE RESTRICT,
  storage_provider_attempt_id uuid NULL REFERENCES public.storage_provider_attempts(storage_provider_attempt_id) ON DELETE RESTRICT,
  provider_role text NULL CHECK (provider_role IS NULL OR provider_role IN ('hot', 'canonical')),
  category text NOT NULL CHECK (category ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  summary_code text NOT NULL CHECK (summary_code ~ '^[a-z0-9][a-z0-9-]{0,95}$'),
  state text NOT NULL CHECK (state IN ('open', 'acknowledged', 'resolved')),
  safe_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  issue_fingerprint text NOT NULL CHECK (issue_fingerprint ~ '^[a-f0-9]{64}$'),
  first_detected_at timestamptz NOT NULL,
  last_detected_at timestamptz NOT NULL,
  next_retry_at timestamptz NULL,
  acknowledged_at timestamptz NULL,
  resolved_at timestamptz NULL,
  claim_owner text NULL CHECK (claim_owner IS NULL OR char_length(claim_owner) BETWEEN 1 AND 128),
  claim_token text NULL CHECK (claim_token IS NULL OR char_length(claim_token) BETWEEN 32 AND 128),
  claim_expires_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CHECK (jsonb_typeof(safe_detail) = 'object'),
  CHECK (octet_length(safe_detail::text) <= 8192),
  CHECK (NOT (safe_detail ?| ARRAY['credential', 'secret', 'endpoint', 'bucket', 'locator', 'object_key', 'signed_url', 'prompt', 'user_name', 'project_title', 'scene_title'])),
  CHECK (last_detected_at >= first_detected_at),
  CHECK (
    (claim_owner IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL) OR
    (claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
  ),
  CHECK ((state = 'resolved') = (resolved_at IS NOT NULL)),
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.storage_idempotency_records (
  id uuid PRIMARY KEY,
  caller_app_id text NOT NULL CHECK (char_length(caller_app_id) BETWEEN 1 AND 96),
  caller_service_id text NOT NULL DEFAULT '' CHECK (char_length(caller_service_id) <= 96),
  operation_scope text NOT NULL CHECK (operation_scope ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('in_progress', 'succeeded', 'failed')),
  result_kind text NULL CHECK (result_kind IS NULL OR result_kind ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  result_reference_id uuid NULL,
  result_storage_object_id uuid NULL REFERENCES public.storage_objects(storage_object_id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (caller_app_id, caller_service_id, operation_scope, idempotency_key),
  CHECK ((state = 'succeeded') = (result_kind IS NOT NULL AND result_reference_id IS NOT NULL)),
  CHECK (updated_at >= created_at)
);

CREATE INDEX object_write_intents_app_state_expiry_idx
  ON public.object_write_intents (managed_app_id, state, expires_at);
CREATE INDEX object_write_intents_correlation_created_idx
  ON public.object_write_intents (app_correlation_ref, created_at DESC);
CREATE INDEX storage_objects_correlation_created_idx
  ON public.storage_objects (app_correlation_ref, created_at DESC);
CREATE INDEX storage_objects_state_stage_updated_idx
  ON public.storage_objects (registry_state, object_protection_stage, updated_at);
CREATE INDEX storage_object_copies_object_role_idx
  ON public.storage_object_copies (storage_object_id, provider_role);
CREATE INDEX storage_object_copies_state_updated_idx
  ON public.storage_object_copies (copy_state, updated_at);
CREATE INDEX storage_provider_attempts_claim_idx
  ON public.storage_provider_attempts (state, next_retry_at, lease_expires_at, created_at);
CREATE INDEX storage_provider_attempts_history_idx
  ON public.storage_provider_attempts (storage_object_copy_id, operation, attempt_number DESC);
CREATE INDEX storage_operation_events_object_occurred_idx
  ON public.storage_operation_events (storage_object_id, occurred_at DESC);
CREATE INDEX storage_reconciliation_issues_claim_idx
  ON public.storage_reconciliation_issues (state, next_retry_at, claim_expires_at, first_detected_at);
CREATE INDEX storage_reconciliation_issues_object_category_idx
  ON public.storage_reconciliation_issues (storage_object_id, category, last_detected_at DESC);
CREATE UNIQUE INDEX storage_reconciliation_issues_unresolved_fingerprint_idx
  ON public.storage_reconciliation_issues (issue_fingerprint)
  WHERE state IN ('open', 'acknowledged');
CREATE INDEX storage_idempotency_records_lookup_idx
  ON public.storage_idempotency_records (
    caller_app_id, caller_service_id, operation_scope, idempotency_key
  );
CREATE INDEX storage_idempotency_records_expiry_idx
  ON public.storage_idempotency_records (expires_at);

CREATE FUNCTION public.z_s_runtime_reject_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'storage_operation_events is append-only';
END
$$;

CREATE TRIGGER storage_operation_events_append_only_trigger
BEFORE UPDATE OR DELETE ON public.storage_operation_events
FOR EACH ROW EXECUTE FUNCTION public.z_s_runtime_reject_event_mutation();

CREATE FUNCTION public.z_s_runtime_protect_provider_attempt_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'storage_provider_attempts history cannot be deleted';
  END IF;
  IF OLD.state IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'completed storage_provider_attempts rows are immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER storage_provider_attempts_history_trigger
BEFORE UPDATE OR DELETE ON public.storage_provider_attempts
FOR EACH ROW EXECUTE FUNCTION public.z_s_runtime_protect_provider_attempt_history();

COMMENT ON TABLE public.object_write_intents IS 'Durable object-write-intent state. Ref: z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02b-04-package-runtime-storage-registry-and-schema.md';
COMMENT ON TABLE public.storage_objects IS 'Provider-neutral storage-object identity and lifecycle truth. Ref: z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02b-04-package-runtime-storage-registry-and-schema.md';
COMMENT ON TABLE public.storage_object_copies IS 'Independent current hot and canonical copy truth. Ref: z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02b-04-package-runtime-storage-registry-and-schema.md';
COMMENT ON TABLE public.storage_provider_attempts IS 'Append-only provider-attempt history and claim state. Ref: z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02b-04-package-runtime-storage-registry-and-schema.md';
COMMENT ON TABLE public.storage_operation_events IS 'Append-only safe storage-event envelopes. Ref: z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02b-04-package-runtime-storage-registry-and-schema.md';
COMMENT ON TABLE public.storage_reconciliation_issues IS 'Claimable reconciliation-issue state. Ref: z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02b-04-package-runtime-storage-registry-and-schema.md';
COMMENT ON TABLE public.storage_idempotency_records IS 'Durable duplicate-protection reservations and stable result references. Ref: z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02b-04-package-runtime-storage-registry-and-schema.md';

DO $$
DECLARE
  column_record record;
  task_reference constant text := 'Ref: z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02b-04-package-runtime-storage-registry-and-schema.md';
BEGIN
  FOR column_record IN
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY(ARRAY[
         'object_write_intents',
         'storage_objects',
         'storage_object_copies',
         'storage_provider_attempts',
         'storage_operation_events',
         'storage_reconciliation_issues',
         'storage_idempotency_records'
       ])
  LOOP
    EXECUTE format(
      'COMMENT ON COLUMN public.%I.%I IS %L',
      column_record.table_name,
      column_record.column_name,
      format('Z-s runtime registry field. %s', task_reference)
    );
  END LOOP;
END
$$;

COMMIT;
