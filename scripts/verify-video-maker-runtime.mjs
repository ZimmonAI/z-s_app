import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';

const SCENARIOS = Object.freeze([
  'png-write-read',
  'mp4-write-read-range',
  'duplicate-replay',
  'cancel-before-content',
  'hot-read-fallback',
  'revoke-read-grant',
  'cleanup-only',
]);
const SAFE_RUN_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTRACT_VERSION = '1.0';
const CALLER_APP = 'video-maker_app';
const PROFILE = Object.freeze({
  profileId: 'video-maker-dev-default',
  profileVersion: 1,
  environment: 'dev',
});

function u32(value) {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function ascii(value) {
  return Uint8Array.from([...value].map((entry) => entry.charCodeAt(0)));
}

function join(...parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function png() {
  const data = join(u32(2), u32(3), Uint8Array.of(8, 6, 0, 0, 0));
  return join(
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    u32(data.byteLength),
    ascii('IHDR'),
    data,
    new Uint8Array(4),
    u32(0),
    ascii('IEND'),
    new Uint8Array(4),
  );
}

function box(type, payload) {
  return join(u32(8 + payload.byteLength), ascii(type), payload);
}

function mp4() {
  const ftyp = box('ftyp', join(ascii('isom'), u32(0), ascii('mp42')));
  const mvhd = box('mvhd', join(
    Uint8Array.of(0, 0, 0, 0),
    u32(0),
    u32(0),
    u32(1_000),
    u32(2_000),
  ));
  return join(ftyp, box('moov', mvhd));
}

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function argumentsFrom(argv) {
  const values = new Map();
  let confirmed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--confirm-live-actions') {
      confirmed = true;
      continue;
    }
    if (!flag?.startsWith('--') || values.has(flag)) throw new Error('verifier-argument-invalid');
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('verifier-argument-missing');
    values.set(flag, value);
    index += 1;
  }
  return Object.freeze({
    scenario: values.get('--scenario') ?? process.env.Z_S_VERIFY_SCENARIO ?? 'png-write-read',
    runId: values.get('--run-id') ?? process.env.Z_S_VERIFY_RUN_ID,
    baseUrl: values.get('--base-url') ?? process.env.Z_S_RUNTIME_BASE_URL,
    confirmed,
  });
}

function validateConfiguration(configuration) {
  if (!SCENARIOS.includes(configuration.scenario)) throw new Error('verifier-scenario-refused');
  if (typeof configuration.runId !== 'string' || !SAFE_RUN_ID.test(configuration.runId)) {
    throw new Error('verifier-run-id-refused');
  }
  if (!configuration.confirmed) throw new Error('verifier-live-actions-not-confirmed');
  if (typeof configuration.baseUrl !== 'string') throw new Error('verifier-base-url-required');
  let parsed;
  try {
    parsed = new URL(configuration.baseUrl);
  } catch {
    throw new Error('verifier-base-url-invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('verifier-base-url-invalid');
  }
  const bearerToken = process.env.Z_S_VIDEO_MAKER_BEARER_TOKEN?.trim();
  if (!bearerToken) throw new Error('verifier-bearer-token-required');
  return Object.freeze({
    ...configuration,
    baseUrl: parsed.toString().replace(/\/$/, ''),
    bearerToken,
  });
}

function stateFile(runId) {
  return `.z-s-video-maker-runtime-${runId}.json`;
}

async function loadState(runId) {
  try {
    const parsed = JSON.parse(await readFile(stateFile(runId), 'utf8'));
    if (
      parsed?.schemaVersion !== 1 ||
      parsed.runId !== runId ||
      !Array.isArray(parsed.pendingIntentIds) ||
      !Array.isArray(parsed.readGrantIds) ||
      !Array.isArray(parsed.completedObjectIds) ||
      !parsed.pendingIntentIds.every((value) => typeof value === 'string' && UUID.test(value)) ||
      !parsed.readGrantIds.every((value) => typeof value === 'string' && UUID.test(value)) ||
      !parsed.completedObjectIds.every((value) => typeof value === 'string' && UUID.test(value))
    ) {
      throw new Error('verifier-state-invalid');
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        schemaVersion: 1,
        runId,
        pendingIntentIds: [],
        readGrantIds: [],
        completedObjectIds: [],
      };
    }
    throw error;
  }
}

