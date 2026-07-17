import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';

const ALLOWED_SCENARIOS = Object.freeze([
  'png-write-read',
  'mp4-write-read-range',
  'duplicate-replay',
  'cancel-before-content',
  'hot-read-fallback',
  'revoke-read-grant',
  'cleanup-only',
]);
const SAFE_RUN_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE = Object.freeze({
  profileId: 'video-maker-dev-default',
  profileVersion: 1,
  environment: 'dev',
});

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith('--') || values.has(flag)) throw new Error('verifier-argument-invalid');
    if (flag === '--confirm-live-actions') {
      values.set(flag, 'true');
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('verifier-argument-missing');
    values.set(flag, value);
    index += 1;
  }
  return Object.freeze({
    runId: values.get('--run-id'),
    scenario: values.get('--scenario'),
    stateFile: values.get('--state-file') ?? process.env.Z_S_VERIFY_STATE_FILE,
    fallbackSignalFile:
      values.get('--fallback-signal-file') ?? process.env.Z_S_VERIFY_FALLBACK_SIGNAL_FILE,
    confirmed: values.get('--confirm-live-actions') === 'true',
  });
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing-${name.toLowerCase().replaceAll('_', '-')}`);
  return value;
}

function validateConfiguration(config) {
  if (typeof config.runId !== 'string' || !SAFE_RUN_ID.test(config.runId)) {
    throw new Error('verifier-run-id-refused');
  }
  if (typeof config.scenario !== 'string' || !ALLOWED_SCENARIOS.includes(config.scenario)) {
    throw new Error('verifier-scenario-refused');
  }
  if (!config.confirmed || process.env.Z_S_VIDEO_MAKER_LIVE_ACTIONS_APPROVED !== 'true') {
    throw new Error('verifier-live-actions-not-confirmed');
  }
  if (typeof config.stateFile !== 'string' || config.stateFile.trim() === '') {
    throw new Error('verifier-state-file-required');
  }
  if (config.scenario === 'hot-read-fallback') {
    if (typeof config.fallbackSignalFile !== 'string' || config.fallbackSignalFile.trim() === '') {
      throw new Error('verifier-fallback-signal-file-required');
    }
  }
}

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

function pngFixture() {
  const ihdr = join(u32(2), u32(3), Uint8Array.of(8, 6, 0, 0, 0));
  return join(
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    u32(ihdr.byteLength),
    ascii('IHDR'),
    ihdr,
    new Uint8Array(4),
    u32(0),
    ascii('IEND'),
    new Uint8Array(4),
  );
}

function box(type, payload) {
  return join(u32(8 + payload.byteLength), ascii(type), payload);
}

function mp4Fixture() {
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

function safeHeaders(response) {
  const names = [
    'accept-ranges',
    'content-length',
    'content-range',
    'content-type',
    'etag',
    'x-zs-delivery-state',
  ];
  return Object.freeze(Object.fromEntries(
    names.flatMap((name) => {
      const value = response.headers.get(name);
      return value === null ? [] : [[name, value]];
    }),
  ));
}

class ApiError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'ApiError';
    this.code = SAFE_ID.test(code) ? code : 'verifier-api-error';
    this.status = status;
  }
}

async function jsonBody(response) {
  try {
    return await response.json();
  } catch {
    throw new ApiError('verifier-non-json-response', response.status);
  }
}

async function expectJson(response, status) {
  const body = await jsonBody(response);
  if (response.status !== status) {
    throw new ApiError(body?.error?.diagnostic?.code ?? 'verifier-unexpected-status', response.status);
  }
  return body;
}

function assertUuid(value, code) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(code);
  return value;
}

function correlation(runId, scenario) {
  return `p0-s2d-vm-${runId}-${scenario}`;
}

function idempotency(runId, scenario, operation) {
  const value = `p0-s2d-vm-${runId}-${scenario}-${operation}`;
  if (!SAFE_ID.test(value)) throw new Error('verifier-idempotency-key-invalid');
  return value;
}

function createApi(baseUrl, bearerToken, runId, scenario) {
  const appCorrelationReference = correlation(runId, scenario);
  const common = (key, extra = {}) => ({
    authorization: `Bearer ${bearerToken}`,
    'x-zs-caller-app': 'video-maker_app',
    'x-zs-contract-version': '1.0',
    'x-app-correlation-reference': appCorrelationReference,
    ...(key === undefined ? {} : { 'idempotency-key': key }),
    ...extra,
  });
  return Object.freeze({
    appCorrelationReference,
    async readiness() {
      const response = await fetch(`${baseUrl}/readyz`);
      const body = await expectJson(response, 200);
      if (body.status !== 'ready') throw new Error('verifier-runtime-not-ready');
      return Object.freeze({ status: response.status });
    },
    async createIntent(input, key) {
      const response = await fetch(`${baseUrl}/v1/object-write-intents`, {
        method: 'POST',
        headers: common(key, { 'content-type': 'application/json' }),
        body: JSON.stringify({
          storageProfile: PROFILE,
          mediaType: input.mediaType,
          byteLength: input.bytes.byteLength,
          checksumSha256: input.checksumSha256,
          sourceReference: `${appCorrelationReference}-${input.sourceSuffix}`,
          requestedProtectionStage: 'write-intent-created',
        }),
      });
      return Object.freeze({ response, body: await expectJson(response, 200) });
    },
    async upload(writeIntentId, token, input, key) {
      const response = await fetch(
        `${baseUrl}/v1/object-write-intents/${encodeURIComponent(writeIntentId)}/content`,
        {
          method: 'PUT',
          headers: common(key, {
            'content-type': input.mediaType,
            'content-length': String(input.bytes.byteLength),
            'x-content-sha256': input.checksumSha256,
            'x-zs-upload-completion-token': token,
          }),
          body: input.bytes,
        },
      );
      return Object.freeze({ response, body: await expectJson(response, 200) });
    },
    async cancel(writeIntentId, key) {
      const response = await fetch(
        `${baseUrl}/v1/object-write-intents/${encodeURIComponent(writeIntentId)}`,
        { method: 'DELETE', headers: common(key) },
      );
      return Object.freeze({ response, body: await expectJson(response, 200) });
    },
    async issueGrant(storageObjectId, key, purpose) {
      const response = await fetch(`${baseUrl}/v1/object-read-grants`, {
        method: 'POST',
        headers: common(key, { 'content-type': 'application/json' }),
        body: JSON.stringify({
          storageObjectId,
          purpose,
          allowedMethods: ['HEAD', 'GET'],
          allowRange: true,
          disposition: 'inline',
          fileName: `${scenario}.bin`,
          requestedTtlSeconds: 300,
          businessAuthorizationReference: `${appCorrelationReference}-${purpose}`,
        }),
      });
      return Object.freeze({ response, body: await expectJson(response, 200) });
    },
    async revokeGrant(grantId, key) {
      const response = await fetch(
        `${baseUrl}/v1/object-read-grants/${encodeURIComponent(grantId)}`,
        { method: 'DELETE', headers: common(key) },
      );
      return Object.freeze({ response, body: await expectJson(response, 200) });
    },
    async deliver(storageObjectId, token, method, range) {
      const response = await fetch(
        `${baseUrl}/v1/storage-objects/${encodeURIComponent(storageObjectId)}/content`,
        {
          method,
          headers: common(undefined, {
            'x-zs-read-grant-token': token,
            ...(range === undefined ? {} : { range }),
          }),
        },
      );
      return response;
    },
  });
}

function newState(config) {
  return {
    schemaVersion: 1,
    runId: config.runId,
    correlationPrefix: `p0-s2d-vm-${config.runId}`,
    intents: [],
    grants: [],
    completedObjectIds: [],
  };
}

async function loadState(config) {
  try {
    const parsed = JSON.parse(await readFile(config.stateFile, 'utf8'));
    if (parsed?.runId !== config.runId || parsed?.schemaVersion !== 1) {
      throw new Error('verifier-state-file-mismatch');
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return newState(config);
    throw error;
  }
}

async function saveState(config, state) {
  await writeFile(config.stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function fixture(mediaType) {
  const bytes = mediaType === 'image/png' ? pngFixture() : mp4Fixture();
  return Object.freeze({
    mediaType,
    bytes,
    checksumSha256: checksum(bytes),
    sourceSuffix: mediaType === 'image/png' ? 'png' : 'mp4',
  });
}

function captureIntent(state, result, stateName) {
  const writeIntentId = assertUuid(result?.writeIntentId, 'verifier-write-intent-id-invalid');
  const storageObjectId = assertUuid(result?.storageObjectId, 'verifier-storage-object-id-invalid');
  const existing = state.intents.find((entry) => entry.writeIntentId === writeIntentId);
  if (existing === undefined) state.intents.push({ writeIntentId, storageObjectId, state: stateName });
  else existing.state = stateName;
  return Object.freeze({ writeIntentId, storageObjectId });
}

function captureGrant(state, result) {
  const objectReadGrantId = assertUuid(
    result?.objectReadGrantId,
    'verifier-object-read-grant-id-invalid',
  );
  const storageObjectId = assertUuid(result?.storageObjectId, 'verifier-storage-object-id-invalid');
  if (!state.grants.some((entry) => entry.objectReadGrantId === objectReadGrantId)) {
    state.grants.push({ objectReadGrantId, storageObjectId, state: result.state });
  }
  return objectReadGrantId;
}

function completionToken(result) {
  if (typeof result?.uploadCompletionToken !== 'string' || result.uploadCompletionToken === '') {
    throw new Error('verifier-upload-completion-token-missing');
  }
  return result.uploadCompletionToken;
}

function readGrantToken(result) {
  if (typeof result?.readGrantToken !== 'string' || result.readGrantToken === '') {
    throw new Error('verifier-read-grant-token-missing');
  }
  return result.readGrantToken;
}

async function createCompletedFixture(api, config, state, input, suffix) {
  const intentKey = idempotency(config.runId, config.scenario, `intent-${suffix}`);
  const uploadKey = idempotency(config.runId, config.scenario, `upload-${suffix}`);
  const intent = await api.createIntent({ ...input, sourceSuffix: suffix }, intentKey);
  const ids = captureIntent(state, intent.body.result, 'accepted');
  const upload = await api.upload(
    ids.writeIntentId,
    completionToken(intent.body.result),
    input,
    uploadKey,
  );
  if (upload.body?.result?.storageState !== 'ready') throw new Error('verifier-upload-not-ready');
  state.intents.find((entry) => entry.writeIntentId === ids.writeIntentId).state = 'completed';
  if (!state.completedObjectIds.includes(ids.storageObjectId)) {
    state.completedObjectIds.push(ids.storageObjectId);
  }
  await saveState(config, state);
  return Object.freeze({ ids, intent, upload, intentKey, uploadKey });
}

async function issueGrant(api, config, state, storageObjectId, suffix) {
  const key = idempotency(config.runId, config.scenario, `grant-${suffix}`);
  const grant = await api.issueGrant(storageObjectId, key, `${config.scenario}-${suffix}`);
  const objectReadGrantId = captureGrant(state, grant.body.result);
  await saveState(config, state);
  return Object.freeze({
    grant,
    objectReadGrantId,
    token: readGrantToken(grant.body.result),
    key,
  });
}

async function verifyHeadGet(api, storageObjectId, token, input, expectedDeliveryState) {
  const head = await api.deliver(storageObjectId, token, 'HEAD');
  if (head.status !== 200) throw new ApiError('verifier-head-failed', head.status);
  assert.equal(await head.arrayBuffer().then((value) => value.byteLength), 0);
  assert.equal(head.headers.get('content-length'), String(input.bytes.byteLength));
  assert.equal(head.headers.get('content-type'), input.mediaType);
  assert.equal(head.headers.get('etag'), `"${input.checksumSha256}"`);
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.equal(head.headers.get('x-zs-delivery-state'), expectedDeliveryState);

  const get = await api.deliver(storageObjectId, token, 'GET');
  if (get.status !== 200) throw new ApiError('verifier-get-failed', get.status);
  assert.equal(get.headers.get('x-zs-delivery-state'), expectedDeliveryState);
  const delivered = new Uint8Array(await get.arrayBuffer());
  assert.deepEqual(delivered, input.bytes);
  return Object.freeze({
    head: Object.freeze({ status: head.status, headers: safeHeaders(head) }),
    get: Object.freeze({ status: get.status, headers: safeHeaders(get) }),
  });
}

async function pngWriteRead(api, config, state) {
  const input = fixture('image/png');
  const completed = await createCompletedFixture(api, config, state, input, 'png');
  if (completed.upload.body?.result?.verifiedMedia?.mediaFamily !== 'image') {
    throw new Error('verifier-png-metadata-missing');
  }
  const grant = await issueGrant(api, config, state, completed.ids.storageObjectId, 'png');
  const delivery = await verifyHeadGet(api, completed.ids.storageObjectId, grant.token, input, 'hot');
  return Object.freeze({
    scenario: config.scenario,
    storageObjectId: completed.ids.storageObjectId,
    checksumSha256: input.checksumSha256,
    byteLength: input.bytes.byteLength,
    delivery,
  });
}

async function mp4WriteReadRange(api, config, state) {
  const input = fixture('video/mp4');
  const completed = await createCompletedFixture(api, config, state, input, 'mp4');
  if (completed.upload.body?.result?.verifiedMedia?.mediaFamily !== 'video') {
    throw new Error('verifier-mp4-metadata-missing');
  }
  const grant = await issueGrant(api, config, state, completed.ids.storageObjectId, 'mp4');
  const delivery = await verifyHeadGet(api, completed.ids.storageObjectId, grant.token, input, 'hot');
  const total = input.bytes.byteLength;
  const ranges = [
    { name: 'closed', request: 'bytes=0-7', start: 0, end: 7 },
    { name: 'open-ended', request: 'bytes=8-', start: 8, end: total - 1 },
    { name: 'suffix', request: 'bytes=-8', start: Math.max(total - 8, 0), end: total - 1 },
  ];
  const rangeEvidence = [];
  for (const range of ranges) {
    const response = await api.deliver(
      completed.ids.storageObjectId,
      grant.token,
      'GET',
      range.request,
    );
    if (response.status !== 206) throw new ApiError(`verifier-${range.name}-range-failed`, response.status);
    assert.equal(response.headers.get('content-range'), `bytes ${range.start}-${range.end}/${total}`);
    assert.equal(response.headers.get('x-zs-delivery-state'), 'hot');
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      input.bytes.slice(range.start, range.end + 1),
    );
    rangeEvidence.push(Object.freeze({
      name: range.name,
      status: response.status,
      headers: safeHeaders(response),
    }));
  }
  const unsatisfiable = await api.deliver(
    completed.ids.storageObjectId,
    grant.token,
    'GET',
    `bytes=${total}-`,
  );
  const unsatisfiableBody = await expectJson(unsatisfiable, 416);
  if (unsatisfiableBody?.error?.diagnostic?.code !== 'range-not-satisfiable') {
    throw new Error('verifier-unsatisfiable-range-code-mismatch');
  }
  assert.equal(unsatisfiable.headers.get('accept-ranges'), 'bytes');
  assert.equal(unsatisfiable.headers.get('content-range'), `bytes */${total}`);
  return Object.freeze({
    scenario: config.scenario,
    storageObjectId: completed.ids.storageObjectId,
    checksumSha256: input.checksumSha256,
    byteLength: total,
    delivery,
    ranges: Object.freeze(rangeEvidence),
    unsatisfiable: Object.freeze({ status: unsatisfiable.status, headers: safeHeaders(unsatisfiable) }),
  });
}

async function duplicateReplay(api, config, state) {
  const input = fixture('video/mp4');
  const intentKey = idempotency(config.runId, config.scenario, 'intent');
  const uploadKey = idempotency(config.runId, config.scenario, 'upload');
  const request = { ...input, sourceSuffix: 'duplicate' };
  const first = await api.createIntent(request, intentKey);
  const ids = captureIntent(state, first.body.result, 'accepted');
  const replay = await api.createIntent(request, intentKey);
  assert.equal(replay.body?.result?.writeIntentId, ids.writeIntentId);
  assert.equal(replay.body?.result?.storageObjectId, ids.storageObjectId);
  assert.equal(replay.body?.result?.duplicateProtection?.replayed, true);
  const token = completionToken(first.body.result);
  const completion = await api.upload(ids.writeIntentId, token, input, uploadKey);
  const completionReplay = await api.upload(ids.writeIntentId, token, input, uploadKey);
  assert.equal(completionReplay.body?.result?.storageObjectId, ids.storageObjectId);
  assert.equal(completionReplay.body?.result?.duplicateProtection?.replayed, true);
  state.intents.find((entry) => entry.writeIntentId === ids.writeIntentId).state = 'completed';
  if (!state.completedObjectIds.includes(ids.storageObjectId)) state.completedObjectIds.push(ids.storageObjectId);
  await saveState(config, state);
  return Object.freeze({
    scenario: config.scenario,
    writeIntentId: ids.writeIntentId,
    storageObjectId: ids.storageObjectId,
    writeReplayStatus: replay.response.status,
    completionReplayStatus: completionReplay.response.status,
    checksumSha256: input.checksumSha256,
    byteLength: input.bytes.byteLength,
    completionState: completion.body?.result?.storageState,
  });
}

async function cancelBeforeContent(api, config, state) {
  const input = fixture('image/png');
  const intent = await api.createIntent(
    { ...input, sourceSuffix: 'cancel' },
    idempotency(config.runId, config.scenario, 'intent'),
  );
  const ids = captureIntent(state, intent.body.result, 'accepted');
  const key = idempotency(config.runId, config.scenario, 'cancel');
  const cancelled = await api.cancel(ids.writeIntentId, key);
  const replay = await api.cancel(ids.writeIntentId, key);
  assert.equal(cancelled.body?.result?.state, 'cancelled');
  assert.equal(replay.body?.result?.state, 'cancelled');
  assert.equal(replay.body?.result?.duplicateProtection?.replayed, true);
  state.intents.find((entry) => entry.writeIntentId === ids.writeIntentId).state = 'cancelled';
  await saveState(config, state);
  return Object.freeze({
    scenario: config.scenario,
    writeIntentId: ids.writeIntentId,
    storageObjectId: ids.storageObjectId,
    firstStatus: cancelled.response.status,
    replayStatus: replay.response.status,
  });
}

async function revokeReadGrant(api, config, state) {
  const input = fixture('video/mp4');
  const completed = await createCompletedFixture(api, config, state, input, 'revoke');
  const grant = await issueGrant(api, config, state, completed.ids.storageObjectId, 'revoke');
  await verifyHeadGet(api, completed.ids.storageObjectId, grant.token, input, 'hot');
  const key = idempotency(config.runId, config.scenario, 'revoke');
  const revoked = await api.revokeGrant(grant.objectReadGrantId, key);
  const replay = await api.revokeGrant(grant.objectReadGrantId, key);
  assert.equal(revoked.body?.result?.state, 'revoked');
  assert.equal(replay.body?.result?.duplicateProtection?.replayed, true);
  const stateEntry = state.grants.find((entry) => entry.objectReadGrantId === grant.objectReadGrantId);
  if (stateEntry !== undefined) stateEntry.state = 'revoked';
  await saveState(config, state);
  for (const method of ['HEAD', 'GET']) {
    const denied = await api.deliver(completed.ids.storageObjectId, grant.token, method);
    const deniedBody = await expectJson(denied, 403);
    if (deniedBody?.error?.diagnostic?.code !== 'object-read-grant-revoked') {
      throw new Error('verifier-post-revoke-code-mismatch');
    }
  }
  return Object.freeze({
    scenario: config.scenario,
    storageObjectId: completed.ids.storageObjectId,
    objectReadGrantId: grant.objectReadGrantId,
    firstStatus: revoked.response.status,
    replayStatus: replay.response.status,
    postRevokeStatus: 403,
  });
}

async function waitForFallbackSignal(path) {
  const maximumSeconds = Number(process.env.Z_S_VERIFY_FALLBACK_WAIT_SECONDS ?? '300');
  if (!Number.isSafeInteger(maximumSeconds) || maximumSeconds < 1 || maximumSeconds > 900) {
    throw new Error('verifier-fallback-wait-invalid');
  }
  const deadline = Date.now() + maximumSeconds * 1_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error('verifier-fallback-signal-timeout');
}

async function hotReadFallback(api, config, state) {
  const input = fixture('video/mp4');
  const completed = await createCompletedFixture(api, config, state, input, 'fallback');
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    status: 'awaiting-hot-object-removal',
    runId: config.runId,
    scenario: config.scenario,
    storageObjectId: completed.ids.storageObjectId,
  })}\n`);
  await waitForFallbackSignal(config.fallbackSignalFile);
  const grant = await issueGrant(api, config, state, completed.ids.storageObjectId, 'fallback');
  const delivery = await verifyHeadGet(
    api,
    completed.ids.storageObjectId,
    grant.token,
    input,
    'canonical-fallback',
  );
  const range = await api.deliver(
    completed.ids.storageObjectId,
    grant.token,
    'GET',
    'bytes=0-7',
  );
  if (range.status !== 206) throw new ApiError('verifier-fallback-range-failed', range.status);
  assert.equal(range.headers.get('x-zs-delivery-state'), 'canonical-fallback');
  assert.deepEqual(new Uint8Array(await range.arrayBuffer()), input.bytes.slice(0, 8));
  return Object.freeze({
    scenario: config.scenario,
    storageObjectId: completed.ids.storageObjectId,
    delivery,
    range: Object.freeze({ status: range.status, headers: safeHeaders(range) }),
  });
}

