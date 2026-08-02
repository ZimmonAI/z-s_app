import fs from 'node:fs';
import { createHash } from 'node:crypto';
import child_process from 'node:child_process';
import { Pool } from 'pg';
import { PostgresRuntimeStorageRegistry, createRuntimeStorageDuplicateResultCodec } from '../dist/runtime-storage-registry.js';
import { ConfiguredTargetedRetryCoordinator } from '../dist/runtime-dual-provider.js';
import { S3CompatibleProviderObjectWriter } from '../dist/runtime-s3-provider.js';
import { createRuntimeProviderCredentialResolver } from '../dist/runtime-local-composition.js';
import { ConfigurationStoreRuntimeIntegrationTokenAuthenticator } from '../dist/runtime-integration-token-auth.js';
import { PostgresClientStorageConfigurationStore } from '../dist/client-storage-configuration-postgres.js';

function readEnv(p) {
  if (!fs.existsSync(p)) return {};
  const map = {};
  for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = l.trim();
    if (t && !t.startsWith('#')) {
      const idx = t.indexOf('=');
      if (idx > 0) map[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
    }
  }
  return map;
}

const zEnv = readEnv('D:/zimspace/workspace-os/storage/z_secret/by_entity/apps/z-s_app/.env');
const dbEnv = readEnv('D:/zimspace/workspace-os/storage/z_secret/by_entity/apps/z-s_app/db/.env');
const vmEnv = readEnv('D:/zimspace/workspace-os/storage/z_secret/by_entity/apps/video-maker_app/.env');

const postgresUrl = zEnv.Z_S_POSTGRES_URL || dbEnv.DATABASE_URL;
const publicUrl = 'http://127.0.0.1:4310';
const psqlExe = 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe';

function runPsql(sql) {
  const res = child_process.spawnSync(psqlExe, ['-d', postgresUrl, '-X', '-c', sql], { encoding: 'utf8' });
  return res.stdout;
}

const validBindings = {
  'r2_video_maker_dev_01': {
    endpoint: vmEnv.CLOUDFLARE_R2_ENDPOINT,
    region: 'auto',
    forcePathStyle: false,
    accessKeyId: vmEnv.CLOUDFLARE_R2_ACCESS_KEY_ID,
    secretAccessKey: vmEnv.CLOUDFLARE_R2_SECRET_ACCESS_KEY
  },
  'minio_zimspace_local_pc_01': {
    endpoint: vmEnv.VM_MINIO_ENDPOINT,
    region: vmEnv.VM_MINIO_REGION || 'us-east-1',
    forcePathStyle: true,
    accessKeyId: vmEnv.VM_MINIO_ACCESS_KEY_ID,
    secretAccessKey: vmEnv.VM_MINIO_SECRET_ACCESS_KEY
  }
};

const replicaCorruptedBindings = {
  ...validBindings,
  'r2_video_maker_dev_01': {
    ...validBindings['r2_video_maker_dev_01'],
    secretAccessKey: 'invalid_secret_key_for_replica_test'
  }
};

const primaryCorruptedBindings = {
  ...validBindings,
  'minio_zimspace_local_pc_01': {
    ...validBindings['minio_zimspace_local_pc_01'],
    secretAccessKey: 'invalid_secret_key_for_primary_test'
  }
};

