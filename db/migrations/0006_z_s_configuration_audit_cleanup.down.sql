BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.storage_control_configuration_audit_events
  DROP CONSTRAINT storage_control_configuration_aud_configuration_version_id_fkey,
  DROP CONSTRAINT storage_control_configuration_audit_e_integration_token_id_fkey,
  ADD CONSTRAINT storage_control_configuration_aud_configuration_version_id_fkey
    FOREIGN KEY (configuration_version_id)
    REFERENCES public.storage_control_configuration_versions(id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT storage_control_configuration_audit_e_integration_token_id_fkey
    FOREIGN KEY (integration_token_id)
    REFERENCES public.storage_control_integration_tokens(id)
    ON DELETE RESTRICT;

COMMIT;
