BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.storage_control_configuration_child_guard()
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

  IF version_state IS NULL AND TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  IF version_state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION '0005 configuration children are mutable only while the version is draft: %', version_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.storage_control_configuration_audit_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '0005 configuration audit events are append-only';
  END IF;

  IF TG_OP = 'UPDATE'
     AND pg_trigger_depth() > 1
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.storage_control_client_id IS NOT DISTINCT FROM OLD.storage_control_client_id
     AND NEW.environment IS NOT DISTINCT FROM OLD.environment
     AND NEW.event_type IS NOT DISTINCT FROM OLD.event_type
     AND NEW.actor_kind IS NOT DISTINCT FROM OLD.actor_kind
     AND NEW.actor_reference IS NOT DISTINCT FROM OLD.actor_reference
     AND NEW.safe_summary IS NOT DISTINCT FROM OLD.safe_summary
     AND NEW.occurred_at IS NOT DISTINCT FROM OLD.occurred_at
     AND (
       NEW.configuration_version_id IS NOT DISTINCT FROM OLD.configuration_version_id
       OR (OLD.configuration_version_id IS NOT NULL AND NEW.configuration_version_id IS NULL)
     )
     AND (
       NEW.integration_token_id IS NOT DISTINCT FROM OLD.integration_token_id
       OR (OLD.integration_token_id IS NOT NULL AND NEW.integration_token_id IS NULL)
     )
     AND (
       (OLD.configuration_version_id IS NOT NULL AND NEW.configuration_version_id IS NULL)
       OR (OLD.integration_token_id IS NOT NULL AND NEW.integration_token_id IS NULL)
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '0005 configuration audit events are append-only';
END
$$;

COMMENT ON FUNCTION public.storage_control_configuration_child_guard()
  IS 'Allows FK-triggered draft-version cascade cleanup while preserving direct active/superseded child immutability. Ref: z-kn/08-execution/z-s_app-mvp/tasks/planning/t2-client-storage-workspace/reports/02-local-configuration-platform-verification-result.md';

COMMENT ON FUNCTION public.storage_control_configuration_audit_append_only()
  IS 'Append-only audit guard that permits only FK-triggered nullification of deleted cleanup references. Ref: z-kn/08-execution/z-s_app-mvp/tasks/planning/t2-client-storage-workspace/reports/02-local-configuration-platform-verification-result.md';

COMMIT;