async function saveState(state) {
  await writeFile(stateFile(state.runId), `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function unique(values) {
  return [...new Set(values)];
}

function correlation(configuration, suffix) {
  return `p0-s2d-vm-${configuration.runId}-${suffix}`.slice(0, 128);
}

function idempotency(configuration, suffix) {
  return `p0-s2d-vm-${configuration.runId}-${suffix}`.slice(0, 128);
}

function commonHeaders(configuration, suffix) {
  return {
    authorization: `Bearer ${configuration.bearerToken}`,
    'x-zs-caller-app': CALLER_APP,
    'x-zs-contract-version': CONTRACT_VERSION,
    'x-app-correlation-reference': correlation(configuration, suffix),
  };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    throw new Error('verifier-response-json-invalid');
  }
}

function diagnosticCode(value) {
  const code = value?.error?.diagnostic?.code;
  return typeof code === 'string' ? code : 'unexpected-response';
}

async function expectJson(response, acceptedStatuses) {
  const body = await safeJson(response);
  if (!acceptedStatuses.includes(response.status)) {
    const error = new Error(diagnosticCode(body));
    error.status = response.status;
    throw error;
  }
  return body;
}

async function requestJson(configuration, path, options, acceptedStatuses = [200]) {
  const response = await fetch(`${configuration.baseUrl}${path}`, options);
  return expectJson(response, acceptedStatuses);
}

async function createIntent(configuration, state, media, suffix, duplicateKey) {
  const digest = checksum(media.bytes);
  const body = {
    storageProfile: PROFILE,
    mediaType: media.mediaType,
    byteLength: media.bytes.byteLength,
    checksumSha256: digest,
    sourceReference: `runtime-verification:${configuration.runId}:${suffix}`,
    requestedProtectionStage: 'write-intent-created',
  };
  const response = await requestJson(
    configuration,
    '/v1/object-write-intents',
    {
      method: 'POST',
      headers: {
        ...commonHeaders(configuration, suffix),
        'content-type': 'application/json',
        'idempotency-key': duplicateKey ?? idempotency(configuration, `${suffix}-intent`),
      },
      body: JSON.stringify(body),
    },
  );
  const result = response.result;
  assert.match(result.writeIntentId, UUID);
  assert.match(result.storageObjectId, UUID);
  assert.equal(result.state, 'accepted');
  assert.equal(typeof result.uploadCompletionToken, 'string');
  state.pendingIntentIds = unique([...state.pendingIntentIds, result.writeIntentId]);
  await saveState(state);
  return Object.freeze({ ...result, bytes: media.bytes, mediaType: media.mediaType, checksum: digest, body });
}

async function uploadIntent(configuration, state, intent, suffix) {
  const response = await requestJson(
    configuration,
    `/v1/object-write-intents/${intent.writeIntentId}/content`,
    {
      method: 'PUT',
      headers: {
        ...commonHeaders(configuration, suffix),
        'content-type': intent.mediaType,
        'content-length': String(intent.bytes.byteLength),
        'x-content-sha256': intent.checksum,
        'x-zs-upload-completion-token': intent.uploadCompletionToken,
        'idempotency-key': idempotency(configuration, `${suffix}-upload`),
      },
      body: intent.bytes,
      duplex: 'half',
    },
  );
  assert.equal(response.result.storageObjectId, intent.storageObjectId);
  assert.equal(response.result.writeIntentId, intent.writeIntentId);
  assert.equal(response.result.state, 'recorded');
  assert.equal(response.result.checksumSha256, intent.checksum);
  assert.equal(response.result.byteLength, intent.bytes.byteLength);
  state.pendingIntentIds = state.pendingIntentIds.filter((id) => id !== intent.writeIntentId);
  state.completedObjectIds = unique([...state.completedObjectIds, intent.storageObjectId]);
  await saveState(state);
  return response.result;
}

async function cancelIntent(configuration, state, intentId, suffix, acceptedStatuses = [200]) {
  const response = await requestJson(
    configuration,
    `/v1/object-write-intents/${intentId}`,
    {
      method: 'DELETE',
      headers: {
        ...commonHeaders(configuration, suffix),
        'idempotency-key': idempotency(configuration, `${suffix}-cancel`),
      },
    },
    acceptedStatuses,
  );
  if (response.result?.state === 'cancelled') {
    state.pendingIntentIds = state.pendingIntentIds.filter((id) => id !== intentId);
    await saveState(state);
  }
  return response;
}

async function issueGrant(configuration, state, storageObjectId, suffix) {
  const response = await requestJson(
    configuration,
    '/v1/object-read-grants',
    {
      method: 'POST',
      headers: {
        ...commonHeaders(configuration, suffix),
        'content-type': 'application/json',
        'idempotency-key': idempotency(configuration, `${suffix}-grant`),
      },
      body: JSON.stringify({
        storageObjectId,
        purpose: 'video-maker-runtime-verification',
        allowedMethods: ['HEAD', 'GET'],
        allowRange: true,
        disposition: 'inline',
        requestedTtlSeconds: 300,
        businessAuthorizationReference: `runtime-verification:${configuration.runId}:${suffix}`,
      }),
    },
  );
  const result = response.result;
  assert.match(result.objectReadGrantId, UUID);
  assert.equal(result.storageObjectId, storageObjectId);
  assert.equal(result.state, 'active');
  assert.equal(typeof result.readGrantToken, 'string');
  state.readGrantIds = unique([...state.readGrantIds, result.objectReadGrantId]);
  await saveState(state);
  return result;
}

async function revokeGrant(configuration, state, grantId, suffix, acceptedStatuses = [200]) {
  const response = await requestJson(
    configuration,
    `/v1/object-read-grants/${grantId}`,
    {
      method: 'DELETE',
      headers: {
        ...commonHeaders(configuration, suffix),
        'idempotency-key': idempotency(configuration, `${suffix}-revoke`),
      },
    },
    acceptedStatuses,
  );
  if (response.result?.state === 'revoked' || response.result?.state === 'expired') {
    state.readGrantIds = state.readGrantIds.filter((id) => id !== grantId);
    await saveState(state);
  }
  return response;
}

async function readContent(configuration, objectId, grant, suffix, options = {}) {
  return fetch(`${configuration.baseUrl}/v1/storage-objects/${objectId}/content`, {
    method: options.method ?? 'GET',
    headers: {
      ...commonHeaders(configuration, `${suffix}-read`),
      'x-zs-read-grant-token': grant.readGrantToken,
      ...(options.range === undefined ? {} : { range: options.range }),
    },
  });
}

async function createUploadedObject(configuration, state, media, suffix) {
  const intent = await createIntent(configuration, state, media, suffix);
  const completion = await uploadIntent(configuration, state, intent, suffix);
  return Object.freeze({ intent, completion });
}

async function scenarioPngWriteRead(configuration, state) {
  const media = Object.freeze({ mediaType: 'image/png', bytes: png() });
  const { intent } = await createUploadedObject(configuration, state, media, 'png');
  const grant = await issueGrant(configuration, state, intent.storageObjectId, 'png');
  const head = await readContent(configuration, intent.storageObjectId, grant, 'png-head', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(media.bytes.byteLength));
  assert.equal(head.headers.get('etag'), `"${intent.checksum}"`);
  const get = await readContent(configuration, intent.storageObjectId, grant, 'png-get');
  assert.equal(get.status, 200);
  const observed = new Uint8Array(await get.arrayBuffer());
  assert.equal(observed.byteLength, media.bytes.byteLength);
  assert.equal(checksum(observed), intent.checksum);
  await revokeGrant(configuration, state, grant.objectReadGrantId, 'png');
  return {
    mediaType: media.mediaType,
    byteLength: observed.byteLength,
    checksumVerified: true,
    deliveryState: get.headers.get('x-zs-delivery-state'),
    retainedCompletedObjectCount: state.completedObjectIds.length,
  };
}

async function scenarioMp4WriteReadRange(configuration, state) {
  const media = Object.freeze({ mediaType: 'video/mp4', bytes: mp4() });
  const { intent } = await createUploadedObject(configuration, state, media, 'mp4');
  const grant = await issueGrant(configuration, state, intent.storageObjectId, 'mp4');
  const end = Math.min(15, media.bytes.byteLength - 1);
  const response = await readContent(configuration, intent.storageObjectId, grant, 'mp4-range', {
    range: `bytes=0-${end}`,
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 0-${end}/${media.bytes.byteLength}`);
  const observed = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual(observed, media.bytes.slice(0, end + 1));
  await revokeGrant(configuration, state, grant.objectReadGrantId, 'mp4');
  return {
    mediaType: media.mediaType,
    rangeByteLength: observed.byteLength,
    rangeVerified: true,
    deliveryState: response.headers.get('x-zs-delivery-state'),
    retainedCompletedObjectCount: state.completedObjectIds.length,
  };
}

