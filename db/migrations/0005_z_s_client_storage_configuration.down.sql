BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  row_total bigint;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'storage_control_configuration_audit_events',
    'storage_control_integration_tokens',
    'storage_control_configuration_route_targets',
    'storage_control_configuration_routes',
    'storage_control_configuration_image_presets',
    'storage_control_configuration_vaults',
    'storage_control_configuration_versions',
    'storage_control_provider_connections'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NULL THEN
      RAISE EXCEPTION '0005 rollback missing table public.%', table_name;
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I', table_name) INTO row_total;
    IF row_total <> 0 THEN
      RAISE EXCEPTION '0005 rollback blocked: public.% contains % adopted rows', table_name, row_total;
    END IF;
  END LOOP;
END
$$;

DROP TABLE public.storage_control_configuration_audit_events;
DROP TABLE public.storage_control_integration_tokens;
DROP TABLE public.storage_control_configuration_route_targets;
DROP TABLE public.storage_control_configuration_routes;
DROP TABLE public.storage_control_configuration_image_presets;
DROP TABLE public.storage_control_configuration_vaults;
DROP TABLE public.storage_control_configuration_versions;
DROP TABLE public.storage_control_provider_connections;

DROP FUNCTION public.storage_control_configuration_audit_append_only();
DROP FUNCTION public.storage_control_configuration_child_guard();
DROP FUNCTION public.storage_control_configuration_version_guard();

COMMIT;
