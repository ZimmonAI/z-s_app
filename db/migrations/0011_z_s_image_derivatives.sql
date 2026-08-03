BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  expected_table text;
BEGIN
  FOREACH expected_table IN ARRAY ARRAY[
    'storage_objects',
    'storage_object_copies',
    'storage_control_clients',
    'storage_control_configuration_versions',
    'storage_control_configuration_routes',
    'storage_control_configuration_image_presets',
    'storage_control_configuration_vaults',
    'storage_control_provider_connections'
  ]
  LOOP
    IF to_regclass(format('public.%I', expected_table)) IS NULL THEN
      RAISE EXCEPTION '0011 preflight missing required table public.%', expected_table;
    END IF;
  END LOOP;

  IF to_regclass('public.storage_image_derivative_jobs') IS NOT NULL
     OR to_regclass('public.storage_image_derivative_outputs') IS NOT NULL
     OR EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'storage_object_copies'
         AND column_name = 'image_derivative_job_id'
     ) THEN
    RAISE EXCEPTION '0011 migration already applied: image derivative persistence exists';
  END IF;
END
$$;

CREATE TABLE public.storage_image_derivative_jobs (
  image_derivative_job_id uuid PRIMARY KEY,
  source_storage_object_id uuid NOT NULL REFERENCES public.storage_objects(storage_object_id) ON DELETE RESTRICT,
  storage_control_client_id uuid NOT NULL REFERENCES public.storage_control_clients(id) ON DELETE RESTRICT,
  configuration_version_id uuid NOT NULL,
  configuration_fingerprint text NOT NULL CHECK (configuration_fingerprint ~ '^[a-f0-9]{64}$'),
  configuration_route_id uuid NOT NULL,
  configuration_image_preset_id uuid NOT NULL,
  preset_id text NOT NULL CHECK (preset_id ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  target_configuration_vault_id uuid NOT NULL,
  requested_width integer NOT NULL CHECK (requested_width BETWEEN 16 AND 16384),
  output_format text NOT NULL CHECK (output_format IN ('webp', 'avif', 'jpeg', 'png')),
  quality smallint NOT NULL CHECK (quality BETWEEN 1 AND 100),
  fit_mode text NOT NULL CHECK (fit_mode IN ('inside', 'cover', 'contain', 'fill')),
  state text NOT NULL CHECK (state IN ('queued', 'processing', 'succeeded', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  next_attempt_at timestamptz NULL,
  lease_owner text NULL CHECK (lease_owner IS NULL OR char_length(lease_owner) BETWEEN 1 AND 128),
  lease_token text NULL CHECK (lease_token IS NULL OR char_length(lease_token) BETWEEN 32 AND 128),
  lease_expires_at timestamptz NULL,
  safe_diagnostic_category text NULL CHECK (
    safe_diagnostic_category IS NULL OR safe_diagnostic_category IN (
      'invalid-request', 'unauthenticated', 'unauthorized', 'incompatible-version',
      'duplicate-conflict', 'not-ready', 'dependency-unavailable', 'internal'
    )
  ),
  safe_diagnostic_code text NULL CHECK (
    safe_diagnostic_code IS NULL OR safe_diagnostic_code ~ '^[a-z0-9][a-z0-9-]{0,95}$'
  ),
  reserved_output_storage_object_id uuid NULL UNIQUE
    REFERENCES public.storage_objects(storage_object_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (
    source_storage_object_id,
    configuration_version_id,
    configuration_image_preset_id,
    requested_width,
    output_format
  ),
  UNIQUE (storage_control_client_id, image_derivative_job_id),
  FOREIGN KEY (storage_control_client_id, configuration_version_id)
    REFERENCES public.storage_control_configuration_versions(storage_control_client_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    storage_control_client_id,
    configuration_version_id,
    configuration_route_id
  ) REFERENCES public.storage_control_configuration_routes(
    storage_control_client_id,
    configuration_version_id,
    id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    storage_control_client_id,
    configuration_version_id,
    configuration_image_preset_id
  ) REFERENCES public.storage_control_configuration_image_presets(
    storage_control_client_id,
    configuration_version_id,
    id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    storage_control_client_id,
    configuration_version_id,
    target_configuration_vault_id
  ) REFERENCES public.storage_control_configuration_vaults(
    storage_control_client_id,
    configuration_version_id,
    id
  ) ON DELETE RESTRICT,
  CHECK (
    (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (state <> 'processing' OR lease_token IS NOT NULL),
  CHECK ((state = 'succeeded') = (finished_at IS NOT NULL AND safe_diagnostic_code IS NULL)),
  CHECK (state <> 'queued' OR attempt_count = 0),
  CHECK (next_attempt_at IS NULL OR state = 'failed'),
  CHECK (started_at IS NULL OR started_at >= created_at),
  CHECK (finished_at IS NULL OR finished_at >= created_at),
  CHECK (updated_at >= created_at)
);

CREATE INDEX storage_image_derivative_jobs_claim_idx
  ON public.storage_image_derivative_jobs (
    state, next_attempt_at, lease_expires_at, created_at
  );
CREATE INDEX storage_image_derivative_jobs_client_status_idx
  ON public.storage_image_derivative_jobs (
    storage_control_client_id, configuration_version_id, created_at DESC
  );
CREATE INDEX storage_image_derivative_jobs_source_idx
  ON public.storage_image_derivative_jobs (source_storage_object_id, created_at DESC);

CREATE TABLE public.storage_image_derivative_outputs (
  image_derivative_output_id uuid PRIMARY KEY,
  image_derivative_job_id uuid NOT NULL UNIQUE,
  storage_control_client_id uuid NOT NULL,
  configuration_version_id uuid NOT NULL,
  source_storage_object_id uuid NOT NULL REFERENCES public.storage_objects(storage_object_id) ON DELETE RESTRICT,
  output_storage_object_id uuid NOT NULL UNIQUE REFERENCES public.storage_objects(storage_object_id) ON DELETE RESTRICT,
  width integer NOT NULL CHECK (width BETWEEN 16 AND 16384),
  output_format text NOT NULL CHECK (output_format IN ('webp', 'avif', 'jpeg', 'png')),
  verified_byte_length bigint NOT NULL CHECK (verified_byte_length > 0),
  verified_checksum_sha256 text NOT NULL CHECK (verified_checksum_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  UNIQUE (storage_control_client_id, image_derivative_output_id),
  FOREIGN KEY (storage_control_client_id, image_derivative_job_id)
    REFERENCES public.storage_image_derivative_jobs(storage_control_client_id, image_derivative_job_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (storage_control_client_id, configuration_version_id)
    REFERENCES public.storage_control_configuration_versions(storage_control_client_id, id)
    ON DELETE RESTRICT,
  CHECK (source_storage_object_id <> output_storage_object_id)
);

CREATE INDEX storage_image_derivative_outputs_source_idx
  ON public.storage_image_derivative_outputs (source_storage_object_id, created_at DESC);
CREATE INDEX storage_image_derivative_outputs_client_idx
  ON public.storage_image_derivative_outputs (
    storage_control_client_id, configuration_version_id, created_at DESC
  );

ALTER TABLE public.storage_object_copies
  ADD COLUMN image_derivative_job_id uuid NULL,
  ADD CONSTRAINT storage_object_copies_image_derivative_job_fk
    FOREIGN KEY (image_derivative_job_id)
    REFERENCES public.storage_image_derivative_jobs(image_derivative_job_id)
    ON DELETE RESTRICT;

ALTER TABLE public.storage_object_copies
  DROP CONSTRAINT storage_object_copies_authority_exclusive_check,
  ADD CONSTRAINT storage_object_copies_authority_exclusive_check
    CHECK (
      (
        storage_profile_provider_binding_id IS NOT NULL
        AND provider_role IS NOT NULL
        AND configuration_route_target_id IS NULL
        AND configuration_vault_id IS NULL
        AND provider_connection_id IS NULL
        AND target_role IS NULL
        AND target_order IS NULL
        AND image_derivative_job_id IS NULL
      )
      OR
      (
        storage_profile_provider_binding_id IS NULL
        AND provider_role IS NULL
        AND configuration_route_target_id IS NOT NULL
        AND configuration_vault_id IS NOT NULL
        AND provider_connection_id IS NOT NULL
        AND target_role IS NOT NULL
        AND target_order IS NOT NULL
        AND image_derivative_job_id IS NULL
      )
      OR
      (
        storage_profile_provider_binding_id IS NULL
        AND provider_role IS NULL
        AND configuration_route_target_id IS NULL
        AND configuration_vault_id IS NOT NULL
        AND provider_connection_id IS NOT NULL
        AND target_role IS NULL
        AND target_order IS NULL
        AND image_derivative_job_id IS NOT NULL
      )
    );

CREATE UNIQUE INDEX storage_object_copies_image_derivative_job_idx
  ON public.storage_object_copies (image_derivative_job_id)
  WHERE image_derivative_job_id IS NOT NULL;

CREATE FUNCTION public.z_s_image_derivative_job_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_client_id uuid;
  source_version_id uuid;
  source_fingerprint text;
  source_route_id uuid;
  source_state text;
  source_content_type text;
  route_preset_id uuid;
  preset_id_value text;
  preset_target_vault_id uuid;
  preset_widths jsonb;
  preset_output_format text;
  preset_quality smallint;
  preset_fit_mode text;
BEGIN
  IF TG_OP = 'UPDATE' AND (
       NEW.source_storage_object_id IS DISTINCT FROM OLD.source_storage_object_id
       OR NEW.storage_control_client_id IS DISTINCT FROM OLD.storage_control_client_id
       OR NEW.configuration_version_id IS DISTINCT FROM OLD.configuration_version_id
       OR NEW.configuration_fingerprint IS DISTINCT FROM OLD.configuration_fingerprint
       OR NEW.configuration_route_id IS DISTINCT FROM OLD.configuration_route_id
       OR NEW.configuration_image_preset_id IS DISTINCT FROM OLD.configuration_image_preset_id
       OR NEW.preset_id IS DISTINCT FROM OLD.preset_id
       OR NEW.target_configuration_vault_id IS DISTINCT FROM OLD.target_configuration_vault_id
       OR NEW.requested_width IS DISTINCT FROM OLD.requested_width
       OR NEW.output_format IS DISTINCT FROM OLD.output_format
       OR NEW.quality IS DISTINCT FROM OLD.quality
       OR NEW.fit_mode IS DISTINCT FROM OLD.fit_mode
     ) THEN
    RAISE EXCEPTION '0011 immutable image derivative job authority cannot be updated: %',
      OLD.image_derivative_job_id;
  END IF;

  SELECT object.storage_control_client_id,
         object.configuration_version_id,
         object.configuration_fingerprint,
         object.configuration_route_id,
         object.registry_state,
         object.expected_content_type
    INTO source_client_id,
         source_version_id,
         source_fingerprint,
         source_route_id,
         source_state,
         source_content_type
    FROM public.storage_objects AS object
   WHERE object.storage_object_id = NEW.source_storage_object_id;

  SELECT route.image_preset_id
    INTO route_preset_id
    FROM public.storage_control_configuration_routes AS route
   WHERE route.storage_control_client_id = NEW.storage_control_client_id
     AND route.configuration_version_id = NEW.configuration_version_id
     AND route.id = NEW.configuration_route_id
     AND route.asset_class = 'image';

  SELECT preset.preset_id,
         preset.target_vault_id,
         preset.resize_widths,
         preset.output_format,
         preset.quality,
         preset.fit_mode
    INTO preset_id_value,
         preset_target_vault_id,
         preset_widths,
         preset_output_format,
         preset_quality,
         preset_fit_mode
    FROM public.storage_control_configuration_image_presets AS preset
   WHERE preset.storage_control_client_id = NEW.storage_control_client_id
     AND preset.configuration_version_id = NEW.configuration_version_id
     AND preset.id = NEW.configuration_image_preset_id;

  IF source_client_id IS NULL
     OR source_client_id IS DISTINCT FROM NEW.storage_control_client_id
     OR source_version_id IS DISTINCT FROM NEW.configuration_version_id
     OR source_fingerprint IS DISTINCT FROM NEW.configuration_fingerprint
     OR source_route_id IS DISTINCT FROM NEW.configuration_route_id
     OR source_state <> 'active'
     OR source_content_type NOT LIKE 'image/%'
     OR route_preset_id IS DISTINCT FROM NEW.configuration_image_preset_id
     OR preset_id_value IS DISTINCT FROM NEW.preset_id
     OR preset_target_vault_id IS DISTINCT FROM NEW.target_configuration_vault_id
     OR NOT (preset_widths @> to_jsonb(ARRAY[NEW.requested_width]))
     OR preset_output_format IS DISTINCT FROM NEW.output_format
     OR preset_quality IS DISTINCT FROM NEW.quality
     OR preset_fit_mode IS DISTINCT FROM NEW.fit_mode THEN
    RAISE EXCEPTION '0011 image derivative immutable authority mismatch for source object %',
      NEW.source_storage_object_id;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER z_s_image_derivative_job_guard_trigger
BEFORE INSERT OR UPDATE OF
  source_storage_object_id,
  storage_control_client_id,
  configuration_version_id,
  configuration_fingerprint,
  configuration_route_id,
  configuration_image_preset_id,
  preset_id,
  target_configuration_vault_id,
  requested_width,
  output_format,
  quality,
  fit_mode
ON public.storage_image_derivative_jobs
FOR EACH ROW EXECUTE FUNCTION public.z_s_image_derivative_job_guard();

CREATE FUNCTION public.z_s_image_derivative_output_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  job_row public.storage_image_derivative_jobs%ROWTYPE;
  source_client_id uuid;
  source_version_id uuid;
  output_client_id uuid;
  output_version_id uuid;
  output_checksum text;
  output_byte_length bigint;
  output_state text;
BEGIN
  SELECT * INTO job_row
    FROM public.storage_image_derivative_jobs
   WHERE image_derivative_job_id = NEW.image_derivative_job_id;

  SELECT storage_control_client_id, configuration_version_id
    INTO source_client_id, source_version_id
    FROM public.storage_objects
   WHERE storage_object_id = NEW.source_storage_object_id;

  SELECT storage_control_client_id,
         configuration_version_id,
         verified_checksum_sha256,
         verified_byte_length,
         registry_state
    INTO output_client_id,
         output_version_id,
         output_checksum,
         output_byte_length,
         output_state
    FROM public.storage_objects
   WHERE storage_object_id = NEW.output_storage_object_id;

  IF job_row.image_derivative_job_id IS NULL
     OR job_row.source_storage_object_id IS DISTINCT FROM NEW.source_storage_object_id
     OR job_row.reserved_output_storage_object_id IS DISTINCT FROM NEW.output_storage_object_id
     OR job_row.storage_control_client_id IS DISTINCT FROM NEW.storage_control_client_id
     OR job_row.configuration_version_id IS DISTINCT FROM NEW.configuration_version_id
     OR job_row.requested_width IS DISTINCT FROM NEW.width
     OR job_row.output_format IS DISTINCT FROM NEW.output_format
     OR source_client_id IS DISTINCT FROM NEW.storage_control_client_id
     OR source_version_id IS DISTINCT FROM NEW.configuration_version_id
     OR output_client_id IS DISTINCT FROM NEW.storage_control_client_id
     OR output_version_id IS DISTINCT FROM NEW.configuration_version_id
     OR output_state <> 'active'
     OR output_checksum IS DISTINCT FROM NEW.verified_checksum_sha256
     OR output_byte_length IS DISTINCT FROM NEW.verified_byte_length THEN
    RAISE EXCEPTION '0011 image derivative output lineage mismatch for job %',
      NEW.image_derivative_job_id;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER z_s_image_derivative_output_guard_trigger
BEFORE INSERT OR UPDATE ON public.storage_image_derivative_outputs
FOR EACH ROW EXECUTE FUNCTION public.z_s_image_derivative_output_guard();

DROP TRIGGER z_s_runtime_configuration_copy_guard_trigger
  ON public.storage_object_copies;

CREATE OR REPLACE FUNCTION public.z_s_runtime_configuration_copy_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  object_client_id uuid;
  object_version_id uuid;
  object_route_id uuid;
  target_client_id uuid;
  target_version_id uuid;
  target_route_id uuid;
  target_vault_id uuid;
  target_role_value text;
  target_order_value smallint;
  vault_provider_connection_id uuid;
  derivative_client_id uuid;
  derivative_version_id uuid;
  derivative_vault_id uuid;
  derivative_output_object_id uuid;
BEGIN
  IF NEW.image_derivative_job_id IS NOT NULL THEN
    SELECT storage_control_client_id, configuration_version_id
      INTO object_client_id, object_version_id
      FROM public.storage_objects
     WHERE storage_object_id = NEW.storage_object_id;

    SELECT job.storage_control_client_id,
           job.configuration_version_id,
           job.target_configuration_vault_id,
           job.reserved_output_storage_object_id,
           vault.provider_connection_id
      INTO derivative_client_id,
           derivative_version_id,
           derivative_vault_id,
           derivative_output_object_id,
           vault_provider_connection_id
      FROM public.storage_image_derivative_jobs AS job
      JOIN public.storage_control_configuration_vaults AS vault
        ON vault.storage_control_client_id = job.storage_control_client_id
       AND vault.configuration_version_id = job.configuration_version_id
       AND vault.id = job.target_configuration_vault_id
     WHERE job.image_derivative_job_id = NEW.image_derivative_job_id;

    IF object_client_id IS NULL
       OR object_client_id IS DISTINCT FROM derivative_client_id
       OR object_version_id IS DISTINCT FROM derivative_version_id
       OR NEW.storage_object_id IS DISTINCT FROM derivative_output_object_id
       OR NEW.configuration_vault_id IS DISTINCT FROM derivative_vault_id
       OR NEW.provider_connection_id IS DISTINCT FROM vault_provider_connection_id THEN
      RAISE EXCEPTION '0011 image derivative copy authority mismatch for storage object %',
        NEW.storage_object_id;
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.configuration_route_target_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT storage_control_client_id, configuration_version_id, configuration_route_id
    INTO object_client_id, object_version_id, object_route_id
    FROM public.storage_objects
   WHERE storage_object_id = NEW.storage_object_id;

  SELECT target.storage_control_client_id,
         target.configuration_version_id,
         target.configuration_route_id,
         target.vault_id,
         target.target_role,
         target.target_order,
         vault.provider_connection_id
    INTO target_client_id,
         target_version_id,
         target_route_id,
         target_vault_id,
         target_role_value,
         target_order_value,
         vault_provider_connection_id
    FROM public.storage_control_configuration_route_targets AS target
    JOIN public.storage_control_configuration_vaults AS vault
      ON vault.storage_control_client_id = target.storage_control_client_id
     AND vault.configuration_version_id = target.configuration_version_id
     AND vault.id = target.vault_id
   WHERE target.id = NEW.configuration_route_target_id;

  IF object_client_id IS NULL
     OR object_client_id IS DISTINCT FROM target_client_id
     OR object_version_id IS DISTINCT FROM target_version_id
     OR object_route_id IS DISTINCT FROM target_route_id
     OR NEW.configuration_vault_id IS DISTINCT FROM target_vault_id
     OR NEW.provider_connection_id IS DISTINCT FROM vault_provider_connection_id
     OR NEW.target_role IS DISTINCT FROM target_role_value
     OR NEW.target_order IS DISTINCT FROM target_order_value THEN
    RAISE EXCEPTION '0010 configuration copy authority mismatch for storage object %', NEW.storage_object_id;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER z_s_runtime_configuration_copy_guard_trigger
BEFORE INSERT OR UPDATE OF
  storage_object_id,
  configuration_route_target_id,
  configuration_vault_id,
  provider_connection_id,
  target_role,
  target_order,
  image_derivative_job_id
ON public.storage_object_copies
FOR EACH ROW EXECUTE FUNCTION public.z_s_runtime_configuration_copy_guard();

COMMENT ON TABLE public.storage_image_derivative_jobs IS
  'Bounded image-only derivative work with immutable source configuration and preset snapshots for T2 H05.';
COMMENT ON TABLE public.storage_image_derivative_outputs IS
  'Verified source-to-output storage object lineage for T2 H05 image derivatives.';
COMMENT ON COLUMN public.storage_object_copies.image_derivative_job_id IS
  'Derivative-only configured-vault copy authority; provider locators remain solely on normal copy rows.';

COMMENT ON COLUMN public.storage_image_derivative_jobs.image_derivative_job_id IS 'Stable T2 H05 logical derivative job UUID.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.source_storage_object_id IS 'Verified active source storage object; never a caller-selected provider locator.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.storage_control_client_id IS 'Owning client authority copied from the immutable source object.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.configuration_version_id IS 'Immutable source configuration version.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.configuration_fingerprint IS 'Safe immutable source configuration SHA-256 fingerprint.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.configuration_route_id IS 'Immutable image route selected for the source object.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.configuration_image_preset_id IS 'Immutable configuration image-preset UUID.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.preset_id IS 'Safe human-managed preset identifier snapshot.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.target_configuration_vault_id IS 'Server-resolved derivative vault from the immutable preset.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.requested_width IS 'Bounded output width snapshot in pixels.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.output_format IS 'Configured output format snapshot.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.quality IS 'Configured quality snapshot from 1 through 100.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.fit_mode IS 'Configured fit behavior snapshot.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.state IS 'Queued, processing, succeeded, or failed derivative state.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.attempt_count IS 'Monotonic bounded processing attempt count.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.next_attempt_at IS 'Earliest bounded retry time for a retryable failure.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.lease_owner IS 'Safe worker identity holding the current processing lease.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.lease_token IS 'Random non-bearer concurrency token for the current processing lease.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.lease_expires_at IS 'Lease expiry after which a bounded reclaim is allowed.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.safe_diagnostic_category IS 'Safe diagnostic category only; no provider or secret material.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.safe_diagnostic_code IS 'Safe bounded diagnostic code only.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.reserved_output_storage_object_id IS 'Separate normal storage object reserved for this derivative output.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.created_at IS 'Derivative job creation timestamp.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.started_at IS 'First processing start timestamp.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.finished_at IS 'Terminal success or exhausted-failure timestamp.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.updated_at IS 'Latest durable state transition timestamp.';
COMMENT ON COLUMN public.storage_image_derivative_jobs.row_version IS 'Positive optimistic concurrency version.';

COMMENT ON COLUMN public.storage_image_derivative_outputs.image_derivative_output_id IS 'Stable T2 H05 output-lineage UUID.';
COMMENT ON COLUMN public.storage_image_derivative_outputs.image_derivative_job_id IS 'One successful output for exactly one logical derivative job.';
COMMENT ON COLUMN public.storage_image_derivative_outputs.storage_control_client_id IS 'Owning client shared by source, job, and output.';
COMMENT ON COLUMN public.storage_image_derivative_outputs.configuration_version_id IS 'Immutable configuration version shared by source and output.';
COMMENT ON COLUMN public.storage_image_derivative_outputs.source_storage_object_id IS 'Verified source storage object UUID.';
COMMENT ON COLUMN public.storage_image_derivative_outputs.output_storage_object_id IS 'Separate verified derivative storage object UUID.';
COMMENT ON COLUMN public.storage_image_derivative_outputs.width IS 'Verified derivative width requested by the immutable job.';
COMMENT ON COLUMN public.storage_image_derivative_outputs.output_format IS 'Verified derivative format requested by the immutable job.';
COMMENT ON COLUMN public.storage_image_derivative_outputs.verified_byte_length IS 'Verified output byte length mirrored from the output object.';
COMMENT ON COLUMN public.storage_image_derivative_outputs.verified_checksum_sha256 IS 'Verified output SHA-256 mirrored from the output object.';
COMMENT ON COLUMN public.storage_image_derivative_outputs.created_at IS 'Lineage creation timestamp after output verification.';

COMMENT ON FUNCTION public.z_s_image_derivative_job_guard() IS
  'Rejects jobs whose source, immutable image route, preset, width, format, quality, fit, client, or version disagree.';
COMMENT ON FUNCTION public.z_s_image_derivative_output_guard() IS
  'Rejects output lineage unless source and verified output share the job client and immutable configuration authority.';
COMMENT ON FUNCTION public.z_s_runtime_configuration_copy_guard() IS
  'Enforces legacy, configured route-target, and T2 H05 derivative-vault copy authority without weakening prior routes.';

COMMIT;