async function scenarioDuplicateReplay(configuration, state) {
  const media = Object.freeze({ mediaType: 'image/png', bytes: png() });
  const key = idempotency(configuration, 'duplicate-shared');
  const first = await createIntent(configuration, state, media, 'duplicate', key);
  const second = await createIntent(configuration, state, media, 'duplicate', key);
  assert.equal(first.writeIntentId, second.writeIntentId);
  assert.equal(first.storageObjectId, second.storageObjectId);
  assert.equal(first.duplicateProtection.replayed, false);
  assert.equal(second.duplicateProtection.replayed, true);
  await cancelIntent(configuration, state, first.writeIntentId, 'duplicate');
  return { replayed: true, sameWriteIntent: true, sameStorageObject: true };
}

async function scenarioCancelBeforeContent(configuration, state) {
  const media = Object.freeze({ mediaType: 'image/png', bytes: png() });
  const intent = await createIntent(configuration, state, media, 'cancel');
  const cancellation = await cancelIntent(configuration, state, intent.writeIntentId, 'cancel');
  assert.equal(cancellation.result.state, 'cancelled');
  const response = await fetch(
    `${configuration.baseUrl}/v1/object-write-intents/${intent.writeIntentId}/content`,
    {
      method: 'PUT',
      headers: {
        ...commonHeaders(configuration, 'cancel'),
        'content-type': intent.mediaType,
        'content-length': String(intent.bytes.byteLength),
        'x-content-sha256': intent.checksum,
        'x-zs-upload-completion-token': intent.uploadCompletionToken,
        'idempotency-key': idempotency(configuration, 'cancel-upload'),
      },
      body: intent.bytes,
      duplex: 'half',
    },
  );
  const body = await safeJson(response);
  assert.equal(response.status, 409);
  assert.equal(diagnosticCode(body), 'object-write-intent-cancelled');
  return { cancelled: true, uploadAfterCancelRejected: true };
}

