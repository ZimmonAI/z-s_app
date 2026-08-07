import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const BASE_URL = 'https://z-s-app.vercel.app';
const TEST_PREFIX = 'h08-vercel-negative-';

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

async function responseBody(response) {
  const type = response.headers.get('content-type') ?? '';
  return type.toLowerCase().includes('application/json')
    ? response.json().catch(() => null)
    : null;
}

async function call(path, init = {}) {
  const response = await fetch(new URL(path, BASE_URL), {
    redirect: 'follow',
    ...init,
  });
  return { response, body: await responseBody(response) };
}

function errorCode(body) {
  return body?.error?.code ?? body?.error?.diagnostic?.code ?? null;
}

function forbiddenHits(value) {
  const forbidden = new Set([
    'credential', 'credentials', 'secret', 'token', 'password', 'endpoint',
    'bucket', 'object_key', 'objectKey', 'access_key', 'accessKeyId',
    'secret_key', 'secretAccessKey', 'private_key', 'connection_string',
    'signed_url', 'signedUrl', 'secret_reference', 'secretReferenceId',
    'managed_secret_reference_id', 'active_provider_secret_id',
    'ciphertext', 'nonce', 'authenticationTag', 'authentication_tag',
    'keyVersion', 'key_version',
  ]);
  const hits = [];
  function visit(item, path = '$') {
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (forbidden.has(key)) hits.push(`${path}.${key}`);
      visit(child, `${path}.${key}`);
    }
  }
  visit(value);
  return hits;
}

function safeService(service) {
  return {
    serviceId: service?.serviceId ?? null,
    providerType: service?.providerType ?? null,
    ownership: service?.ownership ?? null,
    status: service?.status ?? null,
    lastTestStatus: service?.lastTestStatus ?? null,
    lastDiagnosticCode: service?.lastDiagnosticCode ?? null,
  };
}

async function archive(cookie, serviceId) {
  return call(
    `/client/storage/services/${encodeURIComponent(serviceId)}/archive?environment=dev`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        cookie,
        origin: BASE_URL,
      },
      body: JSON.stringify({}),
    },
  );
}

const result = {
  passed: false,
  readiness: null,
  signedOutBoundary: null,
  loginStatus: null,
  listStatus: null,
  priorDisposableServices: [],
  priorCleanup: [],
  createStatus: null,
  createdService: null,
  detailStatus: null,
  activityStatus: null,
  activityEventTypes: [],
  archiveStatus: null,
  archivedServiceStatus: null,
  publicRedactionHits: [],
  failure: null,
};

let cookie = null;
let disposableServiceId = null;

