BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  expected_table text;
BEGIN
  FOREACH expected_table IN ARRAY ARRAY[
    'storage_control_clients',
    'storage_control_provider_connections',
    'storage_control_configuration_versions',
    'storage_control_configuration_vaults',
    'storage_control_configuration_routes',
    'storage_control_configuration_route_targets',
    'storage_objects',
    'storage_object_copies',
    'storage_image_derivative_outputs'
  ]
  LOOP
    IF to_regclass(format('public.%I', expected_table)) IS NULL THEN
      RAISE EXCEPTION '0012 preflight missing required table public.%', expected_table;
    END IF;
  END LOOP;

  IF to_regclass('public.storage_control_storage_services') IS NOT NULL
     OR to_regclass('public.storage_control_provider_secrets') IS NOT NULL
     OR to_regclass('public.storage_control_storage_service_events') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'storage_control_provider_connections'
          AND column_name = 'storage_service_id'
     ) THEN
    RAISE EXCEPTION '0012 migration already applied: storage service management exists';
  END IF;
END
$$;

CREATE TABLE public.storage_control_storage_services (
  id uuid PRIMARY KEY,
  storage_control_client_id uuid NOT NULL
    REFERENCES public.storage_control_clients(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('dev', 'staging', 'prod')),
  service_id text NOT NULL CHECK (service_id ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 160),
  provider_type text NOT NULL CHECK (provider_type IN ('cloudflare-r2')),
  ownership text NOT NULL CHECK (ownership IN ('z-s-managed', 'client-owned')),
  managed_secret_reference_id text NULL CHECK (
    managed_secret_reference_id IS NULL
    OR managed_secret_reference_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
  ),
  active_provider_secret_id uuid NULL,
  status text NOT NULL CHECK (status IN (
    'draft', 'awaiting-secret', 'testing', 'ready', 'failed', 'disabled', 'archived'
  )),
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  capability_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_test_status text NOT NULL DEFAULT 'never'
    CHECK (last_test_status IN ('never', 'passed', 'failed')),
  last_tested_at timestamptz NULL,
  last_diagnostic_code text NULL CHECK (
    last_diagnostic_code IS NULL
    OR last_diagnostic_code ~ '^[a-z0-9][a-z0-9-]{0,95}$'
  ),
  disabled_at timestamptz NULL,
  archived_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_control_client_id, environment, service_id),
  UNIQUE (storage_control_client_id, id),
  CHECK (jsonb_typeof(safe_metadata) = 'object'),
  CHECK (jsonb_typeof(capability_manifest) = 'object'),
  CHECK (octet_length(safe_metadata::text) <= 4096),
  CHECK (octet_length(capability_manifest::text) <= 4096),
  CHECK (NOT safe_metadata ?| ARRAY[
    'credential', 'credentials', 'secret', 'token', 'password', 'endpoint',
    'bucket', 'object_key', 'access_key', 'secret_key', 'private_key',
    'connection_string', 'signed_url', 'secret_reference'
  ]),
  CHECK (
    (ownership = 'z-s-managed' AND managed_secret_reference_id IS NOT NULL)
    OR (ownership = 'client-owned' AND managed_secret_reference_id IS NULL)
  ),
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL)),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CHECK (updated_at >= created_at),
  CHECK (last_tested_at IS NULL OR last_tested_at >= created_at)
);

CREATE TABLE public.storage_control_provider_secrets (
  id uuid PRIMARY KEY,
  storage_control_client_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('dev', 'staging', 'prod')),
  storage_service_id uuid NOT NULL,
  provider_type text NOT NULL CHECK (provider_type IN ('cloudflare-r2')),
  key_version integer NOT NULL CHECK (key_version > 0),
  algorithm text NOT NULL CHECK (algorithm = 'aes-256-gcm'),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 16384),
  authentication_tag bytea NOT NULL CHECK (octet_length(authentication_tag) = 16),
  state text NOT NULL CHECK (state IN ('active', 'revoked')),
  replaced_by_secret_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz NULL,
  UNIQUE (storage_control_client_id, environment, storage_service_id, id),
  FOREIGN KEY (storage_control_client_id, storage_service_id)
    REFERENCES public.storage_control_storage_services(storage_control_client_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (replaced_by_secret_id)
    REFERENCES public.storage_control_provider_secrets(id) ON DELETE RESTRICT,
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (replaced_by_secret_id IS NULL OR replaced_by_secret_id <> id),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

ALTER TABLE public.storage_control_storage_services
  ADD CONSTRAINT storage_control_storage_services_active_secret_fk
  FOREIGN KEY (
    storage_control_client_id,
    environment,
    id,
    active_provider_secret_id
  ) REFERENCES public.storage_control_provider_secrets(
    storage_control_client_id,
    environment,
    storage_service_id,
    id
  ) ON DELETE RESTRICT,
  ADD CONSTRAINT storage_control_storage_services_secret_state_check
  CHECK (
    (ownership = 'z-s-managed' AND active_provider_secret_id IS NULL)
    OR (
      ownership = 'client-owned'
      AND (
        (status IN ('draft', 'awaiting-secret') AND active_provider_secret_id IS NULL)
        OR (status IN ('testing', 'ready', 'failed', 'disabled', 'archived')
            AND active_provider_secret_id IS NOT NULL)
      )
    )
  );

CREATE TABLE public.storage_control_storage_service_events (
  id uuid PRIMARY KEY,
  storage_control_client_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('dev', 'staging', 'prod')),
  storage_service_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z0-9][a-z0-9-]{0,95}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('client-browser', 'operator', 'runtime')),
  actor_reference text NOT NULL CHECK (char_length(actor_reference) BETWEEN 1 AND 160),
  safe_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (storage_control_client_id, storage_service_id)
    REFERENCES public.storage_control_storage_services(storage_control_client_id, id)
    ON DELETE RESTRICT,
  CHECK (jsonb_typeof(safe_summary) = 'object'),
  CHECK (octet_length(safe_summary::text) <= 4096),
  CHECK (NOT safe_summary ?| ARRAY[
    'credential', 'credentials', 'secret', 'token', 'password', 'endpoint',
    'bucket', 'object_key', 'access_key', 'secret_key', 'private_key',
    'connection_string', 'signed_url', 'secret_reference'
  ])
);

