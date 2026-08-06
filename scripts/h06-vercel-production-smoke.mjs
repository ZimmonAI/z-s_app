import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const BASE_URL = 'https://z-s-app.vercel.app';
const RESULT_PATH = 'h06-vercel-smoke-result.json';
const STARTED_AT = new Date();

function safeFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/zs_client_session=[^;\s]+/gi, 'zs_client_session=[redacted]')
    .slice(0, 400);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function createTrueColorPng(width = 1600, height = 900) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * rowBytes;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      raw[offset] = Math.floor((x * 255) / Math.max(1, width - 1));
      raw[offset + 1] = Math.floor((y * 255) / Math.max(1, height - 1));
      raw[offset + 2] = Math.floor(((x + y) * 255) / Math.max(1, width + height - 2));
    }
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function parseAccountFile(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index < 1) continue;
    values.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  const clientId = values.get('Z_S_TEST_USER_ACCOUNT');
  const clientCredential = values.get('Z_S_TEST_USER_PASSWORD');
  if (!clientId || !clientCredential) {
    throw new Error('test-account-file-invalid');
  }
  return { clientId, clientCredential };
}

async function payload(response) {
  const type = response.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('application/json')) return null;
  return response.json().catch(() => null);
}

function errorCode(body) {
  if (!body || typeof body !== 'object') return null;
  const error = body.error;
  if (!error || typeof error !== 'object') return null;
  return typeof error.code === 'string'
    ? error.code
    : typeof error.diagnostic?.code === 'string'
      ? error.diagnostic.code
      : null;
}

async function expectJson(path, init, expectedStatuses) {
  const response = await fetch(new URL(path, BASE_URL), {
    redirect: 'follow',
    ...init,
  });
  const body = await payload(response);
  if (!expectedStatuses.includes(response.status)) {
    const code = errorCode(body) ??
      (response.status === 401 || response.status === 403
        ? 'access-denied'
        : 'unexpected-response');
    throw new Error(`${init?.method ?? 'GET'} ${path}: ${response.status} ${code}`);
  }
  return { response, body };
}

function sessionCookie(response) {
  const raw = response.headers.get('set-cookie');
  if (!raw) throw new Error('client-session-cookie-missing');
  const value = raw.split(';', 1)[0]?.trim();
  if (!value?.startsWith('zs_client_session=')) {
    throw new Error('client-session-cookie-invalid');
  }
  return value;
}

function safeJobs(items) {
  return items
    .map((item) => ({
      jobId: item.jobId,
      sourceStorageObjectId: item.sourceStorageObjectId,
      outputStorageObjectId: item.outputStorageObjectId ?? null,
      presetId: item.presetId,
      width: item.width,
      format: item.format,
      state: item.state,
      attemptCount: item.attemptCount,
      safeDiagnosticCode: item.safeDiagnosticCode ?? null,
      updatedAt: item.updatedAt,
    }))
    .sort((left, right) => left.width - right.width);
}

const result = {
  passed: false,
  environment: 'vercel-production',
  deploymentCommit: '31251bb0fbfadfd2e405fa15db69208b80c89a99',
  startedAt: STARTED_AT.toISOString(),
  finishedAt: null,
  signedOutBoundary: false,
  authenticatedBoundary: false,
  tokenCreated: false,
  tokenRevoked: false,
  uploadState: null,
  storageState: null,
  sourceStorageObjectId: null,
  jobs: [],
  failure: null,
};

let cookie = null;
let tokenId = null;

