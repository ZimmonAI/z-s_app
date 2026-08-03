BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  expected_table text;
BEGIN
  FOREACH expected_table IN ARRAY ARRAY[
    'storage_control_clients',
    'storage_control_configuration_versions',
    'storage_control_configuration_routes',
    'storage_control_configuration_image_presets',
    'storage_control_configuration_vaults',
    'storage_control_provider_connections',
    'storage_objects',
    'storage_object_copies'
  ]
  LOOP
    IF to_regclass(format('public.%I', expected_table)) IS NULL THEN
      RAISE EXCEPTION '0011 preflight missing required table public.%', expected_table;
    END IF;
  END LOOP;

  IF to_regclass('public.storage_image_derivative_jobs') IS NOT NULL
     OR to_regclass('public.storage_image_derivative_outputs') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('storage_objects', 'storage_object_copies')
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
  environment text NOT NULL CHECK (environment IN ('dev', 'staging', 'prod')),
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
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  maximum_attempts integer NOT NULL DEFAULT 3 CHECK (maximum_attempts BETWEEN 1 AND 8),
  next_retry_at timestamptz NULL,
  lease_owner text NULL CHECK (lease_owner IS NULL OR char_length(lease_owner) BETWEEN 1 AND 128),
  lease_token text NULL CHECK (lease_token IS NULL OR char_length(lease_token) BETWEEN 32 AND 128),
  lease_expires_at timestamptz NULL,
  safe_diagnostic_category text NULL CHECK (
    safe_diagnostic_category IS NULL OR safe_diagnostic_category IN (
      'invalid-request', 'duplicate-conflict', 'not-ready', 'dependency-unavailable', 'internal'
    )
  ),
  safe_diagnostic_code text NULL CHECK (
    safe_diagnostic_code IS NULL OR safe_diagnostic_code ~ '^[a-z0-9][a-z0-9-]{0,95}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (
    source_storage_object_id,
    configuration_version_id,
    configuration_image_preset_id,
    requested_width,
    output_format
  ),
  UNIQUE (storage_control_client_id, configuration_version_id, image_derivative_job_id),
  FOREIGN KEY (storage_control_client_id, configuration_version_id)
    REFERENCES public.storage_control_configuration_versions(storage_control_client_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (storage_control_client_id, configuration_version_id, configuration_route_id)
    REFERENCES public.storage_control_configuration_routes(
      storage_control_client_id, configuration_version_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (storage_control_client_id, configuration_version_id, configuration_image_preset_id)
    REFERENCES public.storage_control_configuration_image_presets(
      storage_control_client_id, configuration_version_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (storage_control_client_id, configuration_version_id, target_configuration_vault_id)
    REFERENCES public.storage_control_configuration_vaults(
      storage_control_client_id, configuration_version_id, id
    ) ON DELETE RESTRICT,
  CHECK (
    (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (state = 'processing' OR lease_owner IS NULL),
  CHECK (attempt_count <= maximum_attempts),
  CHECK (started_at IS NULL OR started_at >= created_at),
  CHECK (finished_at IS NULL OR finished_at >= created_at),
  CHECK (updated_at >= created_at)
);

ALTER TABLE public.storage_objects
  ADD COLUMN image_derivative_job_id uuid NULL,
  ADD CONSTRAINT storage_objects_image_derivative_job_fk
    FOREIGN KEY (storage_control_client_id, configuration_version_id, image_derivative_job_id)
    REFERENCES public.storage_image_derivative_jobs(
      storage_control_client_id, configuration_version_id, image_derivative_job_id
    ) ON DELETE RESTRICT;

ALTER TABLE public.storage_object_copies
  ADD COLUMN image_derivative_job_id uuid NULL,
  ADD CONSTRAINT storage_object_copies_image_derivative_job_fk
    FOREIGN KEY (image_derivative_job_id)
    REFERENCES public.storage_image_derivative_jobs(image_derivative_job_id) ON DELETE RESTRICT;

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
        AND target_role = 'primary'
        AND target_order = 0
        AND image_derivative_job_id IS NOT NULL
      )
    );

CREATE UNIQUE INDEX storage_objects_image_derivative_job_idx
  ON public.storage_objects (image_derivative_job_id)
  WHERE image_derivative_job_id IS NOT NULL;
CREATE UNIQUE INDEX storage_object_copies_image_derivative_job_idx
  ON public.storage_object_copies (image_derivative_job_id)
  WHERE image_derivative_job_id IS NOT NULL;
CREATE INDEX storage_image_derivative_jobs_claim_idx
  ON public.storage_image_derivative_jobs (
    state, next_retry_at, lease_expires_at, created_at, image_derivative_job_id
  );
CREATE INDEX storage_image_derivative_jobs_client_status_idx
  ON public.storage_image_derivative_jobs (
    storage_control_client_id, environment, created_at DESC, image_derivative_job_id DESC
  );

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
  source_checksum text;
  source_length bigint;
  source_content_type text;
  version_environment text;
  route_asset_class text;
  route_preset_id uuid;
  preset_safe_id text;
  preset_target_vault_id uuid;
  preset_widths jsonb;
  preset_output_format text;
  preset_quality smallint;
  preset_fit_mode text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.source_storage_object_id IS DISTINCT FROM OLD.source_storage_object_id
       OR NEW.storage_control_client_id IS DISTINCT FROM OLD.storage_control_client_id
       OR NEW.environment IS DISTINCT FROM OLD.environment
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
       OR NEW.maximum_attempts IS DISTINCT FROM OLD.maximum_attempts
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION '0011 derivative job immutable authority changed: %', OLD.image_derivative_job_id;
    END IF;
    IF NEW.attempt_count < OLD.attempt_count
       OR NEW.row_version <> OLD.row_version + 1 THEN
      RAISE EXCEPTION '0011 derivative job monotonic state violation: %', OLD.image_derivative_job_id;
    END IF;
    IF NOT (
      NEW.state = OLD.state
      OR (OLD.state = 'queued' AND NEW.state = 'processing')
      OR (OLD.state = 'processing' AND NEW.state IN ('succeeded', 'failed'))
      OR (OLD.state = 'failed' AND NEW.state = 'processing')
    ) THEN
      RAISE EXCEPTION '0011 derivative job invalid state transition % -> % for %',
        OLD.state, NEW.state, OLD.image_derivative_job_id;
    END IF;
  END IF;

  SELECT
    objects.storage_control_client_id,
    objects.configuration_version_id,
    objects.configuration_fingerprint,
    objects.configuration_route_id,
    objects.registry_state,
    objects.verified_checksum_sha256,
    objects.verified_byte_length,
    objects.expected_content_type,
    versions.environment,
    routes.asset_class,
    routes.image_preset_id,
    presets.preset_id,
    presets.target_vault_id,
    presets.resize_widths,
    presets.output_format,
    presets.quality,
    presets.fit_mode
  INTO
    source_client_id,
    source_version_id,
    source_fingerprint,
    source_route_id,
    source_state,
    source_checksum,
    source_length,
    source_content_type,
    version_environment,
    route_asset_class,
    route_preset_id,
    preset_safe_id,
    preset_target_vault_id,
    preset_widths,
    preset_output_format,
    preset_quality,
    preset_fit_mode
  FROM public.storage_objects AS objects
  JOIN public.storage_control_configuration_versions AS versions
    ON versions.storage_control_client_id = objects.storage_control_client_id
   AND versions.id = objects.configuration_version_id
  JOIN public.storage_control_configuration_routes AS routes
    ON routes.storage_control_client_id = objects.storage_control_client_id
   AND routes.configuration_version_id = objects.configuration_version_id
   AND routes.id = objects.configuration_route_id
  JOIN public.storage_control_configuration_image_presets AS presets
    ON presets.storage_control_client_id = objects.storage_control_client_id
   AND presets.configuration_version_id = objects.configuration_version_id
   AND presets.id = routes.image_preset_id
  WHERE objects.storage_object_id = NEW.source_storage_object_id;

  IF source_client_id IS NULL
     OR source_state <> 'active'
     OR source_checksum IS NULL
     OR source_length IS NULL
     OR source_content_type NOT LIKE 'image/%'
     OR route_asset_class <> 'image'
     OR source_client_id IS DISTINCT FROM NEW.storage_control_client_id
     OR source_version_id IS DISTINCT FROM NEW.configuration_version_id
     OR source_fingerprint IS DISTINCT FROM NEW.configuration_fingerprint
     OR source_route_id IS DISTINCT FROM NEW.configuration_route_id
     OR version_environment IS DISTINCT FROM NEW.environment
     OR route_preset_id IS DISTINCT FROM NEW.configuration_image_preset_id
     OR preset_safe_id IS DISTINCT FROM NEW.preset_id
     OR preset_target_vault_id IS DISTINCT FROM NEW.target_configuration_vault_id
     OR preset_output_format IS DISTINCT FROM NEW.output_format
     OR preset_quality IS DISTINCT FROM NEW.quality
     OR preset_fit_mode IS DISTINCT FROM NEW.fit_mode
     OR NOT (preset_widths @> to_jsonb(ARRAY[NEW.requested_width])) THEN
    RAISE EXCEPTION '0011 derivative job source or immutable preset authority mismatch for %',
      NEW.image_derivative_job_id;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER z_s_image_derivative_job_guard_trigger
BEFORE INSERT OR UPDATE ON public.storage_image_derivative_jobs
FOR EACH ROW EXECUTE FUNCTION public.z_s_image_derivative_job_guard();

DROP TRIGGER z_s_runtime_configuration_copy_guard_trigger ON public.storage_object_copies;
DROP FUNCTION public.z_s_runtime_configuration_copy_guard();

CREATE FUNCTION public.z_s_runtime_configuration_copy_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  object_client_id uuid;
  object_version_id uuid;
  object_route_id uuid;
  object_derivative_job_id uuid;
  target_client_id uuid;
  target_version_id uuid;
  target_route_id uuid;
  target_vault_id uuid;
  target_role_value text;
  target_order_value smallint;
  vault_provider_connection_id uuid;
  job_client_id uuid;
  job_version_id uuid;
  job_route_id uuid;
  job_target_vault_id uuid;
BEGIN
  SELECT storage_control_client_id, configuration_version_id, configuration_route_id,
         image_derivative_job_id
    INTO object_client_id, object_version_id, object_route_id, object_derivative_job_id
    FROM public.storage_objects
   WHERE storage_object_id = NEW.storage_object_id;

  IF NEW.image_derivative_job_id IS NOT NULL THEN
    SELECT jobs.storage_control_client_id,
           jobs.configuration_version_id,
           jobs.configuration_route_id,
           jobs.target_configuration_vault_id,
           vaults.provider_connection_id
      INTO job_client_id,
           job_version_id,
           job_route_id,
           job_target_vault_id,
           vault_provider_connection_id
      FROM public.storage_image_derivative_jobs AS jobs
      JOIN public.storage_control_configuration_vaults AS vaults
        ON vaults.storage_control_client_id = jobs.storage_control_client_id
       AND vaults.configuration_version_id = jobs.configuration_version_id
       AND vaults.id = jobs.target_configuration_vault_id
     WHERE jobs.image_derivative_job_id = NEW.image_derivative_job_id;

    IF object_derivative_job_id IS DISTINCT FROM NEW.image_derivative_job_id
       OR object_client_id IS DISTINCT FROM job_client_id
       OR object_version_id IS DISTINCT FROM job_version_id
       OR object_route_id IS DISTINCT FROM job_route_id
       OR NEW.configuration_route_target_id IS NOT NULL
       OR NEW.configuration_vault_id IS DISTINCT FROM job_target_vault_id
       OR NEW.provider_connection_id IS DISTINCT FROM vault_provider_connection_id
       OR NEW.target_role IS DISTINCT FROM 'primary'
       OR NEW.target_order IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION '0011 derivative copy authority mismatch for storage object %', NEW.storage_object_id;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.configuration_route_target_id IS NULL THEN
    RETURN NEW;
  END IF;

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

CREATE TABLE public.storage_image_derivative_outputs (
  image_derivative_output_id uuid PRIMARY KEY,
  image_derivative_job_id uuid NOT NULL UNIQUE
    REFERENCES public.storage_image_derivative_jobs(image_derivative_job_id) ON DELETE RESTRICT,
  source_storage_object_id uuid NOT NULL
    REFERENCES public.storage_objects(storage_object_id) ON DELETE RESTRICT,
  output_storage_object_id uuid NOT NULL UNIQUE
    REFERENCES public.storage_objects(storage_object_id) ON DELETE RESTRICT,
  width integer NOT NULL CHECK (width BETWEEN 16 AND 16384),
  output_format text NOT NULL CHECK (output_format IN ('webp', 'avif', 'jpeg', 'png')),
  verified_byte_length bigint NOT NULL CHECK (verified_byte_length > 0),
  verified_checksum_sha256 text NOT NULL CHECK (verified_checksum_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_storage_object_id <> output_storage_object_id)
);

CREATE INDEX storage_image_derivative_outputs_source_idx
  ON public.storage_image_derivative_outputs (source_storage_object_id, created_at DESC);

CREATE FUNCTION public.z_s_image_derivative_output_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  job_source_id uuid;
  job_client_id uuid;
  job_version_id uuid;
  job_fingerprint text;
  job_route_id uuid;
  job_width integer;
  job_format text;
  source_client_id uuid;
  source_version_id uuid;
  source_fingerprint text;
  source_route_id uuid;
  output_client_id uuid;
  output_version_id uuid;
  output_fingerprint text;
  output_route_id uuid;
  output_job_id uuid;
  output_state text;
  output_length bigint;
  output_checksum text;
  verified_copy_count bigint;
BEGIN
  SELECT source_storage_object_id,
         storage_control_client_id,
         configuration_version_id,
         configuration_fingerprint,
         configuration_route_id,
         requested_width,
         output_format
    INTO job_source_id,
         job_client_id,
         job_version_id,
         job_fingerprint,
         job_route_id,
         job_width,
         job_format
    FROM public.storage_image_derivative_jobs
   WHERE image_derivative_job_id = NEW.image_derivative_job_id;

  SELECT storage_control_client_id, configuration_version_id, configuration_fingerprint,
         configuration_route_id
    INTO source_client_id, source_version_id, source_fingerprint, source_route_id
    FROM public.storage_objects
   WHERE storage_object_id = NEW.source_storage_object_id;

  SELECT storage_control_client_id, configuration_version_id, configuration_fingerprint,
         configuration_route_id, image_derivative_job_id, registry_state,
         verified_byte_length, verified_checksum_sha256
    INTO output_client_id, output_version_id, output_fingerprint, output_route_id,
         output_job_id, output_state, output_length, output_checksum
    FROM public.storage_objects
   WHERE storage_object_id = NEW.output_storage_object_id;

  SELECT count(*)
    INTO verified_copy_count
    FROM public.storage_object_copies
   WHERE storage_object_id = NEW.output_storage_object_id
     AND image_derivative_job_id = NEW.image_derivative_job_id
     AND copy_state = 'verified'
     AND observed_byte_length = NEW.verified_byte_length
     AND observed_checksum_sha256 = NEW.verified_checksum_sha256;

  IF job_source_id IS DISTINCT FROM NEW.source_storage_object_id
     OR job_width IS DISTINCT FROM NEW.width
     OR job_format IS DISTINCT FROM NEW.output_format
     OR source_client_id IS DISTINCT FROM job_client_id
     OR source_version_id IS DISTINCT FROM job_version_id
     OR source_fingerprint IS DISTINCT FROM job_fingerprint
     OR source_route_id IS DISTINCT FROM job_route_id
     OR output_client_id IS DISTINCT FROM job_client_id
     OR output_version_id IS DISTINCT FROM job_version_id
     OR output_fingerprint IS DISTINCT FROM job_fingerprint
     OR output_route_id IS DISTINCT FROM job_route_id
     OR output_job_id IS DISTINCT FROM NEW.image_derivative_job_id
     OR output_state <> 'active'
     OR output_length IS DISTINCT FROM NEW.verified_byte_length
     OR output_checksum IS DISTINCT FROM NEW.verified_checksum_sha256
     OR verified_copy_count <> 1 THEN
    RAISE EXCEPTION '0011 derivative output lineage mismatch for job %', NEW.image_derivative_job_id;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER z_s_image_derivative_output_guard_trigger
BEFORE INSERT OR UPDATE ON public.storage_image_derivative_outputs
FOR EACH ROW EXECUTE FUNCTION public.z_s_image_derivative_output_guard();

COMMENT ON TABLE public.storage_image_derivative_jobs IS
  'Bounded image-only derivative work with immutable source configuration and preset snapshots for T2 H05.';
COMMENT ON TABLE public.storage_image_derivative_outputs IS
  'Verified one-to-one lineage from a T2 H05 derivative job to a separate normal storage object.';
COMMENT ON COLUMN public.storage_objects.image_derivative_job_id IS
  'T2 H05 job authority for a generated output object; null for source and non-derivative objects.';
COMMENT ON COLUMN public.storage_object_copies.image_derivative_job_id IS
  'T2 H05 job authority for a derivative copy written only to the immutable preset target vault.';
COMMENT ON FUNCTION public.z_s_image_derivative_job_guard() IS
  'Rejects jobs that do not match a verified image source and its immutable configuration preset.';
COMMENT ON FUNCTION public.z_s_image_derivative_output_guard() IS
  'Rejects derivative lineage unless the output object and verified copy match the immutable job authority.';
COMMENT ON FUNCTION public.z_s_runtime_configuration_copy_guard() IS
  'Enforces route-target authority for normal configured copies and immutable preset-vault authority for T2 H05 derivative copies.';
COMMENT ON INDEX public.storage_image_derivative_jobs_claim_idx IS
  'Supports bounded queued, retryable-failed, and expired-lease derivative claims.';
COMMENT ON INDEX public.storage_image_derivative_jobs_client_status_idx IS
  'Supports bounded same-client and same-environment derivative status reads.';
COMMENT ON INDEX public.storage_objects_image_derivative_job_idx IS
  'Prevents retries or concurrent workers from reserving multiple output objects for one derivative job.';
COMMENT ON INDEX public.storage_object_copies_image_derivative_job_idx IS
  'Prevents retries or concurrent workers from reserving multiple output copies for one derivative job.';

COMMIT;
