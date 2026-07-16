BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  runtime_table text;
  row_total bigint;
BEGIN
  FOREACH runtime_table IN ARRAY ARRAY[
    'storage_idempotency_records',
    'storage_reconciliation_issues',
    'storage_operation_events',
    'storage_provider_attempts',
    'storage_object_copies',
    'object_write_intents',
    'storage_objects'
  ]
  LOOP
    IF to_regclass(format('public.%I', runtime_table)) IS NULL THEN
      RAISE EXCEPTION '2B-04 rollback missing table public.%', runtime_table;
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I', runtime_table) INTO row_total;
    IF row_total <> 0 THEN
      RAISE EXCEPTION '2B-04 rollback blocked: public.% contains % adopted rows', runtime_table, row_total;
    END IF;
  END LOOP;
END
$$;

DROP TRIGGER storage_provider_attempts_history_trigger ON public.storage_provider_attempts;
DROP FUNCTION public.z_s_runtime_protect_provider_attempt_history();
DROP TRIGGER storage_operation_events_append_only_trigger ON public.storage_operation_events;
DROP FUNCTION public.z_s_runtime_reject_event_mutation();

DROP TABLE public.storage_idempotency_records;
DROP TABLE public.storage_reconciliation_issues;
DROP TABLE public.storage_operation_events;
DROP TABLE public.storage_provider_attempts;
DROP TABLE public.storage_object_copies;
DROP TABLE public.object_write_intents;
DROP TABLE public.storage_objects;

COMMIT;