async function scenarioHotReadFallback(configuration, state) {
  const storageObjectId = process.env.Z_S_VERIFY_FALLBACK_STORAGE_OBJECT_ID?.trim();
  if (!storageObjectId || !UUID.test(storageObjectId)) {
    throw new Error('verifier-fallback-object-required');
  }
  if (!state.completedObjectIds.includes(storageObjectId)) {
    throw new Error('verifier-fallback-object-not-owned-by-run');
  }
  const grant = await issueGrant(configuration, state, storageObjectId, 'fallback');
  const response = await readContent(configuration, storageObjectId, grant, 'fallback');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-zs-delivery-state'), 'canonical-fallback');
  const observed = new Uint8Array(await response.arrayBuffer());
  assert.ok(observed.byteLength > 0);
  await revokeGrant(configuration, state, grant.objectReadGrantId, 'fallback');
  return { deliveryState: 'canonical-fallback', byteLength: observed.byteLength };
}

async function scenarioRevokeReadGrant(configuration, state) {
  let storageObjectId = process.env.Z_S_VERIFY_EXISTING_STORAGE_OBJECT_ID?.trim();
  let retainedObjectCreated = false;
  if (!storageObjectId || !UUID.test(storageObjectId)) {
    const media = Object.freeze({ mediaType: 'image/png', bytes: png() });
    const { intent } = await createUploadedObject(configuration, state, media, 'revoke-object');
    storageObjectId = intent.storageObjectId;
    retainedObjectCreated = true;
  }
  const grant = await issueGrant(configuration, state, storageObjectId, 'revoke');
  await revokeGrant(configuration, state, grant.objectReadGrantId, 'revoke');
  const response = await readContent(configuration, storageObjectId, grant, 'revoked');
  const body = await safeJson(response);
  assert.equal(response.status, 403);
  assert.equal(diagnosticCode(body), 'object-read-grant-revoked');
  return { revokedGrantRejected: true, retainedObjectCreated };
}

