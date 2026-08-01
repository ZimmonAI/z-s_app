import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const postgresUrl = process.env.Z_S_POSTGRES_URL?.trim();
const bootstrapCredential = process.env.Z_S_CLIENT_BOOTSTRAP_CREDENTIAL?.trim();

if (!postgresUrl) throw new Error('Z_S_POSTGRES_URL is required');
if (!bootstrapCredential) throw new Error('Z_S_CLIENT_BOOTSTRAP_CREDENTIAL is required');

const clientId = 'video-maker_app';
const displayLabel = 'Video Maker';
const tokenId = 'video-maker-browser-login-01';
const tokenPurpose = 'browser-login';
const status = 'active';
const expiresAt = null;
const tokenDigest = createHash('sha256').update(bootstrapCredential, 'utf8').digest('hex');
const pool = new Pool({
  connectionString: postgresUrl,
  application_name: 'z-s-client-login-bootstrap',
});
const client = await pool.connect();

try {
  await client.query('BEGIN');
  const clientResult = await client.query(`
INSERT INTO public.storage_control_clients (
  id, client_id, display_label, status
) VALUES ($1, $2, $3, $4)
ON CONFLICT (client_id) DO UPDATE SET
  display_label = EXCLUDED.display_label,
  status = EXCLUDED.status,
  updated_at = now()
RETURNING id
`, [randomUUID(), clientId, displayLabel, status]);
  const storageControlClientId = clientResult.rows[0]?.id;
  if (typeof storageControlClientId !== 'string') throw new Error('client bootstrap failed');

  await client.query(`
INSERT INTO public.storage_control_client_tokens (
  id,
  storage_control_client_id,
  token_id,
  token_purpose,
  token_digest,
  status,
  expires_at,
  revoked_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
ON CONFLICT (storage_control_client_id, token_id) DO UPDATE SET
  token_purpose = EXCLUDED.token_purpose,
  token_digest = EXCLUDED.token_digest,
  status = EXCLUDED.status,
  expires_at = EXCLUDED.expires_at,
  revoked_at = NULL,
  updated_at = now()
`, [
    randomUUID(),
    storageControlClientId,
    tokenId,
    tokenPurpose,
    tokenDigest,
    status,
    expiresAt,
  ]);
  await client.query('COMMIT');
  console.log(JSON.stringify({
    client_id: clientId,
    token_id: tokenId,
    token_purpose: tokenPurpose,
    status,
    expires_at: expiresAt,
  }));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
