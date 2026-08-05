import { readFile } from 'node:fs/promises';

const migration = await readFile(
  new URL('../db/migrations/0012_z_s_storage_services.sql', import.meta.url),
  'utf8',
);
const required = [
  'storage_control_storage_services',
  'storage_control_provider_secrets',
  'storage_control_storage_service_events',
  "algorithm = 'aes-256-gcm'",
  'nonce bytea',
  'ciphertext bytea',
  'authentication_tag bytea',
  'storage_service_id uuid NULL',
  'z_s_storage_service_connection_guard',
];
const missing = required.filter((value) => !migration.includes(value));
if (missing.length > 0) {
  console.error(`0012 migration missing: ${missing.join(', ')}`);
  process.exitCode = 1;
} else if (/secret_access_key|access_key_id|account_id text/i.test(migration)) {
  console.error('0012 migration contains a plaintext provider credential column');
  process.exitCode = 1;
} else {
  console.log('0012 storage service migration contract: passed');
}
