import { createHash } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const EXPECTED_TOKEN_SHA256 = '612ed020df5e27a99a21f7b00cacacfe6fd8e03c645995d7f43edb3fa763e689';

type RequestLike = Readonly<{ method?: string; url?: string }>;
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
  return createHash('sha256').update(token, 'utf8').digest('hex') === EXPECTED_TOKEN_SHA256;
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

  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    application_name: 'h08-safe-state-inspect',
  });

  try {
    if (url.searchParams.get('mode') === 'probe-archive') {
      const serviceId = url.searchParams.get('serviceId')?.trim() ?? '';
      if (!/^h08-vercel-negative-[a-z0-9]{8}$/.test(serviceId)) {
        sendJson(response, { error: { code: 'service-id-invalid' } }, 400);
        return;
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(`
          UPDATE public.storage_control_storage_services AS services
          SET status = 'archived',
              disabled_at = NULL,
              archived_at = clock_timestamp(),
              updated_at = clock_timestamp()
          WHERE services.service_id = $1
          RETURNING services.service_id
        `, [serviceId]);
        await client.query('ROLLBACK');
        sendJson(response, {
          result: {
            serviceId,
            archiveUpdateWouldSucceed: result.rowCount === 1,
          },
        });
        return;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        const candidate = error as {
          code?: unknown;
          constraint?: unknown;
          message?: unknown;
        };
        sendJson(response, {
          result: {
            serviceId,
            archiveUpdateWouldSucceed: false,
            sqlstate: typeof candidate.code === 'string' ? candidate.code : null,
            constraint: typeof candidate.constraint === 'string' ? candidate.constraint : null,
            message: typeof candidate.message === 'string' ? candidate.message : null,
          },
        });
        return;
      } finally {
        client.release();
      }
    }

    const services = await pool.query(`
      SELECT
        services.service_id,
        services.status,
        services.last_test_status,
        services.last_diagnostic_code,
        services.active_provider_secret_id IS NOT NULL AS has_secret_reference,
        secrets.state AS secret_state,
        secrets.revoked_at IS NOT NULL AS secret_revoked,
        (
          SELECT array_agg(events.event_type ORDER BY events.created_at)
          FROM public.storage_control_storage_service_events AS events
          WHERE events.storage_service_id = services.id
        ) AS event_types
      FROM public.storage_control_storage_services AS services
      LEFT JOIN public.storage_control_provider_secrets AS secrets
        ON secrets.id = services.active_provider_secret_id
      WHERE services.service_id LIKE 'h08-vercel-negative-%'
      ORDER BY services.created_at
    `);

    sendJson(response, {
      result: services.rows.map((row) => ({
        serviceId: row.service_id,
        status: row.status,
        lastTestStatus: row.last_test_status,
        lastDiagnosticCode: row.last_diagnostic_code,
        hasSecretReference: Boolean(row.has_secret_reference),
        secretState: row.secret_state ?? null,
        secretRevoked: Boolean(row.secret_revoked),
        eventTypes: Array.isArray(row.event_types) ? row.event_types : [],
      })),
    });
  } catch (error) {
    const candidate = error as { code?: unknown };
    sendJson(response, {
      error: {
        code: 'h08-state-inspect-failed',
        sqlstate: typeof candidate?.code === 'string' ? candidate.code : null,
      },
    }, 500);
  } finally {
    await pool.end().catch(() => undefined);
  }
}
