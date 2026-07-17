import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const SCENARIOS = Object.freeze([
  'png-write-read',
  'mp4-write-read-range',
  'duplicate-replay',
  'cancel-before-content',
  'hot-read-fallback',
  'revoke-read-grant',
  'cleanup-only',
]);
const STATE_DIRECTORY = '.z-s-video-maker-verifier';
const PROFILE = Object.freeze({
  profileId: 'video-maker-dev-default',
  profileVersion: 1,
  environment: 'dev',
});
const CONTRACT_VERSION = '1.0';
const CALLER_APP = 'video-maker_app';
const SAFE_RUN_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4QAAAABJRU5ErkJggg==',
  'base64',
);

function box(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + payload.length, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function minimalMp4() {
  const ftyp = Buffer.alloc(12);
  ftyp.write('isom', 0, 4, 'ascii');
  ftyp.writeUInt32BE(0, 4);
  ftyp.write('isom', 8, 4, 'ascii');
  const movieHeader = Buffer.alloc(100);
  movieHeader.writeUInt32BE(1_000, 12);
  movieHeader.writeUInt32BE(1_000, 16);
  return Buffer.concat([box('ftyp', ftyp), box('moov', box('mvhd', movieHeader))]);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseArguments(argv) {
  let runId;
  let confirmed = false;
  const scenarios = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--confirm-live-actions') {
      confirmed = true;
      continue;
    }
    if (argument === '--run-id') {
      runId = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--scenario') {
      const scenario = argv[index + 1];
      if (scenario !== undefined) scenarios.push(...scenario.split(','));
      index += 1;
      continue;
    }
    throw new Error('unsupported-argument');
  }
  if (!confirmed) throw new Error('live-actions-not-confirmed');
  if (typeof runId !== 'string' || !SAFE_RUN_ID.test(runId)) throw new Error('invalid-run-id');
  const selected = scenarios.length === 0 ? SCENARIOS.filter((entry) => entry !== 'cleanup-only') : scenarios;
  if (
    selected.length < 1 ||
    selected.some((entry) => !SCENARIOS.includes(entry)) ||
    new Set(selected).size !== selected.length
  ) {
    throw new Error('invalid-scenario-selection');
  }
  if (selected.includes('cleanup-only') && selected.length !== 1) {
    throw new Error('cleanup-only-must-run-alone');
  }
  return Object.freeze({ runId, scenarios: Object.freeze(selected) });
}

function runtimeConfiguration() {
  const token = process.env.Z_S_VIDEO_MAKER_BEARER_TOKEN;
  const rawBaseUrl = process.env.Z_S_RUNTIME_BASE_URL ?? 'http://127.0.0.1:4310';
  if (typeof token !== 'string' || token.length < 16) throw new Error('runtime-token-unavailable');
  let baseUrl;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error('runtime-base-url-invalid');
  }
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new Error('runtime-base-url-invalid');
  }
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, '');
  return Object.freeze({ token, baseUrl: baseUrl.toString().replace(/\/$/, '') });
}

function statePath(runId) {
  return path.join(STATE_DIRECTORY, `${runId}.json`);
}

function emptyState(runId) {
  return {
    schemaVersion: 1,
    runId,
    writeIntents: [],
    readGrants: [],
    completedObjects: [],
  };
}

function validState(value, runId) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.schemaVersion === 1 &&
    value.runId === runId &&
    Array.isArray(value.writeIntents) &&
    Array.isArray(value.readGrants) &&
    Array.isArray(value.completedObjects)
  );
}

async function loadState(runId) {
  try {
    const value = JSON.parse(await readFile(statePath(runId), 'utf8'));
    if (!validState(value, runId)) throw new Error('verification-state-invalid');
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState(runId);
    throw error;
  }
}

async function saveState(state) {
  await mkdir(STATE_DIRECTORY, { recursive: true, mode: 0o700 });
  const destination = statePath(state.runId);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, destination);
}

