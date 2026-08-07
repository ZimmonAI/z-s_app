import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const config = { maxDuration: 300 };

const BASE_URL = 'https://z-s-app.vercel.app';
const ACCOUNT_URL = 'https://raw.githubusercontent.com/ZimmonAI/z-s_app/main/.test_account';

function code(body) {
  const error = body?.error;
  return typeof error?.code === 'string'
    ? error.code
    : typeof error?.diagnostic?.code === 'string'
      ? error.diagnostic.code
      : null;
}

function category(body) {
  const error = body?.error;
  return typeof error?.category === 'string'
    ? error.category
    : typeof error?.diagnostic?.category === 'string'
      ? error.diagnostic.category
      : null;
}

function safeFailure(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/zs_client_session=[^;\s]+/gi, 'zs_client_session=[redacted]')
    .slice(0, 400);
}

async function call(path, init = {}) {
  const response = await fetch(new URL(path, BASE_URL), {
    redirect: 'follow',
    ...init,
  });
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.toLowerCase().includes('application/json')
    ? await response.json().catch(() => null)
    : null;
  return { response, body };
}

function parseAccount(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) values.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  const clientId = values.get('Z_S_TEST_USER_ACCOUNT');
  const clientCredential = values.get('Z_S_TEST_USER_PASSWORD');
  if (!clientId || !clientCredential) throw new Error('test-account-invalid');
  return { clientId, clientCredential };
}

