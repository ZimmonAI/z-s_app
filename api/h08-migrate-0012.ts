import { readFile } from 'node:fs/promises';
import pg from 'pg';

const { Pool } = pg;

type RequestLike = Readonly<{
  method?: string;
  url?: string;
}>;

type ResponseLike = {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
};

function sendJson(response: ResponseLike, body: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(body));
}

async function inspect(pool: pg.Pool) {
  const result = await pool.query(`
    SELECT
      (
        SELECT count(*)::integer
        FROM pg_class AS c
        JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
      ) AS public_table_count,
      to_regclass('public.storage_image_derivative_jobs') IS NOT NULL AS derivative_jobs,
      to_regclass('public.storage_image_derivative_outputs') IS NOT NULL AS derivative_outputs,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'storage_objects'
          AND column_name = 'image_derivative_job_id'
      ) AS storage_objects_derivative_column,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'storage_object_copies'
          AND column_name = 'image_derivative_job_id'
      ) AS storage_copies_derivative_column,
      to_regclass('public.storage_control_storage_services') IS NOT NULL AS storage_services,
      to_regclass('public.storage_control_provider_secrets') IS NOT NULL AS provider_secrets,
      to_regclass('public.storage_control_storage_service_events') IS NOT NULL AS storage_service_events,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'storage_control_provider_connections'
          AND column_name = 'storage_service_id'
      ) AS provider_connection_service_column
  `);
  return result.rows[0];
}

export default async function handler(
  request: RequestLike,
  response: ResponseLike,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'https://internal.invalid');
  if (request.method !== 'GET') {
    sendJson(response, { error: { code: 'method-not-allowed' } }, 405);
    return;
  }

  const connectionString = process.env.Z_S_POSTGRES_URL?.trim();
  if (!connectionString) {
    sendJson(response, { error: { code: 'postgres-url-not-configured' } }, 503);
    return;
  }

  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    application_name: 'h08-guarded-migration-executor',
  });

  try {
    const mode = url.searchParams.get('mode');
    const confirm = url.searchParams.get('confirm');

    if (mode === 'inspect') {
      sendJson(response, { result: await inspect(pool) });
      return;
    }

    if (confirm !== 'apply-0011' && confirm !== 'apply-0012') {
      sendJson(response, { error: { code: 'migration-confirmation-required' } }, 400);
      return;
    }

    const before = await inspect(pool);

    if (confirm === 'apply-0011') {
      const alreadyApplied = Boolean(
        before?.derivative_jobs &&
        before?.derivative_outputs &&
        before?.storage_objects_derivative_column &&
        before?.storage_copies_derivative_column,
      );

      if (!alreadyApplied) {
        const migration = await readFile(
          new URL('../db/migrations/0011_z_s_image_derivatives.sql', import.meta.url),
          'utf8',
        );
        await pool.query(migration);
      }

      const after = await inspect(pool);
      const verified = Boolean(
        after?.derivative_jobs &&
        after?.derivative_outputs &&
        after?.storage_objects_derivative_column &&
        after?.storage_copies_derivative_column,
      );

      sendJson(response, {
        result: {
          migration: '0011_z_s_image_derivatives',
          appliedNow: !alreadyApplied,
          alreadyApplied,
          verified,
          publicTableCount: after?.public_table_count ?? null,
        },
      }, verified ? 200 : 500);
      return;
    }

    const alreadyApplied = Boolean(
      before?.storage_services &&
      before?.provider_secrets &&
      before?.storage_service_events &&
      before?.provider_connection_service_column,
    );

    if (!alreadyApplied) {
      const migration = await readFile(
        new URL('../db/migrations/0012_z_s_storage_services.sql', import.meta.url),
        'utf8',
      );
      await pool.query(migration);
    }

    const after = await inspect(pool);
    const verified = Boolean(
      after?.storage_services &&
      after?.provider_secrets &&
      after?.storage_service_events &&
      after?.provider_connection_service_column,
    );

    sendJson(response, {
      result: {
        migration: '0012_z_s_storage_services',
        appliedNow: !alreadyApplied,
        alreadyApplied,
        verified,
        publicTableCount: after?.public_table_count ?? null,
      },
    }, verified ? 200 : 500);
  } catch (error) {
    const candidate = error as { code?: unknown; message?: unknown };
    sendJson(response, {
      error: {
        code: 'h08-schema-operation-failed',
        sqlstate: typeof candidate?.code === 'string' ? candidate.code : null,
        message: typeof candidate?.message === 'string' ? candidate.message : 'schema operation failed',
      },
    }, 500);
  } finally {
    await pool.end().catch(() => undefined);
  }
}
