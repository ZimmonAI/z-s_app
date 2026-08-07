import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const { Pool } = pg;
const EXPECTED_TOKEN_SHA256 = 'f3a6c904141cb19e381777d10d14c4ab5b2fca3abe520b0e4ce1718314abf612';

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

function authorized(url: URL): boolean {
  const token = url.searchParams.get('token') ?? '';
  const digest = createHash('sha256').update(token, 'utf8').digest('hex');
  return digest === EXPECTED_TOKEN_SHA256;
}

async function schemaState(pool: pg.Pool) {
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
  if (request.method !== 'GET' || !authorized(url)) {
    sendJson(response, { error: { code: 'not-found' } }, 404);
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
    application_name: 'h08-temporary-migration-bootstrap',
  });

  try {
    const before = await schemaState(pool);

    const migration0011AlreadyApplied = Boolean(
      before?.derivative_jobs &&
      before?.derivative_outputs &&
      before?.storage_objects_derivative_column &&
      before?.storage_copies_derivative_column,
    );

    if (!migration0011AlreadyApplied) {
      const migration0011 = await readFile(
        new URL('../db/migrations/0011_z_s_image_derivatives.sql', import.meta.url),
        'utf8',
      );
      await pool.query(migration0011);
    }

    const after0011 = await schemaState(pool);
    const migration0011Verified = Boolean(
      after0011?.derivative_jobs &&
      after0011?.derivative_outputs &&
      after0011?.storage_objects_derivative_column &&
      after0011?.storage_copies_derivative_column,
    );

    if (!migration0011Verified) {
      sendJson(response, {
        error: { code: 'migration-0011-verification-failed' },
      }, 500);
      return;
    }

    const migration0012AlreadyApplied = Boolean(
      after0011?.storage_services &&
      after0011?.provider_secrets &&
      after0011?.storage_service_events &&
      after0011?.provider_connection_service_column,
    );

    if (!migration0012AlreadyApplied) {
      const migration0012 = await readFile(
        new URL('../db/migrations/0012_z_s_storage_services.sql', import.meta.url),
        'utf8',
      );
      await pool.query(migration0012);
    }

    const after0012 = await schemaState(pool);
    const migration0012Verified = Boolean(
      after0012?.storage_services &&
      after0012?.provider_secrets &&
      after0012?.storage_service_events &&
      after0012?.provider_connection_service_column,
    );

    sendJson(response, {
      result: {
        migration0011: {
          alreadyApplied: migration0011AlreadyApplied,
          appliedNow: !migration0011AlreadyApplied,
          verified: migration0011Verified,
        },
        migration0012: {
          alreadyApplied: migration0012AlreadyApplied,
          appliedNow: !migration0012AlreadyApplied,
          verified: migration0012Verified,
        },
        publicTableCount: after0012?.public_table_count ?? null,
      },
    }, migration0012Verified ? 200 : 500);
  } catch (error) {
    const candidate = error as { code?: unknown; message?: unknown };
    sendJson(response, {
      error: {
        code: 'h08-migration-bootstrap-failed',
        sqlstate: typeof candidate?.code === 'string' ? candidate.code : null,
        message: typeof candidate?.message === 'string' ? candidate.message : 'migration failed',
      },
    }, 500);
  } finally {
    await pool.end().catch(() => undefined);
  }
}
