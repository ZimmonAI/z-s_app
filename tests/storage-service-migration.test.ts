import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('0012 migration creates ciphertext-only service persistence and dependency linkage', async () => {
  const migration = await readFile(
    new URL('../db/migrations/0012_z_s_storage_services.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /storage_control_storage_services/);
  assert.match(migration, /storage_control_provider_secrets/);
  assert.match(migration, /algorithm text NOT NULL CHECK \(algorithm = 'aes-256-gcm'\)/);
  assert.match(migration, /nonce bytea/);
  assert.match(migration, /ciphertext bytea/);
  assert.match(migration, /authentication_tag bytea/);
  assert.match(migration, /storage_service_id uuid NULL/);
  assert.match(migration, /z_s_storage_service_connection_guard/);
  assert.doesNotMatch(migration, /secret_access_key|access_key_id|account_id text/i);
});