async function cleanupOnly(api, config, state) {
  const cleaned = { cancelledIntents: 0, revokedGrants: 0 };
  for (const grant of state.grants) {
    if (grant.state === 'revoked' || grant.state === 'expired') continue;
    const key = idempotency(config.runId, config.scenario, `revoke-${grant.objectReadGrantId.slice(0, 8)}`);
    const result = await api.revokeGrant(grant.objectReadGrantId, key);
    if (result.body?.result?.state !== 'revoked' && result.body?.result?.state !== 'expired') {
      throw new Error('verifier-cleanup-revoke-incomplete');
    }
    grant.state = result.body.result.state;
    cleaned.revokedGrants += 1;
  }
  for (const intent of state.intents) {
    if (intent.state !== 'accepted' && intent.state !== 'uploading') continue;
    const key = idempotency(config.runId, config.scenario, `cancel-${intent.writeIntentId.slice(0, 8)}`);
    const result = await api.cancel(intent.writeIntentId, key);
    if (result.body?.result?.state !== 'cancelled') {
      throw new Error('verifier-cleanup-cancel-incomplete');
    }
    intent.state = 'cancelled';
    cleaned.cancelledIntents += 1;
  }
  await saveState(config, state);
  if (state.completedObjectIds.length > 0) {
    throw new Error('completed-object-cleanup-not-supported-by-public-contract');
  }
  return Object.freeze({ scenario: config.scenario, ...cleaned, complete: true });
}

