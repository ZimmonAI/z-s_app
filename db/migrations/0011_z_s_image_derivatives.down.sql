BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  adopted_rows bigint;
BEGIN
  IF to_regclass('public.storage_image_derivative_jobs') IS NULL
     OR to_regclass('public.storage_image_derivative_outputs') IS NULL THEN
    RAISE EXCEPTION '0011 rollback refused: migration is not applied';
  END IF;

  SELECT
    (SELECT count(*) FROM public.storage_image_derivative_jobs)
    + (SELECT count(*) FROM public.storage_image_derivative_outputs)
    + (SELECT count(*) FROM public.storage_objects WHERE image_derivative_job_id IS NOT NULL)
    + (SELECT count(*) FROM public.storage_object_copies WHERE image_derivative_job_id IS NOT NULL)
    INTO adopted_rows;

  IF adopted_rows <> 0 THEN
    RAISE EXCEPTION '0011 rollback blocked: adopted derivative rows exist (%)', adopted_rows;
  END IF;
END
$$;

DROP TRIGGER z_s_image_derivative_output_guard_trigger ON public.storage_image_derivative_outputs;
DROP FUNCTION public.z_s_image_derivative_output_guard();
DROP INDEX public.storage_image_derivative_outputs_source_idx;
DROP TABLE public.storage_image_derivative_outputs;

DROP TRIGGER z_s_runtime_configuration_copy_guard_trigger ON public.storage_object_copies;
DROP FUNCTION public.z_s_runtime_configuration_copy_guard();

DROP INDEX public.storage_object_copies_image_derivative_job_idx;
DROP INDEX public.storage_objects_image_derivative_job_idx;

ALTER TABLE public.storage_object_copies
  DROP CONSTRAINT storage_object_copies_authority_exclusive_check,
  DROP CONSTRAINT storage_object_copies_image_derivative_job_fk,
  DROP COLUMN image_derivative_job_id,
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
      )
    );

ALTER TABLE public.storage_objects
  DROP CONSTRAINT storage_objects_image_derivative_job_fk,
  DROP COLUMN image_derivative_job_id;

CREATE FUNCTION public.z_s_runtime_configuration_copy_guard()
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
BEGIN
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
  target_order
ON public.storage_object_copies
FOR EACH ROW EXECUTE FUNCTION public.z_s_runtime_configuration_copy_guard();

DROP TRIGGER z_s_image_derivative_job_guard_trigger ON public.storage_image_derivative_jobs;
DROP FUNCTION public.z_s_image_derivative_job_guard();
DROP INDEX public.storage_image_derivative_jobs_client_status_idx;
DROP INDEX public.storage_image_derivative_jobs_claim_idx;
DROP TABLE public.storage_image_derivative_jobs;

COMMENT ON FUNCTION public.z_s_runtime_configuration_copy_guard() IS
  'Enforces cross-table client/configuration/route ownership for T2 H03 persisted copies.';

COMMIT;