async function scenarioCleanupOnly(configuration, state) {
  const grantCount = state.readGrantIds.length;
  const intentCount = state.pendingIntentIds.length;
  const failures = [];
  for (const grantId of [...state.readGrantIds]) {
    try {
      await revokeGrant(configuration, state, grantId, `cleanup-grant-${grantId.slice(0, 8)}`);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : 'cleanup-grant-failed');
    }
  }
  for (const intentId of [...state.pendingIntentIds]) {
    try {
      await cancelIntent(configuration, state, intentId, `cleanup-intent-${intentId.slice(0, 8)}`);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : 'cleanup-intent-failed');
    }
  }
  if (failures.length > 0 || state.readGrantIds.length > 0 || state.pendingIntentIds.length > 0) {
    throw new Error('verifier-cleanup-incomplete');
  }
  if (state.completedObjectIds.length > 0) {
    await saveState(state);
    throw new Error('completed-object-cleanup-not-supported-by-public-contract');
  }
  try {
    await unlink(stateFile(configuration.runId));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return {
    revokedGrantCount: grantCount,
    cancelledIntentCount: intentCount,
    cleanupComplete: true,
  };
}

async function runScenario(configuration, state) {
  switch (configuration.scenario) {
    case 'png-write-read':
      return scenarioPngWriteRead(configuration, state);
    case 'mp4-write-read-range':
      return scenarioMp4WriteReadRange(configuration, state);
    case 'duplicate-replay':
      return scenarioDuplicateReplay(configuration, state);
    case 'cancel-before-content':
      return scenarioCancelBeforeContent(configuration, state);
    case 'hot-read-fallback':
      return scenarioHotReadFallback(configuration, state);
    case 'revoke-read-grant':
      return scenarioRevokeReadGrant(configuration, state);
    case 'cleanup-only':
      return scenarioCleanupOnly(configuration, state);
    default:
      throw new Error('verifier-scenario-refused');
  }
}

try {
  const configuration = validateConfiguration(argumentsFrom(process.argv.slice(2)));
  const state = await loadState(configuration.runId);
  const evidence = await runScenario(configuration, state);
  console.log(JSON.stringify({
    verifier: 'video-maker-runtime',
    runId: configuration.runId,
    scenario: configuration.scenario,
    status: 'passed',
    evidence,
  }));
} catch (error) {
  console.error(JSON.stringify({
    verifier: 'video-maker-runtime',
    status: 'failed',
    code: error instanceof Error && /^[a-z0-9][a-z0-9-]{0,95}$/.test(error.message)
      ? error.message
      : 'verifier-failed',
  }));
  process.exitCode = 1;
}
