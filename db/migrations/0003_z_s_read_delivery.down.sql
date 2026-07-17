BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  row_total bigint;
BEGIN
  IF to_regclass('public.object_read_grants') IS NULL THEN
    RAISE EXCEPTION '2B-07 rollback missing table public.object_read_grants';
  END IF;
  SELECT count(*) INTO row_total FROM public.object_read_grants;
  IF row_total <> 0 THEN
    RAISE EXCEPTION '2B-07 rollback blocked: public.object_read_grants contains % adopted rows', row_total;
  END IF;
END
$$;

DROP TABLE public.object_read_grants;

COMMIT;