try {
  const ready = await call('/readyz', { headers: { accept: 'application/json' } });
  result.readiness = {
    status: ready.response.status,
    overall: ready.body?.status ?? null,
    controlPlane: ready.body?.controlPlane?.status ?? null,
    dataPlane: ready.body?.dataPlane?.status ?? null,
  };

  const signedOut = await call(
    '/client/storage/services?environment=dev&providerType=cloudflare-r2',
    { headers: { accept: 'application/json' } },
  );
  result.signedOutBoundary = {
    status: signedOut.response.status,
    code: errorCode(signedOut.body),
  };

  const account = parseAccount(await readFile('.test_account', 'utf8'));
  const login = await call('/client/session', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: account.clientId,
      clientCredential: account.clientCredential,
    }),
  });
  result.loginStatus = login.response.status;
  if (login.response.status !== 204) throw new Error(`login-${login.response.status}`);
  cookie = cookieFrom(login.response);

  const list = await call(
    '/client/storage/services?environment=dev&providerType=cloudflare-r2',
    { headers: { accept: 'application/json', cookie } },
  );
  result.listStatus = list.response.status;
  if (list.response.status !== 200) {
    throw new Error(`service-list-${list.response.status}-${errorCode(list.body) ?? 'unknown'}`);
  }
  result.publicRedactionHits.push(...forbiddenHits(list.body));

  const services = Array.isArray(list.body?.result) ? list.body.result : [];
  const prior = services.filter((service) =>
    typeof service?.serviceId === 'string' &&
    service.serviceId.startsWith(TEST_PREFIX) &&
    service.status !== 'archived',
  );
  result.priorDisposableServices = prior.map((service) => service.serviceId);

  for (const service of prior) {
    const cleanup = await archive(cookie, service.serviceId);
    result.publicRedactionHits.push(...forbiddenHits(cleanup.body));
    result.priorCleanup.push({
      serviceId: service.serviceId,
      status: cleanup.response.status,
      serviceStatus: cleanup.body?.result?.status ?? null,
      code: errorCode(cleanup.body),
    });
    if (cleanup.response.status !== 200 || cleanup.body?.result?.status !== 'archived') {
      throw new Error(`prior-cleanup-${service.serviceId}-${cleanup.response.status}-${errorCode(cleanup.body) ?? 'unknown'}`);
    }
  }

  disposableServiceId = `${TEST_PREFIX}${randomUUID().slice(0, 8)}`;
  const created = await call('/client/storage/services', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      cookie,
      origin: BASE_URL,
    },
    body: JSON.stringify({
      serviceId: disposableServiceId,
      environment: 'dev',
      displayName: 'H08 Vercel negative-path probe',
      providerType: 'cloudflare-r2',
      safeMetadata: { accountLabel: 'H08 Vercel negative probe' },
      secretInput: {
        accountId: '00000000000000000000000000000000',
        accessKeyId: 'H08INVALIDACCESSKEY12345',
        secretAccessKey: 'h08-intentionally-invalid-secret-access-key',
        bucket: 'video-maker-hot',
      },
      testScope: { prefix: `h08-vercel-negative/${randomUUID()}` },
    }),
  });
  result.createStatus = created.response.status;
  result.createdService = safeService(created.body?.result);
  result.publicRedactionHits.push(...forbiddenHits(created.body));
  if (created.response.status !== 201) {
    throw new Error(`service-create-${created.response.status}-${errorCode(created.body) ?? 'unknown'}`);
  }

  const servicePath = `/client/storage/services/${encodeURIComponent(disposableServiceId)}`;
  const detail = await call(`${servicePath}?environment=dev`, {
    headers: { accept: 'application/json', cookie },
  });
  result.detailStatus = detail.response.status;
  result.publicRedactionHits.push(...forbiddenHits(detail.body));

  const activity = await call(`${servicePath}/activity?environment=dev`, {
    headers: { accept: 'application/json', cookie },
  });
  result.activityStatus = activity.response.status;
  result.publicRedactionHits.push(...forbiddenHits(activity.body));
  const events = Array.isArray(activity.body?.result) ? activity.body.result : [];
  result.activityEventTypes = events
    .map((event) => event?.eventType)
    .filter((value) => typeof value === 'string')
    .slice(0, 20);

  const archived = await archive(cookie, disposableServiceId);
  result.archiveStatus = archived.response.status;
  result.archivedServiceStatus = archived.body?.result?.status ?? null;
  result.publicRedactionHits.push(...forbiddenHits(archived.body));

  result.passed =
    result.readiness?.status === 200 &&
    result.readiness?.overall === 'ready' &&
    result.signedOutBoundary?.status === 401 &&
    result.signedOutBoundary?.code === 'client-login-required' &&
    result.loginStatus === 204 &&
    result.listStatus === 200 &&
    result.priorCleanup.every((item) => item.status === 200 && item.serviceStatus === 'archived') &&
    result.createStatus === 201 &&
    result.createdService?.providerType === 'cloudflare-r2' &&
    result.createdService?.ownership === 'client-owned' &&
    result.createdService?.status === 'failed' &&
    result.createdService?.lastTestStatus === 'failed' &&
    typeof result.createdService?.lastDiagnosticCode === 'string' &&
    result.createdService.lastDiagnosticCode.startsWith('r2-') &&
    result.detailStatus === 200 &&
    result.activityStatus === 200 &&
    result.activityEventTypes.includes('storage-service-created') &&
    result.activityEventTypes.includes('storage-service-test-failed') &&
    result.archiveStatus === 200 &&
    result.archivedServiceStatus === 'archived' &&
    result.publicRedactionHits.length === 0;

  if (!result.passed) result.failure = 'h08-vercel-negative-lifecycle-gate-failed';
} catch (error) {
  result.failure = error instanceof Error ? error.message : String(error);
} finally {
  if (cookie && disposableServiceId && result.archivedServiceStatus !== 'archived') {
    await archive(cookie, disposableServiceId).catch(() => undefined);
  }
  if (cookie) {
    await fetch(new URL('/client/session', BASE_URL), {
      method: 'DELETE',
      headers: { cookie },
    }).catch(() => undefined);
  }
}

console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
