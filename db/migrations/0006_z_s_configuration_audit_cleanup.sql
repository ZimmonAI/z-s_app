BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.storage_control_configuration_audit_events
  DROP CONSTRAINT storage_control_configuration_aud_configuration_version_id_fkey,
  DROP CONSTRAINT storage_control_configuration_audit_e_integration_token_id_fkey,
  ADD CONSTRAINT storage_control_configuration_aud_configuration_version_id_fkey
    FOREIGN KEY (configuration_version_id)
    REFERENCES public.storage_control_configuration_versions(id)
    ON DELETE SET NULL,
  ADD CONSTRAINT storage_control_configuration_audit_e_integration_token_id_fkey
    FOREIGN KEY (integration_token_id)
    REFERENCES public.storage_control_integration_tokens(id)
    ON DELETE SET NULL;

COMMENT ON CONSTRAINT storage_control_configuration_aud_configuration_version_id_fkey
  ON public.storage_control_configuration_audit_events
  IS 'Audit history survives draft cleanup; deleted configuration references are nulled, not cascaded. Ref: z-kn/08-execution/z-s_app-mvp/tasks/planning/t2-client-storage-workspace/reports/02-local-configuration-platform-verification-result.md';

COMMENT ON CONSTRAINT storage_control_configuration_audit_e_integration_token_id_fkey
  ON public.storage_control_configuration_audit_events
  IS 'Audit history survives integration-token metadata cleanup; deleted token references are nulled, not cascaded. Ref: z-kn/08-execution/z-s_app-mvp/tasks/planning/t2-client-storage-workspace/reports/02-local-configuration-platform-verification-result.md';

COMMIT;
