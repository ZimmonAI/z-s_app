BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  row_total bigint;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'storage_control_client_tokens',
    'storage_control_image_derivative_rules',
    'storage_control_route_rules',
    'storage_control_vaults',
    'storage_control_clients'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NULL THEN
      RAISE EXCEPTION '0004 rollback missing table public.%', table_name;
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I', table_name) INTO row_total;
    IF row_total <> 0 THEN
      RAISE EXCEPTION '0004 rollback blocked: public.% contains % adopted rows', table_name, row_total;
    END IF;
  END LOOP;
END
$$;

DROP TABLE public.storage_control_client_tokens;
DROP TABLE public.storage_control_image_derivative_rules;
DROP TABLE public.storage_control_route_rules;
DROP TABLE public.storage_control_vaults;
DROP TABLE public.storage_control_clients;

COMMIT;
