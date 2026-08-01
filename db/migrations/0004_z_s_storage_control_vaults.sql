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
    'storage_profile_audit_events'
  ]
  LOOP
    IF to_regclass(format('public.%I', expected_table)) IS NULL THEN
      RAISE EXCEPTION '0004 preflight missing baseline table public.%', expected_table;
    END IF;
  END LOOP;

  FOREACH expected_table IN ARRAY ARRAY[
    'storage_control_clients',
    'storage_control_vaults',
    'storage_control_route_rules',
    'storage_control_image_derivative_rules',
    'storage_control_client_tokens'
  ]
  LOOP
    IF to_regclass(format('public.%I', expected_table)) IS NOT NULL THEN
      RAISE EXCEPTION '0004 migration already applied: public.% exists', expected_table;
    END IF;
  END LOOP;
END
$$;

CREATE TABLE public.storage_control_clients (
  id uuid PRIMARY KEY,
  client_id text NOT NULL UNIQUE CHECK (client_id ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  display_label text NOT NULL CHECK (char_length(display_label) BETWEEN 1 AND 160),
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.storage_control_vaults (
  id uuid PRIMARY KEY,
  storage_control_client_id uuid NOT NULL REFERENCES public.storage_control_clients(id) ON DELETE RESTRICT,
  vault_id text NOT NULL CHECK (vault_id ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  drive_label text NOT NULL CHECK (char_length(drive_label) BETWEEN 1 AND 160),
  provider_type text NOT NULL CHECK (provider_type IN ('minio', 'r2', 's3-compatible')),
  provider_role text NOT NULL CHECK (provider_role IN ('canonical', 'hot', 'derivative')),
  bucket_label text NOT NULL CHECK (bucket_label = lower(bucket_label) AND bucket_label !~ '[[:space:]]'),
  secret_reference_id text NOT NULL CHECK (secret_reference_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  retention_policy text NOT NULL CHECK (retention_policy IN ('permanent', 'hot-cache-short', 'custom')),
  delete_after_days integer NULL CHECK (delete_after_days IS NULL OR delete_after_days > 0),
  prefix_template text NOT NULL CHECK (prefix_template LIKE '%/*' AND prefix_template !~ '(^/|\\|\.\.)'),
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_control_client_id, vault_id),
  UNIQUE (storage_control_client_id, id),
  CHECK (
    (retention_policy = 'permanent' AND delete_after_days IS NULL)
    OR (retention_policy IN ('hot-cache-short', 'custom') AND delete_after_days IS NOT NULL)
  ),
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.storage_control_route_rules (
  id uuid PRIMARY KEY,
  storage_control_client_id uuid NOT NULL REFERENCES public.storage_control_clients(id) ON DELETE RESTRICT,
  route_id text NOT NULL CHECK (route_id ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  asset_class text NOT NULL CHECK (asset_class IN ('raw-image', 'raw-video', 'image-derivative', 'document')),
  primary_vault_id uuid NOT NULL,
  replica_vault_id uuid NULL,
  derivative_vault_id uuid NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_control_client_id, route_id),
  FOREIGN KEY (storage_control_client_id, primary_vault_id)
    REFERENCES public.storage_control_vaults(storage_control_client_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (storage_control_client_id, replica_vault_id)
    REFERENCES public.storage_control_vaults(storage_control_client_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (storage_control_client_id, derivative_vault_id)
    REFERENCES public.storage_control_vaults(storage_control_client_id, id) ON DELETE RESTRICT,
  CHECK (replica_vault_id IS NULL OR replica_vault_id <> primary_vault_id),
  CHECK (derivative_vault_id IS NULL OR derivative_vault_id <> primary_vault_id),
  CHECK (asset_class = 'raw-image' OR derivative_vault_id IS NULL),
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.storage_control_image_derivative_rules (
  id uuid PRIMARY KEY,
  storage_control_client_id uuid NOT NULL REFERENCES public.storage_control_clients(id) ON DELETE RESTRICT,
  derivative_id text NOT NULL CHECK (derivative_id ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  source_vault_id uuid NOT NULL,
  target_vault_id uuid NOT NULL,
  resize_widths jsonb NOT NULL,
  output_format text NOT NULL CHECK (output_format IN ('webp', 'avif', 'jpeg', 'png')),
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_control_client_id, derivative_id),
  FOREIGN KEY (storage_control_client_id, source_vault_id)
    REFERENCES public.storage_control_vaults(storage_control_client_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (storage_control_client_id, target_vault_id)
    REFERENCES public.storage_control_vaults(storage_control_client_id, id) ON DELETE RESTRICT,
  CHECK (source_vault_id <> target_vault_id),
  CHECK (jsonb_typeof(resize_widths) = 'array'),
  CHECK (jsonb_array_length(resize_widths) BETWEEN 1 AND 8),
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.storage_control_client_tokens (
  id uuid PRIMARY KEY,
  storage_control_client_id uuid NOT NULL REFERENCES public.storage_control_clients(id) ON DELETE RESTRICT,
  token_id text NOT NULL CHECK (token_id ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  token_purpose text NOT NULL CHECK (token_purpose ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at timestamptz NULL,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_control_client_id, token_id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (updated_at >= created_at)
);

CREATE INDEX storage_control_vaults_client_role_idx
  ON public.storage_control_vaults (storage_control_client_id, provider_role, status);
CREATE INDEX storage_control_route_rules_client_asset_idx
  ON public.storage_control_route_rules (storage_control_client_id, asset_class, status);
CREATE INDEX storage_control_image_derivative_rules_client_status_idx
  ON public.storage_control_image_derivative_rules (storage_control_client_id, status);
CREATE INDEX storage_control_client_tokens_client_status_idx
  ON public.storage_control_client_tokens (storage_control_client_id, status, expires_at);

COMMENT ON TABLE public.storage_control_clients IS 'Dynamic storage-control client identities for browser-managed vault setup. Ref: z-kn/06-db-schema/project/z-s/main.md#pending-source-migration-0004';
COMMENT ON TABLE public.storage_control_vaults IS 'Client vault and drive bindings using provider type, bucket label, retention, and secret-reference identity only. Ref: z-kn/06-db-schema/project/z-s/main.md#pending-source-migration-0004';
COMMENT ON TABLE public.storage_control_route_rules IS 'Client asset-class routing from primary vault to optional replica and image-derivative vaults. Ref: z-kn/06-db-schema/project/z-s/main.md#pending-source-migration-0004';
COMMENT ON TABLE public.storage_control_image_derivative_rules IS 'Image-only resize derivative routing rules; source and target vaults are governed separately. Ref: z-kn/06-db-schema/project/z-s/main.md#pending-source-migration-0004';
COMMENT ON TABLE public.storage_control_client_tokens IS 'Client token records with digest-only persistence and lifecycle state. Ref: z-kn/06-db-schema/project/z-s/main.md#pending-source-migration-0004';

DO $$
DECLARE
  column_record record;
  task_reference constant text := 'Ref: z-kn/06-db-schema/project/z-s/main.md#pending-source-migration-0004';
BEGIN
  FOR column_record IN
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY(ARRAY[
         'storage_control_clients',
         'storage_control_vaults',
         'storage_control_route_rules',
         'storage_control_image_derivative_rules',
         'storage_control_client_tokens'
       ])
  LOOP
    EXECUTE format(
      'COMMENT ON COLUMN public.%I.%I IS %L',
      column_record.table_name,
      column_record.column_name,
      format('Z-s storage control field. %s', task_reference)
    );
  END LOOP;
END
$$;

COMMIT;
