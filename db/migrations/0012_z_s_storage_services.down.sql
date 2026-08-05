BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.storage_control_provider_connections
    WHERE storage_service_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0012 rollback blocked: provider connections reference storage services';
  END IF;
  IF EXISTS (SELECT 1 FROM public.storage_control_provider_secrets) THEN
    RAISE EXCEPTION '0012 rollback blocked: encrypted provider secrets exist';
  END IF;
  IF EXISTS (SELECT 1 FROM public.storage_control_storage_service_events) THEN
    RAISE EXCEPTION '0012 rollback blocked: storage service events exist';
  END IF;
  IF EXISTS (SELECT 1 FROM public.storage_control_storage_services) THEN
    RAISE EXCEPTION '0012 rollback blocked: storage services exist';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS z_s_storage_service_connection_guard_trigger
  ON public.storage_control_provider_connections;
DROP FUNCTION IF EXISTS public.z_s_storage_service_connection_guard();
DROP INDEX IF EXISTS public.storage_control_provider_connections_service_idx;
ALTER TABLE public.storage_control_provider_connections
  DROP CONSTRAINT IF EXISTS storage_control_provider_connections_service_reference_check,
  DROP CONSTRAINT IF EXISTS storage_control_provider_connections_service_fk,
  DROP COLUMN IF EXISTS storage_service_id;

DROP TABLE public.storage_control_storage_service_events;
ALTER TABLE public.storage_control_storage_services
  DROP CONSTRAINT storage_control_storage_services_active_secret_fk,
  DROP CONSTRAINT storage_control_storage_services_secret_state_check;
DROP TABLE public.storage_control_provider_secrets;
DROP TABLE public.storage_control_storage_services;

COMMIT;