ALTER TABLE public.storage_control_provider_connections
  ADD COLUMN storage_service_id uuid NULL,
  ADD CONSTRAINT storage_control_provider_connections_service_fk
  FOREIGN KEY (storage_control_client_id, storage_service_id)
    REFERENCES public.storage_control_storage_services(storage_control_client_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT storage_control_provider_connections_service_reference_check
  CHECK (
    storage_service_id IS NULL
    OR secret_reference_id = 'zs-storage-service:' || storage_service_id::text
  );


CREATE FUNCTION public.z_s_storage_service_connection_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  service_uuid uuid;
  service_client_id uuid;
  service_environment text;
  service_provider_type text;
BEGIN
  IF NEW.secret_reference_id NOT LIKE 'zs-storage-service:%' THEN
    NEW.storage_service_id := NULL;
    RETURN NEW;
  END IF;

  BEGIN
    service_uuid := substring(NEW.secret_reference_id from 20)::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION '0012 invalid storage service secret reference';
  END;

  SELECT storage_control_client_id, environment, provider_type
    INTO service_client_id, service_environment, service_provider_type
    FROM public.storage_control_storage_services
   WHERE id = service_uuid;

  IF service_client_id IS NULL
     OR service_client_id IS DISTINCT FROM NEW.storage_control_client_id
     OR service_environment IS DISTINCT FROM NEW.environment
     OR NOT (
       (service_provider_type = 'cloudflare-r2' AND NEW.provider_type = 'r2')
     ) THEN
    RAISE EXCEPTION '0012 storage service connection authority mismatch';
  END IF;

  NEW.storage_service_id := service_uuid;
  RETURN NEW;
END
$$;

CREATE TRIGGER z_s_storage_service_connection_guard_trigger
BEFORE INSERT OR UPDATE OF storage_control_client_id, environment, provider_type, secret_reference_id
ON public.storage_control_provider_connections
FOR EACH ROW EXECUTE FUNCTION public.z_s_storage_service_connection_guard();

CREATE INDEX storage_control_storage_services_client_status_idx
  ON public.storage_control_storage_services (
    storage_control_client_id, environment, status, provider_type, ownership, service_id
  );
CREATE INDEX storage_control_provider_secrets_service_state_idx
  ON public.storage_control_provider_secrets (
    storage_control_client_id, environment, storage_service_id, state, created_at DESC
  );
CREATE INDEX storage_control_storage_service_events_lookup_idx
  ON public.storage_control_storage_service_events (
    storage_control_client_id, environment, storage_service_id, created_at DESC
  );
CREATE INDEX storage_control_provider_connections_service_idx
  ON public.storage_control_provider_connections (storage_service_id)
  WHERE storage_service_id IS NOT NULL;

COMMENT ON TABLE public.storage_control_storage_services IS
  'Provider-neutral client storage service lifecycle and safe capability truth for T2 H07.';
COMMENT ON TABLE public.storage_control_provider_secrets IS
  'Ciphertext-only client-owned provider credential envelopes for T2 H07; plaintext is never persisted.';
COMMENT ON TABLE public.storage_control_storage_service_events IS
  'Client-scoped safe storage service activity without provider-private values for T2 H07.';
COMMENT ON COLUMN public.storage_control_provider_connections.storage_service_id IS
  'Optional authoritative storage service binding. Null preserves accepted legacy provider references.';

COMMIT;
