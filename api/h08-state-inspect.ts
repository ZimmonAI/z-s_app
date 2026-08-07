import { createHash } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const EXPECTED_TOKEN_SHA256 = '612ed020df5e27a99a21f7b00cacacfe6fd8e03c645995d7f43edb3fa763e689';

type RequestLike = Readonly<{ method?: string; url?: string }>;
type ResponseLike = { statusCode: number; setHeader(name: string, value: string): void; end(body?: string): void };

function sendJson(response: ResponseLike, body: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(body));
}
function authorized(url: URL): boolean {
  const token = url.searchParams.get('token') ?? '';
  return createHash('sha256').update(token, 'utf8').digest('hex') === EXPECTED_TOKEN_SHA256;
}
function validServiceId(value: string): boolean {
  return /^h08-vercel-negative-[a-z0-9]{8}$/.test(value);
}
function safeDatabaseError(error: unknown) {
  const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown };
  return {
    sqlstate: typeof candidate?.code === 'string' ? candidate.code : null,
    constraint: typeof candidate?.constraint === 'string' ? candidate.constraint : null,
    message: typeof candidate?.message === 'string' ? candidate.message : null,
  };
}

export default async function handler(request: RequestLike, response: ResponseLike): Promise<void> {
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
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 5_000, application_name: 'h08-safe-state-inspect' });
  try {
    const mode = url.searchParams.get('mode');
    const serviceId = url.searchParams.get('serviceId')?.trim() ?? '';

    if (mode === 'probe-set-status') {
      if (!validServiceId(serviceId)) {
        sendJson(response, { error: { code: 'service-id-invalid' } }, 400);
        return;
      }
      const identity = await pool.query(`
        SELECT clients.client_id, services.environment
        FROM public.storage_control_storage_services AS services
        JOIN public.storage_control_clients AS clients ON clients.id = services.storage_control_client_id
        WHERE services.service_id = $1
        LIMIT 1
      `, [serviceId]);
      const row = identity.rows[0];
      if (!row) {
        sendJson(response, { error: { code: 'service-not-found' } }, 404);
        return;
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const now = new Date();
        const result = await client.query(`
UPDATE public.storage_control_storage_services AS services
SET status = $4,
    disabled_at = CASE WHEN $4 = 'disabled' THEN $5 ELSE NULL END,
    archived_at = CASE WHEN $4 = 'archived' THEN $5 ELSE NULL END,
    updated_at = $5
FROM public.storage_control_clients AS clients
WHERE clients.id = services.storage_control_client_id
  AND clients.client_id = $1
  AND services.environment = $2
  AND services.service_id = $3
RETURNING services.id
`, [row.client_id, row.environment, serviceId, 'archived', now]);
        await client.query('ROLLBACK');
        sendJson(response, { result: { setStatusWouldSucceed: result.rowCount === 1 } });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        sendJson(response, { result: { setStatusWouldSucceed: false, ...safeDatabaseError(error) } });
      } finally {
        client.release();
      }
      return;
    }

    if (mode === 'probe-dependencies') {
      if (!validServiceId(serviceId)) {
        sendJson(response, { error: { code: 'service-id-invalid' } }, 400);
        return;
      }
      try {
        const result = await pool.query(`
WITH selected AS (
  SELECT services.id
  FROM public.storage_control_storage_services AS services
  JOIN public.storage_control_clients AS clients ON clients.id = services.storage_control_client_id
  WHERE services.service_id = $1
), connections AS (
  SELECT connections.id
  FROM public.storage_control_provider_connections AS connections
  JOIN selected ON selected.id = connections.storage_service_id
), versions AS (
  SELECT DISTINCT versions.id, versions.state
  FROM public.storage_control_configuration_versions AS versions
  JOIN public.storage_control_configuration_vaults AS vaults ON vaults.configuration_version_id = versions.id
  JOIN connections ON connections.id = vaults.provider_connection_id
), vaults AS (
  SELECT vaults.id
  FROM public.storage_control_configuration_vaults AS vaults
  JOIN connections ON connections.id = vaults.provider_connection_id
), routes AS (
  SELECT DISTINCT targets.configuration_route_id
  FROM public.storage_control_configuration_route_targets AS targets
  JOIN vaults ON vaults.id = targets.vault_id
)
SELECT
  (SELECT count(*) FROM versions WHERE state = 'draft') AS draft_configuration_count,
  (SELECT count(*) FROM versions WHERE state = 'active') AS active_configuration_count,
  (SELECT count(*) FROM vaults) AS vault_count,
  (SELECT count(*) FROM routes) AS route_count,
  (SELECT count(*) FROM public.storage_object_copies AS copies JOIN connections ON connections.id = copies.provider_connection_id) AS object_copy_count,
  (SELECT count(DISTINCT outputs.image_derivative_output_id)
   FROM public.storage_image_derivative_outputs AS outputs
   JOIN public.storage_object_copies AS copies ON copies.storage_object_id = outputs.output_storage_object_id
   JOIN connections ON connections.id = copies.provider_connection_id) AS derivative_output_count
`, [serviceId]);
        sendJson(response, { result: { dependencyQuerySucceeded: true, counts: result.rows[0] ?? null } });
      } catch (error) {
        sendJson(response, { result: { dependencyQuerySucceeded: false, ...safeDatabaseError(error) } });
      }
      return;
    }

    const services = await pool.query(`
      SELECT services.service_id, services.status, services.last_test_status, services.last_diagnostic_code,
             services.active_provider_secret_id IS NOT NULL AS has_secret_reference,
             secrets.state AS secret_state, secrets.revoked_at IS NOT NULL AS secret_revoked,
             (SELECT array_agg(events.event_type ORDER BY events.created_at)
                FROM public.storage_control_storage_service_events AS events
               WHERE events.storage_service_id = services.id) AS event_types
      FROM public.storage_control_storage_services AS services
      LEFT JOIN public.storage_control_provider_secrets AS secrets ON secrets.id = services.active_provider_secret_id
      WHERE services.service_id LIKE 'h08-vercel-negative-%'
      ORDER BY services.created_at
    `);
    sendJson(response, { result: services.rows.map((row) => ({
      serviceId: row.service_id,
      status: row.status,
      lastTestStatus: row.last_test_status,
      lastDiagnosticCode: row.last_diagnostic_code,
      hasSecretReference: Boolean(row.has_secret_reference),
      secretState: row.secret_state ?? null,
      secretRevoked: Boolean(row.secret_revoked),
      eventTypes: Array.isArray(row.event_types) ? row.event_types : [],
    })) });
  } catch (error) {
    const candidate = error as { code?: unknown };
    sendJson(response, { error: { code: 'h08-state-inspect-failed', sqlstate: typeof candidate?.code === 'string' ? candidate.code : null } }, 500);
  } finally {
    await pool.end().catch(() => undefined);
  }
}