function requestHeaders(configuration, runId, action, extra = {}) {
  return {
    authorization: `Bearer ${configuration.token}`,
    'x-zs-caller-app': CALLER_APP,
    'x-zs-contract-version': CONTRACT_VERSION,
    'x-app-correlation-reference': `${runId}:${action}`,
    ...extra,
  };
}

async function request(configuration, pathname, init, acceptedStatuses = [200]) {
  const response = await fetch(`${configuration.baseUrl}${pathname}`, init);
  if (!acceptedStatuses.includes(response.status)) {
    let diagnosticCode = 'non-json-error';
    try {
      const body = await response.json();
      diagnosticCode = body?.error?.diagnostic?.code ?? diagnosticCode;
    } catch {
      // Public body is intentionally not echoed.
    }
    const error = new Error('runtime-request-failed');
    error.status = response.status;
    error.diagnosticCode = diagnosticCode;
    throw error;
  }
  return response;
}

async function jsonRequest(configuration, pathname, init, acceptedStatuses = [200]) {
  const response = await request(configuration, pathname, init, acceptedStatuses);
  return Object.freeze({
    response,
    body: await response.json(),
  });
}

function idempotencyKey(runId, scenario, operation) {
  return `${runId}:${scenario}:${operation}`;
}

function requireUuid(value, code) {
  if (typeof value !== 'string' || !SAFE_UUID.test(value)) throw new Error(code);
  return value;
}

function requireToken(value, code) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 4096) {
    throw new Error(code);
  }
  return value;
}

async function createIntent(configuration, state, runId, scenario, mediaType, content, operation = 'create') {
  const key = idempotencyKey(runId, scenario, operation);
  const checksumSha256 = sha256(content);
  const { body } = await jsonRequest(configuration, '/v1/object-write-intents', {
    method: 'POST',
    headers: requestHeaders(configuration, runId, `${scenario}:${operation}`, {
      'content-type': 'application/json',
      'idempotency-key': key,
    }),
    body: JSON.stringify({
      storageProfile: PROFILE,
      mediaType,
      byteLength: content.length,
      checksumSha256,
      sourceReference: `verify:${runId}:${scenario}`,
    }),
  });
  const result = body?.result;
  const writeIntentId = requireUuid(result?.writeIntentId, 'invalid-write-intent-id');
  const storageObjectId = requireUuid(result?.storageObjectId, 'invalid-storage-object-id');
  const uploadCompletionToken = requireToken(
    result?.uploadCompletionToken,
    'invalid-upload-completion-token',
  );
  if (result?.state !== 'accepted' || result?.expiresAt === undefined) {
    throw new Error('write-intent-not-accepted');
  }
  const existing = state.writeIntents.find((entry) => entry.writeIntentId === writeIntentId);
  if (existing === undefined) {
    state.writeIntents.push({
      writeIntentId,
      storageObjectId,
      state: 'accepted',
    });
    await saveState(state);
  }
  return Object.freeze({
    key,
    writeIntentId,
    storageObjectId,
    uploadCompletionToken,
    checksumSha256,
    byteLength: content.length,
    duplicateReplayed: result?.duplicateProtection?.replayed === true,
  });
}

async function uploadContent(configuration, state, runId, scenario, intent, mediaType, content) {
  const { body } = await jsonRequest(
    configuration,
    `/v1/object-write-intents/${intent.writeIntentId}/content`,
    {
      method: 'PUT',
      headers: requestHeaders(configuration, runId, `${scenario}:upload`, {
        'content-type': mediaType,
        'content-length': String(content.length),
        'x-content-sha256': intent.checksumSha256,
        'x-zs-upload-completion-token': intent.uploadCompletionToken,
        'idempotency-key': idempotencyKey(runId, scenario, 'upload'),
      }),
      body: content,
    },
  );
  const result = body?.result;
  if (
    result?.state !== 'recorded' ||
    result?.storageObjectId !== intent.storageObjectId ||
    result?.checksumSha256 !== intent.checksumSha256 ||
    result?.byteLength !== content.length
  ) {
    throw new Error('upload-result-mismatch');
  }
  const tracked = state.writeIntents.find((entry) => entry.writeIntentId === intent.writeIntentId);
  if (tracked !== undefined) tracked.state = 'completed';
  if (!state.completedObjects.includes(intent.storageObjectId)) {
    state.completedObjects.push(intent.storageObjectId);
  }
  await saveState(state);
  return result;
}

