import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const BASE_URL = 'https://z-s-app-git-agent-t2-h09-video-maker-r2-primary-asy-dc3bf5-z-ai.vercel.app';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9h4mZisAAAAASUVORK5CYII=',
  'base64',
);
const CHECKSUM = createHash('sha256').update(PNG).digest('hex');
const TOKEN_ID = `h09-smoke-${randomUUID().slice(0, 8)}`;
const CORRELATION = `h09-${randomUUID().slice(0, 12)}`;

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
  const raw = response.headers.get('set-cookie');
  const cookie = raw?.split(';', 1)[0]?.trim();
  if (!cookie?.startsWith('zs_client_session=')) throw new Error('session-cookie-missing');
  return cookie;
}

async function body(response) {
  const type = response.headers.get('content-type') ?? '';
  return type.toLowerCase().includes('application/json')
    ? response.json().catch(() => null)
    : null;
}

async function call(path, init = {}) {
  const response = await fetch(new URL(path, BASE_URL), { redirect: 'follow', ...init });
  return { response, body: await body(response) };
}

function code(value) {
  return value?.error?.code ?? value?.error?.diagnostic?.code ?? null;
}

function safeTargets(value) {
  return Array.isArray(value)
    ? value.map((target) => ({
        role: target?.role ?? null,
        order: target?.order ?? null,
        state: target?.state ?? null,
        retryable: target?.retryable ?? null,
      }))
    : [];
}

const result = {
  passed: false,
  readiness: null,
  loginStatus: null,
  tokenCreateStatus: null,
  writeIntentStatus: null,
  uploadStatus: null,
  upload: null,
  repairTriggerStatus: null,
  repair: null,
  tokenRevokeStatus: null,
  failure: null,
};

let cookie = null;
let bearer = null;
try {
  const ready = await call('/readyz', { headers: { accept: 'application/json' } });
  result.readiness = {
    status: ready.response.status,
    overall: ready.body?.status ?? null,
    controlPlane: ready.body?.controlPlane?.status ?? null,
    dataPlane: ready.body?.dataPlane?.status ?? null,
  };
  if (ready.response.status !== 200 || ready.body?.status !== 'ready') {
    throw new Error(`readiness-${ready.response.status}-${ready.body?.status ?? 'unknown'}`);
  }

  const account = parseAccount(await readFile('.test_account', 'utf8'));
  const login = await call('/client/session', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: account.clientId, clientCredential: account.clientCredential }),
  });
  result.loginStatus = login.response.status;
  if (login.response.status !== 204) throw new Error(`login-${login.response.status}-${code(login.body) ?? 'unknown'}`);
  cookie = cookieFrom(login.response);

  const created = await call('/client/storage/integration-tokens', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      cookie,
      origin: BASE_URL,
    },
    body: JSON.stringify({
      environment: 'dev',
      tokenId: TOKEN_ID,
      displayLabel: 'H09 Vercel disposable runtime smoke',
      scopes: ['object:write', 'object:manage'],
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    }),
  });
  result.tokenCreateStatus = created.response.status;
  bearer = created.body?.result?.token ?? null;
  if (created.response.status !== 201 || typeof bearer !== 'string' || bearer.length < 20) {
    throw new Error(`token-create-${created.response.status}-${code(created.body) ?? 'missing-bearer'}`);
  }

  const intent = await call('/v1/object-write-intents', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'x-zs-contract-version': '1.0',
      'x-zs-caller-app': 'video-maker_app',
      'idempotency-key': `${CORRELATION}-intent`,
      'x-app-correlation-reference': CORRELATION,
    },
    body: JSON.stringify({
      storageProfile: {
        profileId: 'video-maker-dev-default',
        profileVersion: 1,
        environment: 'dev',
      },
      mediaType: 'image/png',
      byteLength: PNG.byteLength,
      checksumSha256: CHECKSUM,
      sourceReference: CORRELATION,
    }),
  });
  result.writeIntentStatus = intent.response.status;
  const writeIntentId = intent.body?.result?.writeIntentId;
  const uploadToken = intent.body?.result?.uploadCompletionToken;
  if (intent.response.status !== 200 || typeof writeIntentId !== 'string' || typeof uploadToken !== 'string') {
    throw new Error(`intent-${intent.response.status}-${code(intent.body) ?? 'invalid-result'}`);
  }

  const uploaded = await call(`/v1/object-write-intents/${encodeURIComponent(writeIntentId)}/content`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: 'application/json',
      'content-type': 'image/png',
      'content-length': String(PNG.byteLength),
      'x-content-sha256': CHECKSUM,
      'x-zs-contract-version': '1.0',
      'x-zs-caller-app': 'video-maker_app',
      'x-zs-upload-completion-token': uploadToken,
      'idempotency-key': `${CORRELATION}-upload`,
      'x-app-correlation-reference': CORRELATION,
    },
    body: PNG,
  });
  result.uploadStatus = uploaded.response.status;
  const uploadResult = uploaded.body?.result;
  result.upload = uploadResult && typeof uploadResult === 'object'
    ? {
        state: uploadResult.state ?? null,
        storageState: uploadResult.storageState ?? null,
        objectProtectionStage: uploadResult.objectProtectionStage ?? null,
        checksumMatch: uploadResult.checksumSha256 === CHECKSUM,
        byteLengthMatch: uploadResult.byteLength === PNG.byteLength,
        targetCopies: safeTargets(uploadResult.targetCopies),
      }
    : null;
  const primary = result.upload?.targetCopies.find((target) => target.role === 'primary');
  const replicas = result.upload?.targetCopies.filter((target) => target.role === 'replica') ?? [];
  if (
    uploaded.response.status !== 200 ||
    result.upload?.state !== 'recorded' ||
    result.upload?.storageState !== 'degraded' ||
    result.upload?.objectProtectionStage !== 'configuration-replica-repair-required' ||
    result.upload?.checksumMatch !== true ||
    result.upload?.byteLengthMatch !== true ||
    primary?.state !== 'verified' ||
    replicas.length < 1 ||
    replicas.some((replica) => replica.state === 'verified')
  ) {
    throw new Error(`upload-gate-${uploaded.response.status}-${code(uploaded.body) ?? 'authority-mismatch'}`);
  }

  const repair = await call('/v1/storage-protection/run', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ mode: 'repair' }),
  });
  result.repairTriggerStatus = repair.response.status;
  result.repair = repair.body?.result?.repair ?? null;
  if (repair.response.status !== 200) {
    throw new Error(`repair-trigger-${repair.response.status}-${code(repair.body) ?? 'unknown'}`);
  }

  result.passed = true;
} catch (error) {
  result.failure = error instanceof Error ? error.message : String(error);
} finally {
  if (cookie) {
    const revoked = await call(`/client/storage/integration-tokens/${encodeURIComponent(TOKEN_ID)}?environment=dev`, {
      method: 'DELETE',
      headers: { accept: 'application/json', cookie, origin: BASE_URL },
    }).catch(() => null);
    result.tokenRevokeStatus = revoked?.response?.status ?? null;
    await fetch(new URL('/client/session', BASE_URL), { method: 'DELETE', headers: { cookie } }).catch(() => undefined);
  }
  bearer = null;
  cookie = null;
}

if (result.tokenCreateStatus === 201 && result.tokenRevokeStatus !== 200) {
  result.passed = false;
  result.failure ??= 'token-cleanup-failed';
}
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
