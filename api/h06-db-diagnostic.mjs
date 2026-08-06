import pg from 'pg';

const { Client } = pg;

function safeError(error) {
  if (!error || typeof error !== 'object') {
    return { name: null, code: null, message: String(error) };
  }

  const message = typeof error.message === 'string'
    ? error.message
    : String(error);

  return {
    name: typeof error.name === 'string' ? error.name : null,
    code: typeof error.code === 'string' ? error.code : null,
    errno: typeof error.errno === 'number' ? error.errno : null,
    syscall: typeof error.syscall === 'string' ? error.syscall : null,
    message: message
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted-postgres-url]')
      .slice(0, 300),
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
    response.end(JSON.stringify({
      connected: false,
      variablePresent: false,
      error: { code: 'Z_S_POSTGRES_URL-missing' },
    }));
    return;
  }

  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 10_000,
    application_name: 'h06-vercel-db-diagnostic',
  });

  try {
    await client.connect();
    const result = await client.query(`
      SELECT
        current_database() AS database_name,
        current_user AS database_user,
        current_schema() AS schema_name
    `);

    response.statusCode = 200;
    response.end(JSON.stringify({
      connected: true,
      variablePresent: true,
      databaseName: result.rows[0]?.database_name ?? null,
      databaseUser: result.rows[0]?.database_user ?? null,
      schemaName: result.rows[0]?.schema_name ?? null,
    }));
  } catch (error) {
    response.statusCode = 503;
    response.end(JSON.stringify({
      connected: false,
      variablePresent: true,
      error: safeError(error),
    }));
  } finally {
    await client.end().catch(() => undefined);
  }
}