async function cancelIntent(configuration, state, runId, scenario, writeIntentId) {
  const { body } = await jsonRequest(
    configuration,
    `/v1/object-write-intents/${writeIntentId}`,
    {
      method: 'DELETE',
      headers: requestHeaders(configuration, runId, `${scenario}:cancel`, {
        'idempotency-key': idempotencyKey(runId, scenario, `cancel-${writeIntentId.slice(0, 8)}`),
      }),
    },
    [200],
  );
  if (body?.result?.state === 'cancelled') {
    const tracked = state.writeIntents.find((entry) => entry.writeIntentId === writeIntentId);
    if (tracked !== undefined) tracked.state = 'cancelled';
    await saveState(state);
  }
  return body;
}

async function issueGrant(
  configuration,
  state,
  runId,
  scenario,
  storageObjectId,
  options = {},
) {
  const { body } = await jsonRequest(configuration, '/v1/object-read-grants', {
    method: 'POST',
    headers: requestHeaders(configuration, runId, `${scenario}:grant`, {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey(runId, scenario, 'grant'),
    }),
    body: JSON.stringify({
      storageObjectId,
      purpose: 'runtime-verification',
      allowedMethods: ['HEAD', 'GET'],
      allowRange: options.allowRange ?? true,
      disposition: 'inline',
      requestedTtlSeconds: 120,
      businessAuthorizationReference: `verify:${runId}:${scenario}`,
    }),
  });
  const result = body?.result;
  const objectReadGrantId = requireUuid(result?.objectReadGrantId, 'invalid-read-grant-id');
  const readGrantToken = requireToken(result?.readGrantToken, 'invalid-read-grant-token');
  if (result?.state !== 'active' || result?.storageObjectId !== storageObjectId) {
    throw new Error('read-grant-not-active');
  }
  if (!state.readGrants.some((entry) => entry.objectReadGrantId === objectReadGrantId)) {
    state.readGrants.push({
      objectReadGrantId,
      storageObjectId,
      state: 'active',
    });
    await saveState(state);
  }
  return Object.freeze({ objectReadGrantId, readGrantToken });
}

async function revokeGrant(configuration, state, runId, scenario, objectReadGrantId) {
  const { body } = await jsonRequest(
    configuration,
    `/v1/object-read-grants/${objectReadGrantId}`,
    {
      method: 'DELETE',
      headers: requestHeaders(configuration, runId, `${scenario}:revoke`, {
        'idempotency-key': idempotencyKey(
          runId,
          scenario,
          `revoke-${objectReadGrantId.slice(0, 8)}`,
        ),
      }),
    },
  );
  if (body?.result?.state !== 'revoked' && body?.result?.state !== 'expired') {
    throw new Error('read-grant-revocation-mismatch');
  }
  const tracked = state.readGrants.find((entry) => entry.objectReadGrantId === objectReadGrantId);
  if (tracked !== undefined) tracked.state = body.result.state;
  await saveState(state);
}

function selectedHeaders(response) {
  return Object.freeze({
    contentLength: response.headers.get('content-length'),
    contentRange: response.headers.get('content-range'),
    contentType: response.headers.get('content-type'),
    deliveryState: response.headers.get('x-zs-delivery-state'),
    etagPresent: response.headers.has('etag'),
  });
}

async function readObject(configuration, runId, scenario, storageObjectId, grant, range) {
  const response = await request(
    configuration,
    `/v1/storage-objects/${storageObjectId}/content`,
    {
      method: 'GET',
      headers: requestHeaders(configuration, runId, `${scenario}:read`, {
        'x-zs-read-grant-token': grant.readGrantToken,
        ...(range === undefined ? {} : { range }),
      }),
    },
    range === undefined ? [200] : [206],
  );
  const content = Buffer.from(await response.arrayBuffer());
  return Object.freeze({
    status: response.status,
    content,
    headers: selectedHeaders(response),
  });
}

