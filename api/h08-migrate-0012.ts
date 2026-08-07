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
    application_name: 'h08-schema-inspect-and-0012-migration',
  });

  try {
    if (url.searchParams.get('mode') === 'inspect') {
      const result = await pool.query(`
        SELECT
          (
            SELECT count(*)::integer
            FROM pg_class AS c
            JOIN pg_namespace AS n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind = 'r'
          ) AS public_table_count,
          to_regclass('public.storage_control_clients') IS NOT NULL AS storage_control_clients,
          to_regclass('public.storage_control_provider_connections') IS NOT NULL AS storage_control_provider_connections,
          to_regclass('public.storage_control_configuration_versions') IS NOT NULL AS storage_control_configuration_versions,
          to_regclass('public.storage_control_configuration_vaults') IS NOT NULL AS storage_control_configuration_vaults,
          to_regclass('public.storage_control_configuration_image_presets') IS NOT NULL AS storage_control_configuration_image_presets,
          to_regclass('public.storage_control_configuration_routes') IS NOT NULL AS storage_control_configuration_routes,
          to_regclass('public.storage_control_configuration_route_targets') IS NOT NULL AS storage_control_configuration_route_targets,
          to_regclass('public.storage_objects') IS NOT NULL AS storage_objects,
          to_regclass('public.storage_object_copies') IS NOT NULL AS storage_object_copies,
          to_regclass('public.storage_image_derivative_jobs') IS NOT NULL AS storage_image_derivative_jobs,
          to_regclass('public.storage_image_derivative_outputs') IS NOT NULL AS storage_image_derivative_outputs,
          to_regclass('public.storage_control_storage_services') IS NOT NULL AS storage_control_storage_services,
          to_regclass('public.storage_control_provider_secrets') IS NOT NULL AS storage_control_provider_secrets,
          to_regclass('public.storage_control_storage_service_events') IS NOT NULL AS storage_control_storage_service_events,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'storage_objects'
              AND column_name = 'configuration_version_id'
          ) AS storage_objects_configuration_version_id,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'storage_objects'
              AND column_name = 'configuration_fingerprint'
          ) AS storage_objects_configuration_fingerprint,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'storage_objects'
              AND column_name = 'configuration_route_id'
          ) AS storage_objects_configuration_route_id,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'storage_object_copies'
              AND column_name = 'configuration_route_target_id'
          ) AS storage_object_copies_configuration_route_target_id,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'storage_object_copies'
              AND column_name = 'configuration_vault_id'
          ) AS storage_object_copies_configuration_vault_id,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'storage_object_copies'
              AND column_name = 'provider_connection_id'
          ) AS storage_object_copies_provider_connection_id,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'storage_object_copies'
              AND column_name = 'target_role'
          ) AS storage_object_copies_target_role,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'storage_object_copies'
              AND column_name = 'target_order'
          ) AS storage_object_copies_target_order
      `);
      sendJson(response, { result: result.rows[0] });
      return;
    }

    if (url.searchParams.get('confirm') !== 'apply-0012') {
      sendJson(response, { error: { code: 'migration-confirmation-required' } }, 400);
      return;
    }

    const before = await pool.query(`
      SELECT
        to_regclass('public.storage_control_storage_services') IS NOT NULL AS services,
        to_regclass('public.storage_control_provider_secrets') IS NOT NULL AS secrets,
        to_regclass('public.storage_control_storage_service_events') IS NOT NULL AS events,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'storage_control_provider_connections'
            AND column_name = 'storage_service_id'
        ) AS connection_column
    `);

    const state = before.rows[0];
    const alreadyApplied = Boolean(
      state?.services && state?.secrets && state?.events && state?.connection_column,
    );

    if (!alreadyApplied) {
      const migration = await readFile(
        new URL('../db/migrations/0012_z_s_storage_services.sql', import.meta.url),
        'utf8',
      );
      await pool.query(migration);
    }

    const after = await pool.query(`
      SELECT
        to_regclass('public.storage_control_storage_services') IS NOT NULL AS services,
        to_regclass('public.storage_control_provider_secrets') IS NOT NULL AS secrets,
        to_regclass('public.storage_control_storage_service_events') IS NOT NULL AS events,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'storage_control_provider_connections'
            AND column_name = 'storage_service_id'
        ) AS connection_column
    `);

    const verified = after.rows[0];
    const complete = Boolean(
      verified?.services && verified?.secrets && verified?.events && verified?.connection_column,
    );

    sendJson(response, {
      result: {
        migration: '0012_z_s_storage_services',
        appliedNow: !alreadyApplied,
        alreadyApplied,
        verified: complete,
        objects: {
          storageControlStorageServices: Boolean(verified?.services),
          storageControlProviderSecrets: Boolean(verified?.secrets),
          storageControlStorageServiceEvents: Boolean(verified?.events),
          providerConnectionStorageServiceId: Boolean(verified?.connection_column),
        },
      },
    }, complete ? 200 : 500);
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
