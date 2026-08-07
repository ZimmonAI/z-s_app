import pg from 'pg';

const { Client } = pg;

function safeError(error) {
  if (!error || typeof error !== 'object') {
    return { code: null, message: String(error).slice(0, 240) };
  }

  return {
    code: typeof error.code === 'string' ? error.code : null,
    message: (typeof error.message === 'string' ? error.message : String(error))
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted-postgres-url]')
      .slice(0, 240),
  };
}

export default async function handler(request, response) {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json; charset=utf-8');

  if (request.method !== 'GET') {
    response.statusCode = 405;
    response.end(JSON.stringify({ error: 'method-not-allowed' }));
    return;
  }

  const connectionString = process.env.Z_S_POSTGRES_URL;
  if (!connectionString) {
    response.statusCode = 503;
    response.end(JSON.stringify({ connected: false, error: { code: 'url-missing' } }));
    return;
  }

  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 10_000,
    application_name: 'h06-vercel-schema-diagnostic',
  });

  try {
    await client.connect();

    const identity = await client.query(`
      SELECT
        current_database() AS database_name,
        current_user AS database_user,
        current_schema() AS schema_name
    `);

    const relations = await client.query(`
      SELECT
        to_regclass('public.storage_objects')::text AS storage_objects,
        to_regclass('public.storage_object_copies')::text AS storage_object_copies,
        to_regclass('public.storage_image_derivative_jobs')::text AS derivative_jobs,
        to_regclass('public.storage_image_derivative_outputs')::text AS derivative_outputs
    `);

    const columns = await client.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          'storage_image_derivative_jobs',
          'storage_image_derivative_outputs'
        )
      ORDER BY table_name, ordinal_position
    `);

    response.statusCode = 200;
    response.end(JSON.stringify({
      connected: true,
      identity: identity.rows[0] ?? null,
      relations: relations.rows[0] ?? null,
      derivativeColumns: columns.rows,
    }));
  } catch (error) {
    response.statusCode = 503;
    response.end(JSON.stringify({ connected: false, error: safeError(error) }));
  } finally {
    await client.end().catch(() => undefined);
  }
}
