BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  expected_table text;
BEGIN
  FOREACH expected_table IN ARRAY ARRAY[
    'storage_control_clients',
    'storage_control_vaults',
    'storage_control_route_rules',
    'storage_control_image_derivative_rules',
    'storage_control_client_tokens'
  ]
  LOOP
    IF to_regclass(format('public.%I', expected_table)) IS NULL THEN
      RAISE EXCEPTION '0005 preflight missing 0004 table public.%', expected_table;
    END IF;
  END LOOP;

  FOREACH expected_table IN ARRAY ARRAY[
    'storage_control_provider_connections',
    'storage_control_configuration_versions',
    'storage_control_configuration_vaults',
    'storage_control_configuration_image_presets',
    'storage_control_configuration_routes',
    'storage_control_configuration_route_targets',
    'storage_control_integration_tokens',
    'storage_control_configuration_audit_events'
  ]
  LOOP
    IF to_regclass(format('public.%I', expected_table)) IS NOT NULL THEN
      RAISE EXCEPTION '0005 migration already applied: public.% exists', expected_table;
    END IF;
  END LOOP;
END
$$;

CREATE TABLE public.storage_control_provider_connections (
  id uuid PRIMARY KEY,
  storage_control_client_id uuid NOT NULL REFERENCES public.storage_control_clients(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('dev', 'staging', 'prod')),
  connection_id text NOT NULL CHECK (connection_id ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  display_label text NOT NULL CHECK (char_length(display_label) BETWEEN 1 AND 160),
  provider_type text NOT NULL CHECK (provider_type IN ('minio', 'r2', 's3-compatible')),
  secret_reference_id text NOT NULL CHECK (secret_reference_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_control_client_id, environment, connection_id),
  UNIQUE (storage_control_client_id, id),
  CHECK (jsonb_typeof(safe_metadata) = 'object'),
  CHECK (octet_length(safe_metadata::text) <= 4096),
  CHECK (NOT safe_metadata ?| ARRAY[
    'credential', 'credentials', 'secret', 'token', 'password', 'endpoint',
    'access_key', 'secret_key', 'private_key', 'connection_string', 'signed_url'
  ]),
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.storage_control_configuration_versions (
  id uuid PRIMARY KEY,
  storage_control_client_id uuid NOT NULL REFERENCES public.storage_control_clients(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('dev', 'staging', 'prod')),
  version_number integer NOT NULL CHECK (version_number > 0),
  state text NOT NULL CHECK (state IN ('draft', 'active', 'superseded')),
  validation_state text NOT NULL CHECK (validation_state IN ('unvalidated', 'valid', 'invalid')),
  safe_validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  cloned_from_configuration_version_id uuid NULL REFERENCES public.storage_control_configuration_versions(id) ON DELETE RESTRICT,
  activated_at timestamptz NULL,
  superseded_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_control_client_id, environment, version_number),
  UNIQUE (storage_control_client_id, id),
  CHECK (jsonb_typeof(safe_validation_errors) = 'array'),
  CHECK (jsonb_array_length(safe_validation_errors) <= 32),
  CHECK (octet_length(safe_validation_errors::text) <= 8192),
  CHECK (cloned_from_configuration_version_id IS NULL OR cloned_from_configuration_version_id <> id),
  CHECK (
    (state = 'draft' AND activated_at IS NULL AND superseded_at IS NULL)
    OR (state = 'active' AND validation_state = 'valid' AND activated_at IS NOT NULL AND superseded_at IS NULL)
    OR (state = 'superseded' AND validation_state = 'valid' AND activated_at IS NOT NULL AND superseded_at IS NOT NULL)
  ),
  CHECK (updated_at >= created_at),
  CHECK (activated_at IS NULL OR activated_at >= created_at),
  CHECK (superseded_at IS NULL OR superseded_at >= activated_at)
);

CREATE UNIQUE INDEX storage_control_configuration_versions_one_active_idx
  ON public.storage_control_configuration_versions (storage_control_client_id, environment)
  WHERE state = 'active';
CREATE INDEX storage_control_configuration_versions_client_state_idx
  ON public.storage_control_configuration_versions (
    storage_control_client_id, environment, state, version_number DESC
  );

CREATE TABLE public.storage_control_configuration_vaults (
  id uuid PRIMARY KEY,
  storage_control_client_id uuid NOT NULL,
  configuration_version_id uuid NOT NULL,
  vault_id text NOT NULL CHECK (vault_id ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  provider_connection_id uuid NOT NULL,
  display_label text NOT NULL CHECK (char_length(display_label) BETWEEN 1 AND 160),
  purpose text NOT NULL CHECK (purpose IN ('originals', 'hot-copy', 'derivatives', 'archive', 'custom')),
  bucket_label text NOT NULL CHECK (
    char_length(bucket_label) BETWEEN 1 AND 255
    AND bucket_label = lower(bucket_label)
    AND bucket_label !~ '[[:space:]]'
  ),
  prefix_template text NOT NULL CHECK (
    char_length(prefix_template) BETWEEN 2 AND 512
    AND prefix_template LIKE '%/*'
    AND prefix_template !~ '(^/|\\|\.\.)'
  ),
  retention_mode text NOT NULL CHECK (retention_mode IN ('permanent', 'delete-after-days')),
  delete_after_days integer NULL CHECK (delete_after_days IS NULL OR delete_after_days BETWEEN 1 AND 36500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (configuration_version_id, vault_id),
  UNIQUE (storage_control_client_id, configuration_version_id, id),
  FOREIGN KEY (storage_control_client_id, configuration_version_id)
    REFERENCES public.storage_control_configuration_versions(storage_control_client_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (storage_control_client_id, provider_connection_id)
    REFERENCES public.storage_control_provider_connections(storage_control_client_id, id)
    ON DELETE RESTRICT,
  CHECK (
    (retention_mode = 'permanent' AND delete_after_days IS NULL)
    OR (retention_mode = 'delete-after-days' AND delete_after_days IS NOT NULL)
  ),
  CHECK (updated_at >= created_at)
);

CREATE INDEX storage_control_configuration_vaults_version_idx
  ON public.storage_control_configuration_vaults (configuration_version_id, vault_id);

CREATE TABLE public.storage_control_configuration_image_presets (
  id uuid PRIMARY KEY,
  storage_control_client_id uuid NOT NULL,
  configuration_version_id uuid NOT NULL,
  preset_id text NOT NULL CHECK (preset_id ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  target_vault_id uuid NOT NULL,
  resize_widths jsonb NOT NULL,
  output_format text NOT NULL CHECK (output_format IN ('webp', 'avif', 'jpeg', 'png')),
  quality smallint NOT NULL CHECK (quality BETWEEN 1 AND 100),
  fit_mode text NOT NULL CHECK (fit_mode IN ('inside', 'cover', 'contain', 'fill')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (configuration_version_id, preset_id),
  UNIQUE (storage_control_client_id, configuration_version_id, id),
  FOREIGN KEY (storage_control_client_id, configuration_version_id)
    REFERENCES public.storage_control_configuration_versions(storage_control_client_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (storage_control_client_id, configuration_version_id, target_vault_id)
    REFERENCES public.storage_control_configuration_vaults(
      storage_control_client_id, configuration_version_id, id
    ) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(resize_widths) = 'array'),
  CHECK (jsonb_array_length(resize_widths) BETWEEN 1 AND 8),
  CHECK (octet_length(resize_widths::text) <= 256),
  CHECK (updated_at >= created_at)
);

CREATE INDEX storage_control_configuration_image_presets_version_idx
  ON public.storage_control_configuration_image_presets (configuration_version_id, preset_id);

CREATE TABLE public.storage_control_configuration_routes (
  id uuid PRIMARY KEY,
  storage_control_client_id uuid NOT NULL,
  configuration_version_id uuid NOT NULL,
  route_id text NOT NULL CHECK (route_id ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  asset_class text NOT NULL CHECK (asset_class IN ('image', 'video', 'document')),
  image_preset_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (configuration_version_id, route_id),
  UNIQUE (configuration_version_id, asset_class),
  UNIQUE (storage_control_client_id, configuration_version_id, id),
  FOREIGN KEY (storage_control_client_id, configuration_version_id)
    REFERENCES public.storage_control_configuration_versions(storage_control_client_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (storage_control_client_id, configuration_version_id, image_preset_id)
    REFERENCES public.storage_control_configuration_image_presets(
      storage_control_client_id, configuration_version_id, id
    ) ON DELETE RESTRICT,
  CHECK (asset_class = 'image' OR image_preset_id IS NULL),
  CHECK (updated_at >= created_at)
);

CREATE INDEX storage_control_configuration_routes_version_idx
  ON public.storage_control_configuration_routes (configuration_version_id, asset_class);

CREATE TABLE public.storage_control_configuration_route_targets (
  id uuid PRIMARY KEY,
  storage_control_client_id uuid NOT NULL,
  configuration_version_id uuid NOT NULL,
  configuration_route_id uuid NOT NULL,
  vault_id uuid NOT NULL,
  target_role text NOT NULL CHECK (target_role IN ('primary', 'replica')),
  target_order smallint NOT NULL CHECK (target_order BETWEEN 0 AND 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (configuration_route_id, target_role, target_order),
  UNIQUE (configuration_route_id, vault_id),
  FOREIGN KEY (storage_control_client_id, configuration_version_id, configuration_route_id)
    REFERENCES public.storage_control_configuration_routes(
      storage_control_client_id, configuration_version_id, id
    ) ON DELETE CASCADE,
  FOREIGN KEY (storage_control_client_id, configuration_version_id, vault_id)
    REFERENCES public.storage_control_configuration_vaults(
      storage_control_client_id, configuration_version_id, id
    ) ON DELETE RESTRICT,
  CHECK (
    (target_role = 'primary' AND target_order = 0)
    OR (target_role = 'replica' AND target_order > 0)
  )
);

CREATE UNIQUE INDEX storage_control_configuration_route_targets_primary_idx
  ON public.storage_control_configuration_route_targets (configuration_route_id)
  WHERE target_role = 'primary';
CREATE INDEX storage_control_configuration_route_targets_route_idx
  ON public.storage_control_configuration_route_targets (
    configuration_route_id, target_role, target_order
  );

CREATE TABLE public.storage_control_integration_tokens (
  id uuid PRIMARY KEY,
  storage_control_client_id uuid NOT NULL REFERENCES public.storage_control_clients(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('dev', 'staging', 'prod')),
  token_id text NOT NULL CHECK (token_id ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  display_label text NOT NULL CHECK (char_length(display_label) BETWEEN 1 AND 160),
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  scopes text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at timestamptz NULL,
  revoked_at timestamptz NULL,
  rotated_from_integration_token_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_control_client_id, environment, token_id),
  UNIQUE (storage_control_client_id, id),
  FOREIGN KEY (storage_control_client_id, rotated_from_integration_token_id)
    REFERENCES public.storage_control_integration_tokens(storage_control_client_id, id)
    ON DELETE RESTRICT,
  CHECK (cardinality(scopes) BETWEEN 1 AND 8),
  CHECK (scopes <@ ARRAY['object:write', 'object:read', 'object:manage']::text[]),
  CHECK (array_position(scopes, NULL) IS NULL),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (rotated_from_integration_token_id IS NULL OR rotated_from_integration_token_id <> id),
  CHECK (updated_at >= created_at)
);

CREATE INDEX storage_control_integration_tokens_client_state_idx
  ON public.storage_control_integration_tokens (
    storage_control_client_id, environment, status, expires_at
  );

CREATE TABLE public.storage_control_configuration_audit_events (
  id uuid PRIMARY KEY,
  storage_control_client_id uuid NOT NULL REFERENCES public.storage_control_clients(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('dev', 'staging', 'prod')),
  configuration_version_id uuid NULL REFERENCES public.storage_control_configuration_versions(id) ON DELETE RESTRICT,
  integration_token_id uuid NULL REFERENCES public.storage_control_integration_tokens(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('client-browser', 'system')),
  actor_reference text NOT NULL CHECK (char_length(actor_reference) BETWEEN 1 AND 160),
  safe_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(safe_summary) = 'object'),
  CHECK (octet_length(safe_summary::text) <= 4096),
  CHECK (NOT safe_summary ?| ARRAY[
    'credential', 'credentials', 'secret', 'token', 'password', 'endpoint',
    'access_key', 'secret_key', 'private_key', 'connection_string', 'signed_url'
  ])
);

CREATE INDEX storage_control_configuration_audit_client_time_idx
  ON public.storage_control_configuration_audit_events (
    storage_control_client_id, environment, occurred_at DESC
  );
CREATE INDEX storage_control_configuration_audit_version_idx
  ON public.storage_control_configuration_audit_events (
    configuration_version_id, occurred_at DESC
  ) WHERE configuration_version_id IS NOT NULL;

CREATE FUNCTION public.storage_control_configuration_version_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'draft' THEN
      RAISE EXCEPTION '0005 immutable configuration version cannot be deleted: %', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.state = 'superseded' THEN
    RAISE EXCEPTION '0005 immutable superseded configuration version cannot be updated: %', OLD.id;
  END IF;

  IF OLD.state = 'active' THEN
    IF NEW.state <> 'superseded'
       OR NEW.storage_control_client_id IS DISTINCT FROM OLD.storage_control_client_id
       OR NEW.environment IS DISTINCT FROM OLD.environment
       OR NEW.version_number IS DISTINCT FROM OLD.version_number
       OR NEW.validation_state IS DISTINCT FROM OLD.validation_state
       OR NEW.safe_validation_errors IS DISTINCT FROM OLD.safe_validation_errors
       OR NEW.cloned_from_configuration_version_id IS DISTINCT FROM OLD.cloned_from_configuration_version_id
       OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.superseded_at IS NULL THEN
      RAISE EXCEPTION '0005 active configuration version is immutable except supersede transition: %', OLD.id;
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER storage_control_configuration_version_guard_trigger
BEFORE UPDATE OR DELETE ON public.storage_control_configuration_versions
FOR EACH ROW EXECUTE FUNCTION public.storage_control_configuration_version_guard();

CREATE FUNCTION public.storage_control_configuration_child_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  version_id uuid;
  client_id uuid;
  version_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    version_id := OLD.configuration_version_id;
    client_id := OLD.storage_control_client_id;
  ELSE
    version_id := NEW.configuration_version_id;
    client_id := NEW.storage_control_client_id;
  END IF;

  SELECT state
    INTO version_state
    FROM public.storage_control_configuration_versions
   WHERE id = version_id
     AND storage_control_client_id = client_id;

  IF version_state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION '0005 configuration children are mutable only while the version is draft: %', version_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER storage_control_configuration_vault_guard_trigger
BEFORE INSERT OR UPDATE OR DELETE ON public.storage_control_configuration_vaults
FOR EACH ROW EXECUTE FUNCTION public.storage_control_configuration_child_guard();
CREATE TRIGGER storage_control_configuration_image_preset_guard_trigger
BEFORE INSERT OR UPDATE OR DELETE ON public.storage_control_configuration_image_presets
FOR EACH ROW EXECUTE FUNCTION public.storage_control_configuration_child_guard();
CREATE TRIGGER storage_control_configuration_route_guard_trigger
BEFORE INSERT OR UPDATE OR DELETE ON public.storage_control_configuration_routes
FOR EACH ROW EXECUTE FUNCTION public.storage_control_configuration_child_guard();
CREATE TRIGGER storage_control_configuration_route_target_guard_trigger
BEFORE INSERT OR UPDATE OR DELETE ON public.storage_control_configuration_route_targets
FOR EACH ROW EXECUTE FUNCTION public.storage_control_configuration_child_guard();

CREATE FUNCTION public.storage_control_configuration_audit_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '0005 configuration audit events are append-only';
END
$$;

CREATE TRIGGER storage_control_configuration_audit_append_only_trigger
BEFORE UPDATE OR DELETE ON public.storage_control_configuration_audit_events
FOR EACH ROW EXECUTE FUNCTION public.storage_control_configuration_audit_append_only();

COMMENT ON TABLE public.storage_control_provider_connections IS 'Client-owned provider connection references containing safe metadata and secret-reference identity only. Ref: z-kn/08-execution/z-s_app-mvp/tasks/planning/t2-client-storage-workspace/handoffs/01-online-configuration-platform-coding.md';
COMMENT ON TABLE public.storage_control_configuration_versions IS 'Versioned client storage configurations with one immutable active version per client and environment. Ref: z-kn/08-execution/z-s_app-mvp/tasks/planning/t2-client-storage-workspace/handoffs/01-online-configuration-platform-coding.md';
COMMENT ON TABLE public.storage_control_configuration_vaults IS 'Version-owned provider-neutral vault definitions. Ref: z-kn/08-execution/z-s_app-mvp/tasks/planning/t2-client-storage-workspace/handoffs/01-online-configuration-platform-coding.md';
COMMENT ON TABLE public.storage_control_configuration_image_presets IS 'Version-owned image derivative presets without image execution authority. Ref: z-kn/08-execution/z-s_app-mvp/tasks/planning/t2-client-storage-workspace/handoffs/01-online-configuration-platform-coding.md';
COMMENT ON TABLE public.storage_control_configuration_routes IS 'Version-owned asset-class routes; target rows provide one primary and optional replicas. Ref: z-kn/08-execution/z-s_app-mvp/tasks/planning/t2-client-storage-workspace/handoffs/01-online-configuration-platform-coding.md';
COMMENT ON TABLE public.storage_control_configuration_route_targets IS 'Ordered primary and replica vault targets owned by one configuration route. Ref: z-kn/08-execution/z-s_app-mvp/tasks/planning/t2-client-storage-workspace/handoffs/01-online-configuration-platform-coding.md';
COMMENT ON TABLE public.storage_control_integration_tokens IS 'Scoped runtime integration-token metadata with digest-only persistence, separate from browser-login credentials. Ref: z-kn/08-execution/z-s_app-mvp/tasks/planning/t2-client-storage-workspace/handoffs/01-online-configuration-platform-coding.md';
COMMENT ON TABLE public.storage_control_configuration_audit_events IS 'Append-only safe client configuration and integration-token audit events. Ref: z-kn/08-execution/z-s_app-mvp/tasks/planning/t2-client-storage-workspace/handoffs/01-online-configuration-platform-coding.md';

DO $$
DECLARE
  column_record record;
  task_reference constant text := 'Ref: z-kn/08-execution/z-s_app-mvp/tasks/planning/t2-client-storage-workspace/handoffs/01-online-configuration-platform-coding.md';
BEGIN
  FOR column_record IN
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY(ARRAY[
         'storage_control_provider_connections',
         'storage_control_configuration_versions',
         'storage_control_configuration_vaults',
         'storage_control_configuration_image_presets',
         'storage_control_configuration_routes',
         'storage_control_configuration_route_targets',
         'storage_control_integration_tokens',
         'storage_control_configuration_audit_events'
       ])
  LOOP
    EXECUTE format(
      'COMMENT ON COLUMN public.%I.%I IS %L',
      column_record.table_name,
      column_record.column_name,
      format('Z-s client configuration field. %s', task_reference)
    );
  END LOOP;
END
$$;

COMMIT;
