import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const config = { maxDuration: 300 };

const BASE_URL = 'https://z-s-app.vercel.app';
const ACCOUNT_URL = 'https://raw.githubusercontent.com/ZimmonAI/z-s_app/main/.test_account';

function safeFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/zs_client_session=[^;\s]+/gi, 'zs_client_session=[redacted]')
    .slice(0, 400);
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

function errorCategory(body) {
  if (!body || typeof body !== 'object') return null;
  const error = body.error;
  if (!error || typeof error !== 'object') return null;
  return typeof error.category === 'string'
    ? error.category
    : typeof error.diagnostic?.category === 'string'
      ? error.diagnostic.category
      : null;
}

async function readPayload(response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return null;
  return response.json().catch(() => null);
}

async function call(path, init = {}) {
  const response = await fetch(new URL(path, BASE_URL), {
    redirect: 'follow',
    ...init,
  });
  return {
    response,
    body: await readPayload(response),
  };
}

function requireStatus(step, callResult, accepted) {
  if (!accepted.includes(callResult.response.status)) {
    throw new Error(
      `${step}: ${callResult.response.status} ${errorCode(callResult.body) ?? 'unexpected-response'}`,
    );
  }
  return callResult;
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

function safeJobs(items) {
  return items
    .map((item) => ({
      jobId: item.jobId ?? null,
      sourceStorageObjectId: item.sourceStorageObjectId ?? null,
      outputStorageObjectId: item.outputStorageObjectId ?? null,
      presetId: item.presetId ?? null,
      width: item.width ?? null,
      format: item.format ?? null,
      state: item.state ?? null,
      attemptCount: item.attemptCount ?? null,
      safeDiagnosticCategory: item.safeDiagnosticCategory ?? null,
      safeDiagnosticCode: item.safeDiagnosticCode ?? null,
      updatedAt: item.updatedAt ?? null,
    }))
    .sort((left, right) => Number(left.width) - Number(right.width));
}

async function runSmoke() {
  const result = {
    passed: false,
    environment: 'vercel-production',
    productionCommit: '4ba9962e61e4bc4a8fdc4fbdf955b352a2aa4b64',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    readiness: null,
    signedOutBoundary: null,
    loginStatus: null,
    statusPrecheck: null,
    tokenCreated: false,
    tokenRevoked: false,
    writeIntentStatus: null,
    uploadStatus: null,
    uploadState: null,
    storageState: null,
    sourceStorageObjectId: null,
    statusPoll: null,
    jobs: [],
    failure: null,
  };

  let cookie = null;
  let tokenId = null;

  try {
    const readiness = await call('/readyz', { headers: { accept: 'application/json' } });
    result.readiness = {
      status: readiness.response.status,
      serviceStatus: readiness.body?.status ?? null,
      controlPlane: readiness.body?.controlPlane?.status ?? null,
      dataPlane: readiness.body?.dataPlane?.status ?? null,
    };
    requireStatus('readiness', readiness, [200]);

    const signedOut = await call(
      '/client/storage/image-derivatives?environment=dev',
      { headers: { accept: 'application/json' } },
    );
    result.signedOutBoundary = {
      status: signedOut.response.status,
      code: errorCode(signedOut.body),
    };
    if (
      signedOut.response.status !== 401 ||
      errorCode(signedOut.body) !== 'client-login-required'
    ) {
      throw new Error('signed-out-boundary-mismatch');
    }

    const accountResponse = await fetch(ACCOUNT_URL, { redirect: 'follow' });
    if (!accountResponse.ok) throw new Error('test-account-fetch-failed');
    const account = parseAccountFile(await accountResponse.text());

    const login = await call('/client/session', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        clientId: account.clientId,
        clientCredential: account.clientCredential,
      }),
    });
    result.loginStatus = login.response.status;
    requireStatus('client-login', login, [204]);
    cookie = sessionCookie(login.response);

    const precheck = await call(
      '/client/storage/image-derivatives?environment=dev',
      { headers: { accept: 'application/json', cookie } },
    );
    result.statusPrecheck = {
      status: precheck.response.status,
      code: errorCode(precheck.body),
      category: errorCategory(precheck.body),
      resultIsArray: Array.isArray(precheck.body?.result),
    };

    tokenId = `h06-vercel-retry-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
    const tokenResponse = await call('/client/storage/integration-tokens', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        cookie,
      },
      body: JSON.stringify({
        environment: 'dev',
        tokenId,
        displayLabel: 'H06 Vercel PNG derivative verification retry',
        scopes: ['object:write', 'object:read', 'object:manage'],
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
    });
    requireStatus('integration-token-create', tokenResponse, [201]);

    const runtimeToken = tokenResponse.body?.result?.token;
    if (typeof runtimeToken !== 'string' || runtimeToken.length < 16) {
      throw new Error('integration-token-reveal-missing');
    }
    result.tokenCreated = true;

    const bytes = createTrueColorPng();
    const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
    const correlation = `h06-vercel-retry-${randomUUID()}`;

    const intentResponse = await call('/v1/object-write-intents', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${runtimeToken}`,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
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
        sourceReference: `h06-vercel-retry-fresh-${randomUUID()}`,
      }),
    });
    result.writeIntentStatus = {
      status: intentResponse.response.status,
      code: errorCode(intentResponse.body),
      category: errorCategory(intentResponse.body),
    };
    requireStatus('write-intent-create', intentResponse, [201]);

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

    const uploadResponse = await call(
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
    );
    result.uploadStatus = {
      status: uploadResponse.response.status,
      code: errorCode(uploadResponse.body),
      category: errorCategory(uploadResponse.body),
    };
    requireStatus('upload-content', uploadResponse, [200]);

    result.uploadState = uploadResponse.body?.result?.state ?? null;
    result.storageState = uploadResponse.body?.result?.storageState ?? null;

    let matching = [];
    let lastPoll = null;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const status = await call(
        '/client/storage/image-derivatives?environment=dev',
        { headers: { accept: 'application/json', cookie } },
      );
      lastPoll = {
        status: status.response.status,
        code: errorCode(status.body),
        category: errorCategory(status.body),
      };

      if (status.response.status === 200) {
        const items = Array.isArray(status.body?.result) ? status.body.result : [];
        matching = items.filter(
          (item) => item?.sourceStorageObjectId === sourceStorageObjectId,
        );
        if (
          matching.length === 3 &&
          matching.every(
            (item) => item.state === 'succeeded' || item.state === 'failed',
          )
        ) {
          break;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    result.statusPoll = lastPoll;
    result.jobs = safeJobs(matching);

    const widths = result.jobs.map((job) => job.width);
    const outputIds = result.jobs
      .map((job) => job.outputStorageObjectId)
      .filter((value) => typeof value === 'string');

    result.passed =
      result.uploadState === 'recorded' &&
      result.storageState === 'ready' &&
      result.jobs.length === 3 &&
      JSON.stringify(widths) === JSON.stringify([512, 1024, 1600]) &&
      result.jobs.every(
        (job) =>
          job.format === 'png' &&
          job.state === 'succeeded' &&
          job.attemptCount === 1 &&
          job.safeDiagnosticCode === null &&
          typeof job.outputStorageObjectId === 'string',
      ) &&
      new Set(outputIds).size === 3;

    if (!result.passed) {
      throw new Error('positive-derivative-gate-failed');
    }
  } catch (error) {
    result.failure = safeFailure(error);
  } finally {
    if (cookie && tokenId) {
      try {
        const revoked = await call(
          `/client/storage/integration-tokens/${encodeURIComponent(tokenId)}?environment=dev`,
          {
            method: 'DELETE',
            headers: { accept: 'application/json', cookie },
          },
        );
        result.tokenRevoked =
          revoked.response.status === 200 &&
          revoked.body?.result?.status === 'revoked';
      } catch (error) {
        result.failure ??= `token-revocation-failed: ${safeFailure(error)}`;
      }
    }

    if (cookie) {
      await fetch(new URL('/client/session', BASE_URL), {
        method: 'DELETE',
        headers: { cookie },
        redirect: 'follow',
      }).catch(() => undefined);
    }

    if (result.tokenCreated && !result.tokenRevoked) {
      result.passed = false;
      result.failure ??= 'integration-token-not-revoked';
    }

    result.finishedAt = new Date().toISOString();
  }

  return result;
}

export default async function handler(request, response) {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json; charset=utf-8');

  if (request.method !== 'GET') {
    response.statusCode = 405;
    response.end(JSON.stringify({ error: 'method-not-allowed' }));
    return;
  }

  const result = await runSmoke();
  response.statusCode = result.passed ? 200 : 500;
  response.end(JSON.stringify(result));
}
