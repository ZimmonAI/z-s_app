BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  expected_table text;
  expected_owner text;
BEGIN
  FOREACH expected_table IN ARRAY ARRAY[
    'managed_apps',
    'storage_providers',
    'storage_profiles',
    'storage_profile_provider_bindings',
    'storage_prefix_classes',
    'storage_capability_results',
    'storage_profile_audit_events',
    'object_write_intents',
    'storage_objects',
    'storage_object_copies',
    'storage_provider_attempts',
    'storage_operation_events',
    'storage_reconciliation_issues',
    'storage_idempotency_records'
  ]
  LOOP
    IF to_regclass(format('public.%I', expected_table)) IS NULL THEN
      RAISE EXCEPTION '2B-07 preflight missing baseline table public.%', expected_table;
    END IF;
  END LOOP;

  IF to_regclass('public.object_read_grants') IS NOT NULL THEN
    RAISE EXCEPTION '2B-07 migration already applied: public.object_read_grants exists';
  END IF;

  SELECT tableowner
    INTO expected_owner
    FROM pg_catalog.pg_tables
   WHERE schemaname = 'public'
     AND tablename = 'storage_objects';
  IF expected_owner IS NULL OR expected_owner <> current_user THEN
    RAISE EXCEPTION '2B-07 migration owner mismatch: storage_objects owner %, current user %',
      COALESCE(expected_owner, '<missing>'), current_user;
  END IF;
END
$$;

CREATE TABLE public.object_read_grants (
  object_read_grant_id uuid PRIMARY KEY,
  storage_object_id uuid NOT NULL REFERENCES public.storage_objects(storage_object_id) ON DELETE RESTRICT,
  managed_app_id uuid NOT NULL REFERENCES public.managed_apps(id) ON DELETE RESTRICT,
  caller_service_id text NULL CHECK (
    caller_service_id IS NULL OR char_length(caller_service_id) BETWEEN 1 AND 96
  ),
  app_correlation_ref text NOT NULL CHECK (char_length(app_correlation_ref) BETWEEN 1 AND 128),
  business_authorization_ref text NOT NULL CHECK (
    char_length(business_authorization_ref) BETWEEN 1 AND 256 AND
    business_authorization_ref !~ '[[:cntrl:]]'
  ),
  purpose text NOT NULL CHECK (purpose ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'),
  allowed_methods text[] NOT NULL CHECK (
    cardinality(allowed_methods) BETWEEN 1 AND 2 AND
    allowed_methods <@ ARRAY['HEAD', 'GET']::text[] AND
    (cardinality(allowed_methods) = 1 OR allowed_methods[1] <> allowed_methods[2])
  ),
  range_allowed boolean NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('inline', 'attachment')),
  safe_file_name text NULL CHECK (
    safe_file_name IS NULL OR (
      char_length(safe_file_name) BETWEEN 1 AND 180 AND
      safe_file_name !~ '[[:cntrl:]/\\";]' AND
      safe_file_name !~ '^\.' AND
      safe_file_name !~ '\.$' AND
      safe_file_name !~ '[[:space:]]{2,}'
    )
  ),
  read_grant_token_digest text NOT NULL CHECK (read_grant_token_digest ~ '^[a-f0-9]{64}$'),
  token_purpose text NOT NULL CHECK (token_purpose = 'z-s-object-read-grant-v1'),
  state text NOT NULL CHECK (state IN ('active', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CHECK (expires_at > created_at),
  CHECK (
    (state = 'revoked' AND revoked_at IS NOT NULL) OR
    (state IN ('active', 'expired') AND revoked_at IS NULL)
  ),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (updated_at >= created_at)
);

CREATE INDEX object_read_grants_object_created_idx
  ON public.object_read_grants (storage_object_id, created_at DESC);
CREATE INDEX object_read_grants_caller_state_expiry_idx
  ON public.object_read_grants (managed_app_id, caller_service_id, state, expires_at);
CREATE INDEX object_read_grants_state_expiry_idx
  ON public.object_read_grants (state, expires_at);

COMMENT ON TABLE public.object_read_grants IS
  'Durable short-lived object-read grant state with digest-only token persistence. Ref: z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02b-07-package-read-grant-delivery-fallback-and-range.md';

DO $$
DECLARE
  column_record record;
  task_reference constant text :=
    'Ref: z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02b-07-package-read-grant-delivery-fallback-and-range.md';
BEGIN
  FOR column_record IN
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'object_read_grants'
  LOOP
    EXECUTE format(
      'COMMENT ON COLUMN public.object_read_grants.%I IS %L',
      column_record.column_name,
      format('Z-s read-grant registry field. %s', task_reference)
    );
  END LOOP;
END
$$;

COMMIT;