async function writeReadScenario(configuration, state, runId, scenario, mediaType, content, range) {
  const intent = await createIntent(configuration, state, runId, scenario, mediaType, content);
  const upload = await uploadContent(
    configuration,
    state,
    runId,
    scenario,
    intent,
    mediaType,
    content,
  );
  if (
    upload.storageState !== 'ready' ||
    upload.copies?.hot?.state !== 'verified' ||
    upload.copies?.canonical?.state !== 'verified'
  ) {
    throw new Error('write-not-fully-verified');
  }
  const grant = await issueGrant(
    configuration,
    state,
    runId,
    scenario,
    intent.storageObjectId,
  );
  const delivered = await readObject(
    configuration,
    runId,
    scenario,
    intent.storageObjectId,
    grant,
    range,
  );
  const expected = range === undefined ? content : content.subarray(0, 16);
  if (!delivered.content.equals(expected)) throw new Error('delivered-content-mismatch');
  await revokeGrant(configuration, state, runId, scenario, grant.objectReadGrantId);
  return Object.freeze({
    scenario,
    status: 'passed',
    storageObjectId: intent.storageObjectId,
    checksumSha256: upload.checksumSha256,
    byteLength: upload.byteLength,
    storageState: upload.storageState,
    copies: upload.copies,
    readStatus: delivered.status,
    readChecksumSha256: sha256(delivered.content),
    headers: delivered.headers,
  });
}

async function duplicateReplayScenario(configuration, state, runId) {
  const scenario = 'duplicate-replay';
  const first = await createIntent(configuration, state, runId, scenario, 'image/png', PNG);
  const second = await createIntent(configuration, state, runId, scenario, 'image/png', PNG);
  if (
    first.writeIntentId !== second.writeIntentId ||
    first.storageObjectId !== second.storageObjectId ||
    second.duplicateReplayed !== true
  ) {
    throw new Error('duplicate-replay-mismatch');
  }
  await cancelIntent(configuration, state, runId, scenario, first.writeIntentId);
  return Object.freeze({
    scenario,
    status: 'passed',
    writeIntentId: first.writeIntentId,
    storageObjectId: first.storageObjectId,
    replayed: true,
  });
}

async function cancelScenario(configuration, state, runId) {
  const scenario = 'cancel-before-content';
  const intent = await createIntent(configuration, state, runId, scenario, 'image/png', PNG);
  const body = await cancelIntent(configuration, state, runId, scenario, intent.writeIntentId);
  if (body?.result?.state !== 'cancelled') throw new Error('cancel-result-mismatch');
  return Object.freeze({
    scenario,
    status: 'passed',
    writeIntentId: intent.writeIntentId,
    storageObjectId: intent.storageObjectId,
    state: 'cancelled',
  });
}

async function fallbackScenario(configuration, state, runId) {
  const scenario = 'hot-read-fallback';
  const storageObjectId = requireUuid(
    process.env.Z_S_VERIFY_HOT_FALLBACK_STORAGE_OBJECT_ID,
    'fallback-storage-object-id-unavailable',
  );
  const grant = await issueGrant(configuration, state, runId, scenario, storageObjectId);
  const delivered = await readObject(
    configuration,
    runId,
    scenario,
    storageObjectId,
    grant,
  );
  if (delivered.headers.deliveryState !== 'canonical-fallback') {
    throw new Error('canonical-fallback-not-observed');
  }
  await revokeGrant(configuration, state, runId, scenario, grant.objectReadGrantId);
  return Object.freeze({
    scenario,
    status: 'passed',
    storageObjectId,
    readStatus: delivered.status,
    byteLength: delivered.content.length,
    checksumSha256: sha256(delivered.content),
    headers: delivered.headers,
  });
}

