import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const BASE_URL = 'https://z-s-app.vercel.app';

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

async function payload(response) {
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
  return { response, body: await payload(response) };
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
    environment: service?.environment ?? null,
    providerType: service?.providerType ?? null,
    ownership: service?.ownership ?? null,
    status: service?.status ?? null,
    lastTestStatus: service?.lastTestStatus ?? null,
    lastDiagnosticCode: service?.lastDiagnosticCode ?? null,
    safeMetadataKeys:
      service?.safeMetadata && typeof service.safeMetadata === 'object'
        ? Object.keys(service.safeMetadata).sort()
        : [],
    capabilityKeys:
      service?.capabilities && typeof service.capabilities === 'object'
        ? Object.keys(service.capabilities).sort()
        : [],
  };
}

const result = {
  passed: false,
  readiness: null,
  signedOutBoundary: null,
  loginStatus: null,
  listStatus: null,
  serviceCount: null,
  services: [],
  selectedServiceId: null,
  testStatus: null,
  testResult: null,
  detailStatus: null,
  activityStatus: null,
  activityEventTypes: [],
  publicRedactionHits: [],
  failure: null,
};

let cookie = null;

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

  const services = Array.isArray(list.body?.result) ? list.body.result : [];
  result.serviceCount = services.length;
  result.services = services.map(safeService);
  result.publicRedactionHits.push(...forbiddenHits(list.body));

  const selected = services.find((service) =>
    service?.providerType === 'cloudflare-r2' &&
    service?.ownership === 'client-owned' &&
    service?.status !== 'disabled' &&
    service?.status !== 'archived',
  );

  if (!selected?.serviceId) {
    result.failure = 'no-existing-client-owned-r2-service';
  } else {
    result.selectedServiceId = selected.serviceId;
    const servicePath = `/client/storage/services/${encodeURIComponent(selected.serviceId)}`;

    const tested = await call(`${servicePath}/test?environment=dev`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        cookie,
        origin: BASE_URL,
      },
      body: JSON.stringify({
        testScope: { prefix: `h08-vercel-smoke/${randomUUID()}` },
      }),
    });
    result.testStatus = tested.response.status;
    result.testResult = tested.body?.result ? safeService(tested.body.result) : {
      code: errorCode(tested.body),
    };
    result.publicRedactionHits.push(...forbiddenHits(tested.body));

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
  }

  result.passed =
    result.readiness?.status === 200 &&
    result.signedOutBoundary?.status === 401 &&
    result.signedOutBoundary?.code === 'client-login-required' &&
    result.loginStatus === 204 &&
    result.listStatus === 200 &&
    result.selectedServiceId !== null &&
    result.testStatus === 200 &&
    result.testResult?.status === 'ready' &&
    result.testResult?.lastTestStatus === 'passed' &&
    result.testResult?.lastDiagnosticCode === null &&
    result.detailStatus === 200 &&
    result.activityStatus === 200 &&
    result.activityEventTypes.includes('storage-service-test-passed') &&
    result.publicRedactionHits.length === 0;

  if (!result.passed && result.failure === null) {
    result.failure = 'h08-vercel-smoke-gate-failed';
  }
} catch (error) {
  result.failure = error instanceof Error ? error.message : String(error);
} finally {
  if (cookie) {
    await fetch(new URL('/client/session', BASE_URL), {
      method: 'DELETE',
      headers: { cookie },
    }).catch(() => undefined);
  }
}

console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