try {
  const health = await fetch(new URL('/healthz', BASE_URL), { redirect: 'follow' });
  if (health.status !== 200) {
    throw new Error(`GET /healthz: ${health.status} vercel-production-unavailable`);
  }

  const signedOut = await expectJson(
    '/client/storage/image-derivatives?environment=dev',
    { headers: { accept: 'application/json' } },
    [401],
  );
  if (errorCode(signedOut.body) !== 'client-login-required') {
    throw new Error('signed-out-boundary-code-mismatch');
  }
  result.signedOutBoundary = true;

  const account = parseAccountFile(await readFile('.test_account', 'utf8'));
  const login = await expectJson(
    '/client/session',
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        clientId: account.clientId,
        clientCredential: account.clientCredential,
      }),
    },
    [204],
  );
  cookie = sessionCookie(login.response);

  const authenticated = await expectJson(
    '/client/storage/image-derivatives?environment=dev',
    {
      headers: {
        accept: 'application/json',
        cookie,
      },
    },
    [200],
  );
  if (!Array.isArray(authenticated.body?.result)) {
    throw new Error('authenticated-status-shape-invalid');
  }
  result.authenticatedBoundary = true;

  const suffix = new Date().toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14)
    .toLowerCase();
  tokenId = `h06-vercel-${suffix}-runtime`;
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const tokenResponse = await expectJson(
    '/client/storage/integration-tokens',
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        cookie,
      },
      body: JSON.stringify({
        environment: 'dev',
        tokenId,
        displayLabel: 'H06 Vercel PNG derivative verification',
        scopes: ['object:write', 'object:read', 'object:manage'],
        expiresAt,
      }),
    },
    [201],
  );
  const runtimeToken = tokenResponse.body?.result?.token;
  if (typeof runtimeToken !== 'string' || runtimeToken.length < 16) {
    throw new Error('integration-token-reveal-missing');
  }
  result.tokenCreated = true;

  const bytes = createTrueColorPng();
  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
  const correlation = `h06-vercel-${randomUUID()}`;
  const intentKey = randomUUID();
  const intentResponse = await expectJson(
    '/v1/object-write-intents',
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${runtimeToken}`,
        'content-type': 'application/json',
        'idempotency-key': intentKey,
        'x-app-correlation-reference': correlation,
        'x-zs-caller-app': account.clientId,
        'x-zs-contract-version': '1.0',
      },
      body: JSON.stringify({
        storageProfile: {
          profileId: 'video-maker-dev-default',
          profileVersion: 1,
          environment: 'dev',
        },
        mediaType: 'image/png',
        byteLength: bytes.byteLength,
        checksumSha256,
        sourceReference: `h06-vercel-fresh-${randomUUID()}`,
      }),
    },
    [201],
  );

  const intent = intentResponse.body?.result;
  const writeIntentId = intent?.writeIntentId;
  const sourceStorageObjectId = intent?.storageObjectId;
  const completionToken = intent?.uploadCompletionToken;
  if (
    typeof writeIntentId !== 'string' ||
    typeof sourceStorageObjectId !== 'string' ||
    typeof completionToken !== 'string'
  ) {
    throw new Error('write-intent-result-invalid');
  }
  result.sourceStorageObjectId = sourceStorageObjectId;

  const uploadResponse = await expectJson(
    `/v1/object-write-intents/${encodeURIComponent(writeIntentId)}/content`,
    {
      method: 'PUT',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${runtimeToken}`,
        'content-length': String(bytes.byteLength),
        'content-type': 'image/png',
        'idempotency-key': randomUUID(),
        'x-app-correlation-reference': correlation,
        'x-content-sha256': checksumSha256,
        'x-zs-caller-app': account.clientId,
        'x-zs-contract-version': '1.0',
        'x-zs-upload-completion-token': completionToken,
      },
      body: bytes,
    },
    [200],
  );
  result.uploadState = uploadResponse.body?.result?.state ?? null;
  result.storageState = uploadResponse.body?.result?.storageState ?? null;
  if (result.uploadState !== 'recorded' || result.storageState !== 'ready') {
    throw new Error('upload-completion-state-invalid');
  }

  let matching = [];
  const deadline = Date.now() + 2 * 60 * 1000;
  while (Date.now() < deadline) {
    const status = await expectJson(
      '/client/storage/image-derivatives?environment=dev',
      {
        headers: {
          accept: 'application/json',
          cookie,
        },
      },
      [200],
    );
    const items = Array.isArray(status.body?.result) ? status.body.result : [];
    matching = items.filter((item) => item?.sourceStorageObjectId === sourceStorageObjectId);
    if (
      matching.length === 3 &&
      matching.every((item) => item.state === 'succeeded' || item.state === 'failed')
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  result.jobs = safeJobs(matching);
  const widths = result.jobs.map((job) => job.width);
  const outputIds = result.jobs
    .map((job) => job.outputStorageObjectId)
    .filter((value) => typeof value === 'string');
  const positiveGate =
    result.jobs.length === 3 &&
    JSON.stringify(widths) === JSON.stringify([512, 1024, 1600]) &&
    result.jobs.every((job) =>
      job.format === 'png' &&
      job.state === 'succeeded' &&
      job.attemptCount === 1 &&
      job.safeDiagnosticCode === null &&
      typeof job.outputStorageObjectId === 'string'
    ) &&
    new Set(outputIds).size === 3;
  if (!positiveGate) {
    throw new Error('positive-derivative-gate-failed');
  }

  result.passed = true;
} catch (error) {
  result.failure = safeFailure(error);
} finally {
  if (cookie && tokenId) {
    try {
      const revoked = await expectJson(
        `/client/storage/integration-tokens/${encodeURIComponent(tokenId)}?environment=dev`,
        {
          method: 'DELETE',
          headers: {
            accept: 'application/json',
            cookie,
          },
        },
        [200],
      );
      result.tokenRevoked = revoked.body?.result?.status === 'revoked';
    } catch (error) {
      result.failure ??= `token-revocation-failed: ${safeFailure(error)}`;
      result.passed = false;
    }
  }

  if (cookie) {
    try {
      await fetch(new URL('/client/session', BASE_URL), {
        method: 'DELETE',
        headers: { cookie },
        redirect: 'follow',
      });
    } catch {
      // Session expiry remains bounded; no credential material is persisted.
    }
  }

  if (result.tokenCreated && !result.tokenRevoked) {
    result.passed = false;
    result.failure ??= 'integration-token-not-revoked';
  }
  result.finishedAt = new Date().toISOString();
  await writeFile(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}
