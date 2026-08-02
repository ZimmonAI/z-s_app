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
    'storage_control_configuration_route_targets',
    'storage_control_configuration_vaults',
    'storage_control_provider_connections',
    'object_write_intents',
    'storage_objects',
    'storage_object_copies'
  ]
  LOOP
    IF to_regclass(format('public.%I', expected_table)) IS NULL THEN
      RAISE EXCEPTION '0010 preflight missing required table public.%', expected_table;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('object_write_intents', 'storage_objects', 'storage_object_copies')
       AND column_name IN (
         'storage_control_client_id', 'configuration_version_id',
         'configuration_fingerprint', 'configuration_route_id',
         'configuration_route_target_id', 'configuration_vault_id',
         'provider_connection_id', 'target_role', 'target_order'
       )
  ) THEN
    RAISE EXCEPTION '0010 migration already applied: runtime configuration routing columns exist';
  END IF;
END
$$;

ALTER TABLE public.storage_objects
  ALTER COLUMN managed_app_id DROP NOT NULL,
  ALTER COLUMN storage_profile_id DROP NOT NULL,
  ALTER COLUMN storage_profile_fingerprint DROP NOT NULL,
  ALTER COLUMN storage_prefix_class_id DROP NOT NULL,
  ADD COLUMN storage_control_client_id uuid NULL,
  ADD COLUMN configuration_version_id uuid NULL,
  ADD COLUMN configuration_fingerprint text NULL,
  ADD COLUMN configuration_route_id uuid NULL;

ALTER TABLE public.object_write_intents
  ALTER COLUMN managed_app_id DROP NOT NULL,
  ALTER COLUMN storage_profile_id DROP NOT NULL,
  ALTER COLUMN storage_profile_fingerprint DROP NOT NULL,
  ALTER COLUMN storage_prefix_class_id DROP NOT NULL,
  ADD COLUMN storage_control_client_id uuid NULL,
  ADD COLUMN configuration_version_id uuid NULL,
  ADD COLUMN configuration_fingerprint text NULL,
  ADD COLUMN configuration_route_id uuid NULL;

ALTER TABLE public.storage_object_copies
  ALTER COLUMN storage_profile_provider_binding_id DROP NOT NULL,
  ALTER COLUMN provider_role DROP NOT NULL,
  ADD COLUMN configuration_route_target_id uuid NULL,
  ADD COLUMN configuration_vault_id uuid NULL,
  ADD COLUMN provider_connection_id uuid NULL,
  ADD COLUMN target_role text NULL,
  ADD COLUMN target_order smallint NULL;