function safeFailureCode(error) {
  if (error instanceof ApiError) return error.code;
  if (error?.code === 'ERR_ASSERTION') return 'verifier-assertion-failed';
  if (error instanceof Error && /^[a-z0-9][a-z0-9-]{0,95}$/.test(error.message)) {
    return error.message;
  }
  return 'verifier-execution-failed';
}

async function execute() {
  const config = parseArguments(process.argv.slice(2));
  validateConfiguration(config);
  const baseUrl = requiredEnvironment('Z_S_VERIFY_BASE_URL').replace(/\/$/, '');
  const bearerToken = requiredEnvironment('Z_S_VERIFY_BEARER_TOKEN');
  const api = createApi(baseUrl, bearerToken, config.runId, config.scenario);
  const state = await loadState(config);
  const readiness = await api.readiness();
  let result;
  switch (config.scenario) {
    case 'png-write-read':
      result = await pngWriteRead(api, config, state);
      break;
    case 'mp4-write-read-range':
      result = await mp4WriteReadRange(api, config, state);
      break;
    case 'duplicate-replay':
      result = await duplicateReplay(api, config, state);
      break;
    case 'cancel-before-content':
      result = await cancelBeforeContent(api, config, state);
      break;
    case 'hot-read-fallback':
      result = await hotReadFallback(api, config, state);
      break;
    case 'revoke-read-grant':
      result = await revokeReadGrant(api, config, state);
      break;
    case 'cleanup-only':
      result = await cleanupOnly(api, config, state);
      break;
    default:
      throw new Error('verifier-scenario-refused');
  }
  return Object.freeze({
    schemaVersion: 1,
    status: 'passed',
    runId: config.runId,
    readiness,
    result,
    safety: Object.freeze({
      bearerTokenEmitted: false,
      completionTokenEmitted: false,
      readGrantTokenEmitted: false,
      endpointEmitted: false,
      providerAuthorityEmitted: false,
      credentialsEmitted: false,
      publicHttpContractOnly: true,
    }),
  });
}

try {
  const summary = await execute();
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    status: 'failed',
    diagnostic: Object.freeze({ code: safeFailureCode(error), retryable: false }),
  })}\n`);
  process.exitCode = 1;
}