function cookieFrom(response) {
  const value = response.headers.get('set-cookie')?.split(';', 1)[0]?.trim();
  if (!value?.startsWith('zs_client_session=')) throw new Error('session-cookie-missing');
  return value;
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

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function png(width = 1600, height = 900) {
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
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      raw[offset] = Math.floor((x * 255) / Math.max(1, width - 1));
      raw[offset + 1] = Math.floor((y * 255) / Math.max(1, height - 1));
      raw[offset + 2] = Math.floor(((x + y) * 255) / Math.max(1, width + height - 2));
    }
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function safeJobs(items) {
  return items.map((item) => ({
    jobId: item.jobId ?? null,
    sourceStorageObjectId: item.sourceStorageObjectId ?? null,
    outputStorageObjectId: item.outputStorageObjectId ?? null,
    presetId: item.presetId ?? null,
    width: item.width ?? null,
    format: item.format ?? null,
    state: item.state ?? null,
    attemptCount: item.attemptCount ?? null,
    safeDiagnosticCode: item.safeDiagnosticCode ?? null,
  })).sort((a, b) => Number(a.width) - Number(b.width));
}

async function run() {
  const result = {
    passed: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    readiness: null,
    loginStatus: null,
    tokenCreated: false,
    tokenRevoked: false,
    intent: null,
    upload: null,
    sourceStorageObjectId: null,
    poll: null,
    jobs: [],
    failure: null,
  };

  let cookie = null;
  let tokenId = null;

  try {
    const ready = await call('/readyz', { headers: { accept: 'application/json' } });
    result.readiness = {
      status: ready.response.status,
      overall: ready.body?.status ?? null,
      controlPlane: ready.body?.controlPlane?.status ?? null,
      dataPlane: ready.body?.dataPlane?.status ?? null,
    };
    if (ready.response.status !== 200) throw new Error('readiness-failed');

    const accountResponse = await fetch(ACCOUNT_URL, { redirect: 'follow' });
    if (!accountResponse.ok) throw new Error('test-account-fetch-failed');
    const account = parseAccount(await accountResponse.text());

    const login = await call('/client/session', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: account.clientId,
        clientCredential: account.clientCredential,
      }),
    });
    result.loginStatus = login.response.status;
    if (login.response.status !== 204) {
      throw new Error(`login: ${login.response.status} ${code(login.body) ?? 'unexpected'}`);
    }
    cookie = cookieFrom(login.response);

    tokenId = `h06-vercel-final-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
    const tokenResponse = await call('/client/storage/integration-tokens', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        environment: 'dev',
        tokenId,
        displayLabel: 'H06 Vercel final PNG derivative verification',
        scopes: ['object:write', 'object:read', 'object:manage'],
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
    });
    if (tokenResponse.response.status !== 201) {
      throw new Error(`token-create: ${tokenResponse.response.status} ${code(tokenResponse.body) ?? 'unexpected'}`);
    }
    const runtimeToken = tokenResponse.body?.result?.token;
    if (typeof runtimeToken !== 'string') throw new Error('token-reveal-missing');
    result.tokenCreated = true;

    const bytes = png();
    const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
    const correlation = `h06-vercel-final-${randomUUID()}`;

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
        sourceReference: `h06-vercel-final-fresh-${randomUUID()}`,
      }),
    });

    result.intent = {
      status: intentResponse.response.status,
      code: code(intentResponse.body),
      category: category(intentResponse.body),
      topLevelKeys: intentResponse.body && typeof intentResponse.body === 'object'
        ? Object.keys(intentResponse.body).sort()
        : [],
      resultKeys: intentResponse.body?.result && typeof intentResponse.body.result === 'object'
        ? Object.keys(intentResponse.body.result).sort()
        : [],
    };

    if (![200, 201].includes(intentResponse.response.status)) {
      throw new Error(`intent-create: ${intentResponse.response.status} ${code(intentResponse.body) ?? 'unexpected'}`);
    }

    const intent = intentResponse.body?.result;
    const writeIntentId = intent?.writeIntentId;
    const storageObjectId = intent?.storageObjectId;
    const completionToken = intent?.uploadCompletionToken;
    if (
      typeof writeIntentId !== 'string' ||
      typeof storageObjectId !== 'string' ||
      typeof completionToken !== 'string'
    ) {
      throw new Error('intent-result-invalid');
    }
    result.sourceStorageObjectId = storageObjectId;

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

    result.upload = {
      status: uploadResponse.response.status,
      code: code(uploadResponse.body),
      category: category(uploadResponse.body),
      state: uploadResponse.body?.result?.state ?? null,
      storageState: uploadResponse.body?.result?.storageState ?? null,
    };

    if (uploadResponse.response.status !== 200) {
      throw new Error(`upload: ${uploadResponse.response.status} ${code(uploadResponse.body) ?? 'unexpected'}`);
    }

    let matching = [];
    let lastPoll = null;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const status = await call('/client/storage/image-derivatives?environment=dev', {
        headers: { accept: 'application/json', cookie },
      });
      lastPoll = {
        status: status.response.status,
        code: code(status.body),
        category: category(status.body),
      };

      if (status.response.status === 200) {
        const items = Array.isArray(status.body?.result) ? status.body.result : [];
        matching = items.filter((item) => item?.sourceStorageObjectId === storageObjectId);
        if (matching.length === 3 && matching.every((item) => ['succeeded', 'failed'].includes(item.state))) {
          break;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    result.poll = lastPoll;
    result.jobs = safeJobs(matching);

    const widths = result.jobs.map((job) => job.width);
    result.passed =
      result.upload.state === 'recorded' &&
      result.upload.storageState === 'ready' &&
      result.jobs.length === 3 &&
      JSON.stringify(widths) === JSON.stringify([512, 1024, 1600]) &&
      result.jobs.every((job) =>
        job.format === 'png' &&
        job.state === 'succeeded' &&
        job.attemptCount === 1 &&
        job.safeDiagnosticCode === null &&
        typeof job.outputStorageObjectId === 'string'
      );

    if (!result.passed) throw new Error('positive-derivative-gate-failed');
  } catch (error) {
    result.failure = safeFailure(error);
  } finally {
    if (cookie && tokenId) {
      const revoked = await call(
        `/client/storage/integration-tokens/${encodeURIComponent(tokenId)}?environment=dev`,
        { method: 'DELETE', headers: { accept: 'application/json', cookie } },
      ).catch(() => null);
      result.tokenRevoked =
        revoked?.response?.status === 200 &&
        revoked?.body?.result?.status === 'revoked';
    }

    if (cookie) {
      await fetch(new URL('/client/session', BASE_URL), {
        method: 'DELETE',
        headers: { cookie },
      }).catch(() => undefined);
    }

    if (result.tokenCreated && !result.tokenRevoked) {
      result.passed = false;
      result.failure ??= 'token-not-revoked';
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
  const result = await run();
  response.statusCode = result.passed ? 200 : 500;
  response.end(JSON.stringify(result));
}