ALTER TABLE public.storage_objects
  ADD CONSTRAINT storage_objects_configuration_client_fk
    FOREIGN KEY (storage_control_client_id)
    REFERENCES public.storage_control_clients(id) ON DELETE RESTRICT,
  ADD CONSTRAINT storage_objects_configuration_version_fk
    FOREIGN KEY (storage_control_client_id, configuration_version_id)
    REFERENCES public.storage_control_configuration_versions(storage_control_client_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT storage_objects_configuration_route_fk
    FOREIGN KEY (storage_control_client_id, configuration_version_id, configuration_route_id)
    REFERENCES public.storage_control_configuration_routes(
      storage_control_client_id, configuration_version_id, id
    ) ON DELETE RESTRICT,
  ADD CONSTRAINT storage_objects_configuration_fingerprint_check
    CHECK (
      configuration_fingerprint IS NULL
      OR configuration_fingerprint ~ '^[a-f0-9]{64}$'
    ),
  ADD CONSTRAINT storage_objects_authority_exclusive_check
    CHECK (
      (
        managed_app_id IS NOT NULL
        AND storage_profile_id IS NOT NULL
        AND storage_profile_fingerprint IS NOT NULL
        AND storage_prefix_class_id IS NOT NULL
        AND storage_control_client_id IS NULL
        AND configuration_version_id IS NULL
        AND configuration_fingerprint IS NULL
        AND configuration_route_id IS NULL
      )
      OR
      (
        managed_app_id IS NULL
        AND storage_profile_id IS NULL
        AND storage_profile_fingerprint IS NULL
        AND storage_prefix_class_id IS NULL
        AND storage_control_client_id IS NOT NULL
        AND configuration_version_id IS NOT NULL
        AND configuration_fingerprint IS NOT NULL
        AND configuration_route_id IS NOT NULL
      )
    );

ALTER TABLE public.object_write_intents
  ADD CONSTRAINT object_write_intents_configuration_client_fk
    FOREIGN KEY (storage_control_client_id)
    REFERENCES public.storage_control_clients(id) ON DELETE RESTRICT,
  ADD CONSTRAINT object_write_intents_configuration_version_fk
    FOREIGN KEY (storage_control_client_id, configuration_version_id)
    REFERENCES public.storage_control_configuration_versions(storage_control_client_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT object_write_intents_configuration_route_fk
    FOREIGN KEY (storage_control_client_id, configuration_version_id, configuration_route_id)
    REFERENCES public.storage_control_configuration_routes(
      storage_control_client_id, configuration_version_id, id
    ) ON DELETE RESTRICT,
  ADD CONSTRAINT object_write_intents_configuration_fingerprint_check
    CHECK (
      configuration_fingerprint IS NULL
      OR configuration_fingerprint ~ '^[a-f0-9]{64}$'
    ),
  ADD CONSTRAINT object_write_intents_authority_exclusive_check
    CHECK (
      (
        managed_app_id IS NOT NULL
        AND storage_profile_id IS NOT NULL
        AND storage_profile_fingerprint IS NOT NULL
        AND storage_prefix_class_id IS NOT NULL
        AND storage_control_client_id IS NULL
        AND configuration_version_id IS NULL
        AND configuration_fingerprint IS NULL
        AND configuration_route_id IS NULL
      )
      OR
      (
        managed_app_id IS NULL
        AND storage_profile_id IS NULL
        AND storage_profile_fingerprint IS NULL
        AND storage_prefix_class_id IS NULL
        AND storage_control_client_id IS NOT NULL
        AND configuration_version_id IS NOT NULL
        AND configuration_fingerprint IS NOT NULL
        AND configuration_route_id IS NOT NULL
      )
    );

ALTER TABLE public.storage_object_copies
  DROP CONSTRAINT storage_object_copies_storage_object_id_provider_role_key,
  ADD CONSTRAINT storage_object_copies_configuration_route_target_fk
    FOREIGN KEY (configuration_route_target_id)
    REFERENCES public.storage_control_configuration_route_targets(id) ON DELETE RESTRICT,
  ADD CONSTRAINT storage_object_copies_configuration_vault_fk
    FOREIGN KEY (configuration_vault_id)
    REFERENCES public.storage_control_configuration_vaults(id) ON DELETE RESTRICT,
  ADD CONSTRAINT storage_object_copies_provider_connection_fk
    FOREIGN KEY (provider_connection_id)
    REFERENCES public.storage_control_provider_connections(id) ON DELETE RESTRICT,
  ADD CONSTRAINT storage_object_copies_target_role_check
    CHECK (target_role IS NULL OR target_role IN ('primary', 'replica')),
  ADD CONSTRAINT storage_object_copies_target_order_check
    CHECK (
      (target_role IS NULL AND target_order IS NULL)
      OR (target_role = 'primary' AND target_order = 0)
      OR (target_role = 'replica' AND target_order > 0)
    ),
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

CREATE UNIQUE INDEX storage_object_copies_legacy_role_idx
  ON public.storage_object_copies (storage_object_id, provider_role)
  WHERE provider_role IS NOT NULL;
CREATE UNIQUE INDEX storage_object_copies_configuration_target_idx
  ON public.storage_object_copies (storage_object_id, configuration_route_target_id)
  WHERE configuration_route_target_id IS NOT NULL;
CREATE INDEX storage_object_copies_configuration_read_order_idx
  ON public.storage_object_copies (storage_object_id, target_role, target_order)
  WHERE configuration_route_target_id IS NOT NULL;
CREATE INDEX object_write_intents_client_state_expiry_idx
  ON public.object_write_intents (storage_control_client_id, state, expires_at)
  WHERE storage_control_client_id IS NOT NULL;
CREATE INDEX storage_objects_configuration_route_idx
  ON public.storage_objects (
    storage_control_client_id, configuration_version_id, configuration_route_id, created_at DESC
  ) WHERE storage_control_client_id IS NOT NULL;

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

COMMENT ON COLUMN public.object_write_intents.storage_control_client_id IS
  'Authenticated client authority persisted by T2 H03. Source: z-kn/08-execution/z-s_app-mvp/tasks/planning/t2-client-storage-workspace/handoffs/03-online-generic-runtime-routing-coding.md';
COMMENT ON COLUMN public.object_write_intents.configuration_version_id IS
  'Immutable active configuration version selected by T2 H03.';
COMMENT ON COLUMN public.object_write_intents.configuration_fingerprint IS
  'Safe SHA-256 configuration authority fingerprint selected by T2 H03.';
COMMENT ON COLUMN public.object_write_intents.configuration_route_id IS
  'Server-selected asset-class route persisted by T2 H03.';
COMMENT ON COLUMN public.storage_objects.storage_control_client_id IS
  'Authenticated client authority persisted by T2 H03.';
COMMENT ON COLUMN public.storage_objects.configuration_version_id IS
  'Immutable active configuration version selected by T2 H03.';
COMMENT ON COLUMN public.storage_objects.configuration_fingerprint IS
  'Safe SHA-256 configuration authority fingerprint selected by T2 H03.';
COMMENT ON COLUMN public.storage_objects.configuration_route_id IS
  'Server-selected asset-class route persisted by T2 H03.';
COMMENT ON COLUMN public.storage_object_copies.configuration_route_target_id IS
  'Persisted route-target identity selected by T2 H03.';
COMMENT ON COLUMN public.storage_object_copies.configuration_vault_id IS
  'Persisted configuration vault identity selected by T2 H03.';
COMMENT ON COLUMN public.storage_object_copies.provider_connection_id IS
  'Persisted provider connection identity selected by T2 H03.';
COMMENT ON COLUMN public.storage_object_copies.target_role IS
  'Provider-neutral primary or replica role selected by T2 H03.';
COMMENT ON COLUMN public.storage_object_copies.target_order IS
  'Deterministic primary/replica execution and read order selected by T2 H03.';
COMMENT ON FUNCTION public.z_s_runtime_configuration_copy_guard() IS
  'Enforces cross-table client/configuration/route ownership for T2 H03 persisted copies.';
COMMENT ON TRIGGER z_s_runtime_configuration_copy_guard_trigger ON public.storage_object_copies IS
  'Rejects configuration-routed copies whose persisted target provenance conflicts with the owning object. Source: z-kn/08-execution/z-s_app-mvp/tasks/planning/t2-client-storage-workspace/handoffs/03-online-generic-runtime-routing-coding.md';

COMMENT ON CONSTRAINT storage_objects_configuration_client_fk ON public.storage_objects IS
  'T2 H03 client authority must reference the accepted client storage configuration platform.';
COMMENT ON CONSTRAINT storage_objects_configuration_version_fk ON public.storage_objects IS
  'T2 H03 objects remain bound to the immutable configuration version selected at write-intent creation.';
COMMENT ON CONSTRAINT storage_objects_configuration_route_fk ON public.storage_objects IS
  'T2 H03 objects persist the server-selected asset-class route under the same client and version.';
COMMENT ON CONSTRAINT storage_objects_authority_exclusive_check ON public.storage_objects IS
  'T2 H03 prevents partial or mixed legacy-profile and client-configuration authority.';
COMMENT ON CONSTRAINT object_write_intents_configuration_client_fk ON public.object_write_intents IS
  'T2 H03 write intents persist authenticated client authority.';
COMMENT ON CONSTRAINT object_write_intents_configuration_version_fk ON public.object_write_intents IS
  'T2 H03 write intents persist the immutable active configuration version.';
COMMENT ON CONSTRAINT object_write_intents_configuration_route_fk ON public.object_write_intents IS
  'T2 H03 write intents persist the server-selected asset-class route.';
COMMENT ON CONSTRAINT object_write_intents_authority_exclusive_check ON public.object_write_intents IS
  'T2 H03 prevents partial or mixed legacy-profile and client-configuration authority.';
COMMENT ON CONSTRAINT storage_object_copies_configuration_route_target_fk ON public.storage_object_copies IS
  'T2 H03 copies reference one persisted configuration route target.';
COMMENT ON CONSTRAINT storage_object_copies_configuration_vault_fk ON public.storage_object_copies IS
  'T2 H03 copies reference the selected configuration vault.';
COMMENT ON CONSTRAINT storage_object_copies_provider_connection_fk ON public.storage_object_copies IS
  'T2 H03 copies reference the selected provider connection metadata.';
COMMENT ON CONSTRAINT storage_object_copies_target_role_check ON public.storage_object_copies IS
  'T2 H03 uses provider-neutral primary and replica roles.';
COMMENT ON CONSTRAINT storage_object_copies_target_order_check ON public.storage_object_copies IS
  'T2 H03 requires primary order zero and positive replica order.';
COMMENT ON CONSTRAINT storage_object_copies_authority_exclusive_check ON public.storage_object_copies IS
  'T2 H03 prevents partial or mixed legacy binding and configured target authority.';

COMMENT ON INDEX public.storage_object_copies_configuration_target_idx IS
  'T2 H03 enforces one copy per object and persisted configuration route target.';
COMMENT ON INDEX public.storage_object_copies_configuration_read_order_idx IS
  'T2 H03 supports replica-order then primary configured read selection.';
COMMENT ON INDEX public.object_write_intents_client_state_expiry_idx IS
  'T2 H03 supports client-scoped write-intent lifecycle lookups.';
COMMENT ON INDEX public.storage_objects_configuration_route_idx IS
  'T2 H03 supports immutable configuration provenance lookup for stored objects.';

COMMIT;