async function revokeScenario(configuration, state, runId) {
  const scenario = 'revoke-read-grant';
  const intent = await createIntent(configuration, state, runId, scenario, 'image/png', PNG);
  await uploadContent(configuration, state, runId, scenario, intent, 'image/png', PNG);
  const grant = await issueGrant(
    configuration,
    state,
    runId,
    scenario,
    intent.storageObjectId,
  );
  await revokeGrant(configuration, state, runId, scenario, grant.objectReadGrantId);
  const response = await request(
    configuration,
    `/v1/storage-objects/${intent.storageObjectId}/content`,
    {
      method: 'GET',
      headers: requestHeaders(configuration, runId, `${scenario}:read-after-revoke`, {
        'x-zs-read-grant-token': grant.readGrantToken,
      }),
    },
    [403],
  );
  return Object.freeze({
    scenario,
    status: 'passed',
    storageObjectId: intent.storageObjectId,
    revokedReadStatus: response.status,
  });
}

async function cleanup(configuration, state, runId) {
  const failures = [];
  let revoked = 0;
  let cancelled = 0;
  for (const grant of state.readGrants) {
    if (grant.state !== 'active') continue;
    try {
      await revokeGrant(
        configuration,
        state,
        runId,
        'cleanup-only',
        grant.objectReadGrantId,
      );
      revoked += 1;
    } catch {
      failures.push({ resource: 'read-grant', id: grant.objectReadGrantId });
    }
  }
  for (const intent of state.writeIntents) {
    if (intent.state !== 'accepted') continue;
    try {
      const body = await cancelIntent(
        configuration,
        state,
        runId,
        'cleanup-only',
        intent.writeIntentId,
      );
      if (body?.result?.state === 'cancelled') cancelled += 1;
    } catch {
      failures.push({ resource: 'write-intent', id: intent.writeIntentId });
    }
  }
  await saveState(state);
  if (failures.length > 0) {
    const error = new Error('cleanup-failed');
    error.failures = failures;
    throw error;
  }
  return Object.freeze({
    scenario: 'cleanup-only',
    status: 'passed',
    revokedReadGrants: revoked,
    cancelledWriteIntents: cancelled,
    retainedCompletedObjects: state.completedObjects.length,
  });
}

async function runScenario(configuration, state, runId, scenario) {
  if (scenario === 'png-write-read') {
    return writeReadScenario(
      configuration,
      state,
      runId,
      scenario,
      'image/png',
      PNG,
    );
  }
  if (scenario === 'mp4-write-read-range') {
    return writeReadScenario(
      configuration,
      state,
      runId,
      scenario,
      'video/mp4',
      minimalMp4(),
      'bytes=0-15',
    );
  }
  if (scenario === 'duplicate-replay') {
    return duplicateReplayScenario(configuration, state, runId);
  }
  if (scenario === 'cancel-before-content') {
    return cancelScenario(configuration, state, runId);
  }
  if (scenario === 'hot-read-fallback') {
    return fallbackScenario(configuration, state, runId);
  }
  if (scenario === 'revoke-read-grant') {
    return revokeScenario(configuration, state, runId);
  }
  return cleanup(configuration, state, runId);
}

let parsed;
let configuration;
let state;
try {
  parsed = parseArguments(process.argv.slice(2));
  configuration = runtimeConfiguration();
  state = await loadState(parsed.runId);
  for (const scenario of parsed.scenarios) {
    const result = await runScenario(configuration, state, parsed.runId, scenario);
    console.log(JSON.stringify(result));
  }
  if (!parsed.scenarios.includes('cleanup-only')) {
    const cleanupResult = await cleanup(configuration, state, parsed.runId);
    console.log(JSON.stringify(cleanupResult));
  }
} catch (error) {
  if (configuration !== undefined && state !== undefined && parsed !== undefined) {
    try {
      await cleanup(configuration, state, parsed.runId);
    } catch {
      // The primary failure remains authoritative; cleanup failure is reflected below.
    }
  }
  console.error(JSON.stringify({
    status: 'failed',
    code: typeof error?.message === 'string' ? error.message : 'verification-failed',
    httpStatus: Number.isInteger(error?.status) ? error.status : undefined,
    diagnosticCode:
      typeof error?.diagnosticCode === 'string' ? error.diagnosticCode : undefined,
    cleanupFailureCount: Array.isArray(error?.failures) ? error.failures.length : undefined,
  }));
  process.exitCode = 1;
}
