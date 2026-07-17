BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  expected_table text;
BEGIN
  FOREACH expected_table IN ARRAY ARRAY[
    'managed_apps',
    'storage_profiles',
    'storage_objects',
    'storage_object_copies',
    'storage_provider_attempts',
    'storage_operation_events',
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
  purpose text NOT NULL CHECK (
    purpose ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  allowed_methods text[] NOT NULL,
  range_allowed boolean NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('inline', 'attachment')),
  safe_file_name text NULL CHECK (
    safe_file_name IS NULL OR (
      char_length(safe_file_name) BETWEEN 1 AND 180 AND
      safe_file_name ~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,179}$' AND
      position('..' IN safe_file_name) = 0 AND
      position('/' IN safe_file_name) = 0 AND
      position(chr(92) IN safe_file_name) = 0
    )
  ),
  read_grant_token_digest text NOT NULL UNIQUE CHECK (
    read_grant_token_digest ~ '^[a-f0-9]{64}$'
  ),
  token_purpose text NOT NULL CHECK (token_purpose = 'object-read-grant'),
  state text NOT NULL CHECK (state IN ('active', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CHECK (
    allowed_methods = ARRAY['HEAD']::text[] OR
    allowed_methods = ARRAY['GET']::text[] OR
    allowed_methods = ARRAY['HEAD', 'GET']::text[]
  ),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (updated_at >= created_at)
);

CREATE INDEX object_read_grants_scope_object_state_idx
  ON public.object_read_grants (managed_app_id, caller_service_id, storage_object_id, state);
CREATE INDEX object_read_grants_scope_expiry_idx
  ON public.object_read_grants (managed_app_id, caller_service_id, state, expires_at);
CREATE INDEX object_read_grants_active_expiry_idx
  ON public.object_read_grants (expires_at)
  WHERE state = 'active';
CREATE INDEX object_read_grants_object_created_idx
  ON public.object_read_grants (storage_object_id, created_at DESC);

COMMENT ON TABLE public.object_read_grants IS 'Durable short-lived object read grants with digest-only token persistence. Ref: z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02b-07-package-read-grant-delivery-fallback-and-range.md';

DO $$
DECLARE
  column_record record;
  task_reference constant text := 'Ref: z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02b-07-package-read-grant-delivery-fallback-and-range.md';
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
      format('Z-s read-grant field. %s', task_reference)
    );
  END LOOP;
END
$$;

COMMIT;
