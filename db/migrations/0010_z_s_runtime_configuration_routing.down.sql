BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  row_total bigint;
BEGIN
  IF to_regclass('public.object_write_intents') IS NULL
     OR to_regclass('public.storage_objects') IS NULL
     OR to_regclass('public.storage_object_copies') IS NULL THEN
    RAISE EXCEPTION '0010 rollback preflight missing runtime registry tables';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'storage_objects'
       AND column_name = 'configuration_version_id'
  ) THEN
    RAISE EXCEPTION '0010 rollback refused: migration is not applied';
  END IF;

  SELECT
    (SELECT count(*) FROM public.object_write_intents WHERE configuration_version_id IS NOT NULL)
    + (SELECT count(*) FROM public.storage_objects WHERE configuration_version_id IS NOT NULL)
    + (SELECT count(*) FROM public.storage_object_copies WHERE configuration_route_target_id IS NOT NULL)
    INTO row_total;

  IF row_total <> 0 THEN
    RAISE EXCEPTION '0010 rollback blocked: configuration-routed runtime rows exist (%)', row_total;
  END IF;
END
$$;

DROP TRIGGER z_s_runtime_configuration_copy_guard_trigger ON public.storage_object_copies;
DROP FUNCTION public.z_s_runtime_configuration_copy_guard();

DROP INDEX public.storage_objects_configuration_route_idx;
DROP INDEX public.object_write_intents_client_state_expiry_idx;
DROP INDEX public.storage_object_copies_configuration_read_order_idx;
DROP INDEX public.storage_object_copies_configuration_target_idx;
DROP INDEX public.storage_object_copies_legacy_role_idx;

ALTER TABLE public.storage_object_copies
  DROP CONSTRAINT storage_object_copies_authority_exclusive_check,
  DROP CONSTRAINT storage_object_copies_target_order_check,
  DROP CONSTRAINT storage_object_copies_target_role_check,
  DROP CONSTRAINT storage_object_copies_provider_connection_fk,
  DROP CONSTRAINT storage_object_copies_configuration_vault_fk,
  DROP CONSTRAINT storage_object_copies_configuration_route_target_fk,
  DROP COLUMN target_order,
  DROP COLUMN target_role,
  DROP COLUMN provider_connection_id,
  DROP COLUMN configuration_vault_id,
  DROP COLUMN configuration_route_target_id,
  ALTER COLUMN storage_profile_provider_binding_id SET NOT NULL,
  ALTER COLUMN provider_role SET NOT NULL,
  ADD CONSTRAINT storage_object_copies_storage_object_id_provider_role_key
    UNIQUE (storage_object_id, provider_role);

ALTER TABLE public.object_write_intents
  DROP CONSTRAINT object_write_intents_authority_exclusive_check,
  DROP CONSTRAINT object_write_intents_configuration_fingerprint_check,
  DROP CONSTRAINT object_write_intents_configuration_route_fk,
  DROP CONSTRAINT object_write_intents_configuration_version_fk,
  DROP CONSTRAINT object_write_intents_configuration_client_fk,
  DROP COLUMN configuration_route_id,
  DROP COLUMN configuration_fingerprint,
  DROP COLUMN configuration_version_id,
  DROP COLUMN storage_control_client_id,
  ALTER COLUMN storage_prefix_class_id SET NOT NULL,
  ALTER COLUMN storage_profile_fingerprint SET NOT NULL,
  ALTER COLUMN storage_profile_id SET NOT NULL,
  ALTER COLUMN managed_app_id SET NOT NULL;

ALTER TABLE public.storage_objects
  DROP CONSTRAINT storage_objects_authority_exclusive_check,
  DROP CONSTRAINT storage_objects_configuration_fingerprint_check,
  DROP CONSTRAINT storage_objects_configuration_route_fk,
  DROP CONSTRAINT storage_objects_configuration_version_fk,
  DROP CONSTRAINT storage_objects_configuration_client_fk,
  DROP COLUMN configuration_route_id,
  DROP COLUMN configuration_fingerprint,
  DROP COLUMN configuration_version_id,
  DROP COLUMN storage_control_client_id,
  ALTER COLUMN storage_prefix_class_id SET NOT NULL,
  ALTER COLUMN storage_profile_fingerprint SET NOT NULL,
  ALTER COLUMN storage_profile_id SET NOT NULL,
  ALTER COLUMN managed_app_id SET NOT NULL;

COMMIT;
