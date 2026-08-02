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

  IF version_state IS NULL AND TG_OP = 'DELETE' THEN
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
  RAISE EXCEPTION '0005 configuration audit events are append-only';
END
$$;

COMMIT;
