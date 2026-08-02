BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.storage_control_configuration_image_presets
  DROP CONSTRAINT storage_control_configuratio_storage_control_client_id_co_fkey2,
  ADD CONSTRAINT storage_control_configuratio_storage_control_client_id_co_fkey2
    FOREIGN KEY (storage_control_client_id, configuration_version_id, target_vault_id)
    REFERENCES public.storage_control_configuration_vaults(
      storage_control_client_id, configuration_version_id, id
    )
    ON DELETE RESTRICT;

ALTER TABLE public.storage_control_configuration_routes
  DROP CONSTRAINT storage_control_configuratio_storage_control_client_id_co_fkey4,
  ADD CONSTRAINT storage_control_configuratio_storage_control_client_id_co_fkey4
    FOREIGN KEY (storage_control_client_id, configuration_version_id, image_preset_id)
    REFERENCES public.storage_control_configuration_image_presets(
      storage_control_client_id, configuration_version_id, id
    )
    ON DELETE RESTRICT;

ALTER TABLE public.storage_control_configuration_route_targets
  DROP CONSTRAINT storage_control_configuratio_storage_control_client_id_co_fkey6,
  ADD CONSTRAINT storage_control_configuratio_storage_control_client_id_co_fkey6
    FOREIGN KEY (storage_control_client_id, configuration_version_id, vault_id)
    REFERENCES public.storage_control_configuration_vaults(
      storage_control_client_id, configuration_version_id, id
    )
    ON DELETE RESTRICT;

COMMIT;
