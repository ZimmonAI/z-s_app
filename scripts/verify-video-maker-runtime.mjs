import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing-${name.toLowerCase().replaceAll('_', '-')}`);
  return value;
}

const baseUrl = requiredEnvironment('Z_S_VERIFY_BASE_URL').replace(/\/$/, '');
const bearerToken = requiredEnvironment('Z_S_VERIFY_BEARER_TOKEN');
const mp4Path = requiredEnvironment('Z_S_VERIFY_MP4_PATH');
const mp4 = await readFile(mp4Path);
if (mp4.byteLength < 1) throw new Error('verification-mp4-empty');
const checksumSha256 = createHash('sha256').update(mp4).digest('hex');
const correlation = `video-maker-runtime-${randomUUID()}`;
const intentKey = `intent-${randomUUID()}`;
const uploadKey = `upload-${randomUUID()}`;
const grantKey = `grant-${randomUUID()}`;

function headers(idempotencyKey, extra = {}) {
  return {
    authorization: `Bearer ${bearerToken}`,
    'x-zs-caller-app': 'video-maker_app',
    'x-zs-contract-version': '1.0',
    'x-app-correlation-reference': correlation,
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    ...extra,
  };
}

async function jsonResponse(response, expectedStatus) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`unexpected-non-json-response-${response.status}`);
  }
  if (response.status !== expectedStatus) {
    const code = body?.error?.diagnostic?.code ?? 'unexpected-status';
    throw new Error(`${code}-${response.status}`);
  }
  return body;
}

const evidence = [];
const readiness = await fetch(`${baseUrl}/readyz`);
const readinessBody = await jsonResponse(readiness, 200);
if (readinessBody.status !== 'ready') throw new Error('runtime-not-ready');
evidence.push({ scenario: 'unauthenticated-readiness', passed: true, status: readiness.status });

const intentRequest = {
  storageProfile: {
    profileId: 'video-maker-dev-default',
    profileVersion: 1,
    environment: 'dev',
  },
  mediaType: 'video/mp4',
  byteLength: mp4.byteLength,
  checksumSha256,
  sourceReference: `verification-${randomUUID()}`,
  requestedProtectionStage: 'write-intent-created',
};
const createIntentResponse = await fetch(`${baseUrl}/v1/object-write-intents`, {
  method: 'POST',
  headers: headers(intentKey, { 'content-type': 'application/json' }),
  body: JSON.stringify(intentRequest),
});
const createIntentBody = await jsonResponse(createIntentResponse, 200);
const writeIntentId = createIntentBody?.result?.writeIntentId;
const storageObjectId = createIntentBody?.result?.storageObjectId;
const uploadCompletionToken = createIntentBody?.result?.uploadCompletionToken;
if (!writeIntentId || !storageObjectId || !uploadCompletionToken) {
  throw new Error('write-intent-result-incomplete');
}
evidence.push({ scenario: 'create-write-intent', passed: true, status: createIntentResponse.status });

const uploadResponse = await fetch(
  `${baseUrl}/v1/object-write-intents/${encodeURIComponent(writeIntentId)}/content`,
  {
    method: 'PUT',
    headers: headers(uploadKey, {
      'content-type': 'video/mp4',
      'content-length': String(mp4.byteLength),
      'x-content-sha256': checksumSha256,
      'x-zs-upload-completion-token': uploadCompletionToken,
    }),
    body: mp4,
  },
);
const uploadBody = await jsonResponse(uploadResponse, 200);
if (uploadBody?.result?.storageState !== 'ready') throw new Error('upload-not-ready');
evidence.push({ scenario: 'upload-matching-mp4', passed: true, status: uploadResponse.status });

const replayResponse = await fetch(`${baseUrl}/v1/object-write-intents`, {
  method: 'POST',
  headers: headers(intentKey, { 'content-type': 'application/json' }),
  body: JSON.stringify(intentRequest),
});
const replayBody = await jsonResponse(replayResponse, 200);
if (replayBody?.result?.duplicateProtection?.replayed !== true) {
  throw new Error('idempotency-replay-not-reported');
}
evidence.push({ scenario: 'same-key-replay', passed: true, status: replayResponse.status });

const conflictResponse = await fetch(`${baseUrl}/v1/object-write-intents`, {
  method: 'POST',
  headers: headers(intentKey, { 'content-type': 'application/json' }),
  body: JSON.stringify({ ...intentRequest, sourceReference: `conflict-${randomUUID()}` }),
});
const conflictBody = await jsonResponse(conflictResponse, 409);
if (conflictBody?.error?.diagnostic?.code !== 'idempotency-key-reused') {
  throw new Error('idempotency-conflict-code-mismatch');
}
evidence.push({ scenario: 'conflicting-replay', passed: true, status: conflictResponse.status });

const grantResponse = await fetch(`${baseUrl}/v1/object-read-grants`, {
  method: 'POST',
  headers: headers(grantKey, { 'content-type': 'application/json' }),
  body: JSON.stringify({
    storageObjectId,
    purpose: 'video-maker-runtime-verification',
    allowedMethods: ['HEAD', 'GET'],
    allowRange: true,
    disposition: 'inline',
    fileName: 'verification.mp4',
    requestedTtlSeconds: 300,
    businessAuthorizationReference: `verification-${randomUUID()}`,
  }),
});
const grantBody = await jsonResponse(grantResponse, 200);
const readGrantToken = grantBody?.result?.readGrantToken;
if (!readGrantToken) throw new Error('read-grant-result-incomplete');
evidence.push({ scenario: 'issue-read-grant', passed: true, status: grantResponse.status });

const deliveryHeaders = headers(undefined, { 'x-zs-object-read-grant': readGrantToken });
const headResponse = await fetch(
  `${baseUrl}/v1/storage-objects/${encodeURIComponent(storageObjectId)}/content`,
  { method: 'HEAD', headers: deliveryHeaders },
);
if (headResponse.status !== 200 || headResponse.headers.get('content-length') !== String(mp4.byteLength)) {
  throw new Error(`head-delivery-failed-${headResponse.status}`);
}
const getResponse = await fetch(
  `${baseUrl}/v1/storage-objects/${encodeURIComponent(storageObjectId)}/content`,
  { method: 'GET', headers: deliveryHeaders },
);
if (getResponse.status !== 200) throw new Error(`get-delivery-failed-${getResponse.status}`);
const delivered = Buffer.from(await getResponse.arrayBuffer());
if (!delivered.equals(mp4)) throw new Error('get-delivery-bytes-mismatch');
evidence.push({ scenario: 'full-head-get', passed: true, status: getResponse.status });

const rangeEnd = Math.min(mp4.byteLength - 1, 31);
const rangeResponse = await fetch(
  `${baseUrl}/v1/storage-objects/${encodeURIComponent(storageObjectId)}/content`,
  {
    method: 'GET',
    headers: { ...deliveryHeaders, range: `bytes=0-${rangeEnd}` },
  },
);
if (rangeResponse.status !== 206) throw new Error(`range-delivery-failed-${rangeResponse.status}`);
const ranged = Buffer.from(await rangeResponse.arrayBuffer());
if (!ranged.equals(mp4.subarray(0, rangeEnd + 1))) throw new Error('range-delivery-bytes-mismatch');
evidence.push({ scenario: 'single-range-read', passed: true, status: rangeResponse.status });

console.log(JSON.stringify({
  service: 'z-s',
  verification: 'video-maker-runtime',
  passed: true,
  scenarios: evidence,
}));