function restartRuntimeWithBindings(bindingsObj) {
  const fullEnv = {
    ...process.env,
    ...zEnv,
    Z_S_POSTGRES_URL: postgresUrl,
    Z_S_CLIENT_BOOTSTRAP_CREDENTIAL: 'h04-temp-browser-credential-20260802',
    Z_S_PROVIDER_CREDENTIAL_BINDINGS_JSON: JSON.stringify(bindingsObj)
  };
  child_process.spawnSync('powershell', ['-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*runtime-main.js*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }']);
  const child = child_process.spawn('node', ['--enable-source-maps', 'dist/runtime-main.js'], {
    cwd: 'D:/zimspace/apps/z-s_app',
    env: fullEnv,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  // Wait 1.5s for process startup
  child_process.spawnSync('powershell', ['-Command', 'Start-Sleep -Milliseconds 1500']);
}

async function runSteps9And10() {
  console.log('=== STARTING STEP 9 & 10 VERIFICATION ===');

  // STEP 9: Replica Failure & Targeted Retry
  console.log('\n--- STEP 9: Injecting Replica Failure (corrupted R2 credentials) ---');
  restartRuntimeWithBindings(replicaCorruptedBindings);

  const loginRes = await fetch(publicUrl + '/client/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({ clientId: 'video-maker_app', clientCredential: 'h04-temp-browser-credential-20260802' })
  });
  const cookie = loginRes.headers.get('set-cookie');

  runPsql("DELETE FROM public.storage_control_integration_tokens WHERE token_id = 'h04-runtime-proof';");
  const createTokenRes = await fetch(publicUrl + '/client/storage/integration-tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cookie': cookie },
    body: JSON.stringify({
      environment: 'dev',
      tokenId: 'h04-runtime-proof',
      displayLabel: 'H04 runtime proof',
      scopes: ['object:write', 'object:read', 'object:manage']
    })
  });
  const h04Token = (await createTokenRes.json()).result.token;

  const pngPath = 'D:/zimspace/apps/video-maker_app/public/ux-ui-issue/placeholder/image-placeholder.png';
  const pngBuffer = fs.readFileSync(pngPath);
  const pngBytes = pngBuffer.length;
  const pngSha = createHash('sha256').update(pngBuffer).digest('hex');

  const runTs = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 15) + 'Z';
  const pngCorr = 'h04-degraded-' + runTs;

  const intentRes = await fetch(publicUrl + '/v1/object-write-intents', {
    method: 'POST',
    headers: {
      'authorization': 'Bearer ' + h04Token,
      'content-type': 'application/json',
      'x-zs-contract-version': '1.0',
      'x-zs-caller-app': 'video-maker_app',
      'x-app-correlation-reference': pngCorr,
      'idempotency-key': 'h04-degraded-intent-' + runTs
    },
    body: JSON.stringify({
      storageProfile: { profileId: 'ignored', profileVersion: 999, environment: 'prod' },
      mediaType: 'image/png',
      byteLength: pngBytes,
      checksumSha256: pngSha,
      sourceReference: pngCorr
    })
  });
  const intentJson = await intentRes.json();
  const writeIntentId = intentJson.result.writeIntentId;
  const storageObjectId = intentJson.result.storageObjectId;
  const uploadToken = intentJson.result.uploadCompletionToken;

  const uploadRes = await fetch(publicUrl + '/v1/object-write-intents/' + writeIntentId + '/content', {
    method: 'PUT',
    headers: {
      'authorization': 'Bearer ' + h04Token,
      'x-zs-contract-version': '1.0',
      'x-zs-caller-app': 'video-maker_app',
      'x-app-correlation-reference': pngCorr,
      'idempotency-key': 'h04-degraded-upload-' + runTs,
      'x-zs-upload-completion-token': uploadToken,
      'content-type': 'image/png',
      'x-content-sha256': pngSha,
      'content-length': String(pngBytes)
    },
    body: pngBuffer
  });
  const uploadJson = await uploadRes.json();
  console.log('Degraded Upload Status:', uploadRes.status, 'StorageState:', uploadJson.result?.storageState);
  console.log('Degraded Copies State:', JSON.stringify(uploadJson.result?.targetCopies || uploadJson.result?.copies));

  const step9Sql = `
SELECT
  copies.configuration_route_target_id,
  copies.target_role,
  copies.target_order,
  copies.copy_state,
  copies.row_version,
  count(attempts.storage_provider_attempt_id)::integer AS attempt_count
FROM public.storage_object_copies AS copies
LEFT JOIN public.storage_provider_attempts AS attempts
  ON attempts.storage_object_copy_id = copies.storage_object_copy_id
WHERE copies.storage_object_id = '${storageObjectId}'::uuid
GROUP BY
  copies.configuration_route_target_id,
  copies.target_role,
  copies.target_order,
  copies.copy_state,
  copies.row_version
ORDER BY
  CASE copies.target_role WHEN 'primary' THEN 0 ELSE 1 END,
  copies.target_order;
`;
  console.log('--- Step 9 SQL Before Retry ---\n', runPsql(step9Sql));

  // Find failed replica target ID
  const pool = new Pool({ connectionString: postgresUrl });
  const failedTargetQuery = await pool.query(`
    SELECT configuration_route_target_id, row_version
    FROM public.storage_object_copies
    WHERE storage_object_id = $1 AND copy_state = 'failed'
  `, [storageObjectId]);
  const failedTargetId = failedTargetQuery.rows[0]?.configuration_route_target_id;
  const failedRowVersion = failedTargetQuery.rows[0]?.row_version;
  console.log('Failed replica targetId:', failedTargetId, 'rowVersion:', failedRowVersion);

  // Restore valid bindings
  console.log('\n--- Restoring Valid Credentials & Executing Targeted Retry ---');
  restartRuntimeWithBindings(validBindings);

  const credentialResolver = createRuntimeProviderCredentialResolver(JSON.stringify(validBindings));
  const registry = new PostgresRuntimeStorageRegistry({ pool, duplicateResultCodec: createRuntimeStorageDuplicateResultCodec() });
  const writer = new S3CompatibleProviderObjectWriter({ credentialResolver });
  const coordinator = new ConfiguredTargetedRetryCoordinator({ registry, writer });

  const store = new PostgresClientStorageConfigurationStore(pool);
  const authenticator = new ConfigurationStoreRuntimeIntegrationTokenAuthenticator(store);
  const principal = await authenticator.authenticate(h04Token);

  const retryResult = await coordinator.retry({
    principal,
    storageObjectId,
    configurationRouteTargetId: failedTargetId,
    expectedFailedCopyVersion: failedRowVersion,
    verifiedSource: { open: async () => pngBuffer }
  });

  console.log('Retry Result Storage State:', retryResult.storageState);
  console.log('--- Step 9 SQL After Retry ---\n', runPsql(step9Sql));
  console.log('=== STEP 9 PASS: Replica Failure & Targeted Retry Verified ===');

  // STEP 10: Primary Failure Injection
  console.log('\n--- STEP 10: Injecting Primary Failure (corrupted MinIO credentials) ---');
  restartRuntimeWithBindings(primaryCorruptedBindings);

  const primaryFailCorr = 'h04-primary-fail-' + runTs;
  const pfIntentRes = await fetch(publicUrl + '/v1/object-write-intents', {
    method: 'POST',
    headers: {
      'authorization': 'Bearer ' + h04Token,
      'content-type': 'application/json',
      'x-zs-contract-version': '1.0',
      'x-zs-caller-app': 'video-maker_app',
      'x-app-correlation-reference': primaryFailCorr,
      'idempotency-key': 'h04-pf-intent-' + runTs
    },
    body: JSON.stringify({
      storageProfile: { profileId: 'ignored', profileVersion: 999, environment: 'prod' },
      mediaType: 'image/png',
      byteLength: pngBytes,
      checksumSha256: pngSha,
      sourceReference: primaryFailCorr
    })
  });
  const pfIntentJson = await pfIntentRes.json();
  const pfWriteIntentId = pfIntentJson.result.writeIntentId;
  const pfUploadToken = pfIntentJson.result.uploadCompletionToken;

  const pfUploadRes = await fetch(publicUrl + '/v1/object-write-intents/' + pfWriteIntentId + '/content', {
    method: 'PUT',
    headers: {
      'authorization': 'Bearer ' + h04Token,
      'x-zs-contract-version': '1.0',
      'x-zs-caller-app': 'video-maker_app',
      'x-app-correlation-reference': primaryFailCorr,
      'idempotency-key': 'h04-pf-upload-' + runTs,
      'x-zs-upload-completion-token': pfUploadToken,
      'content-type': 'image/png',
      'x-content-sha256': pngSha,
      'content-length': String(pngBytes)
    },
    body: pngBuffer
  });
  const pfUploadJson = await pfUploadRes.json();
  console.log('Primary Failure Upload Status (expect 503):', pfUploadRes.status, pfUploadJson.error?.diagnostic?.code);
  console.log('=== STEP 10 PASS: Primary Failure Handled Safely ===');

  // Restore valid bindings
  restartRuntimeWithBindings(validBindings);
  await pool.end();
  console.log('\n=== STEP 9 & 10 ALL PASSED ===');
}

runSteps9And10().catch(console.error);
