const BASE_URL = 'https://z-s-app.vercel.app';
const ACCOUNT_URL = 'https://raw.githubusercontent.com/ZimmonAI/z-s_app/main/.test_account';

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
  const value = raw?.split(';', 1)[0]?.trim();
  if (!value?.startsWith('zs_client_session=')) throw new Error('session-cookie-missing');
  return value;
}

async function readJson(response) {
  const type = response.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('application/json')) return null;
  return response.json().catch(() => null);
}

async function call(path, init = {}) {
  const response = await fetch(new URL(path, BASE_URL), { redirect: 'follow', ...init });
  return { response, body: await readJson(response) };
}

function forbiddenKeyHits(value) {
  const forbidden = new Set([
    'credential', 'credentials', 'secret', 'token', 'password', 'endpoint',
    'bucket', 'object_key', 'objectKey', 'access_key', 'accessKeyId',
    'secret_key', 'secretAccessKey', 'private_key', 'connection_string',
    'signed_url', 'signedUrl', 'secret_reference', 'secretReferenceId',
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

export default async function handler(request, response) {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json; charset=utf-8');
  if (request.method !== 'GET') {
    response.statusCode = 405;
    response.end(JSON.stringify({ error: 'method-not-allowed' }));
    return;
  }

  const result = {
    passed: false,
    readiness: null,
    signedOut: null,
    loginStatus: null,
    listStatus: null,
    serviceCount: null,
    services: [],
    forbiddenPublicKeyHits: [],
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

    const signedOut = await call('/client/storage/services?environment=dev&providerType=cloudflare-r2', {
      headers: { accept: 'application/json' },
    });
    result.signedOut = {
      status: signedOut.response.status,
      code: signedOut.body?.error?.code ?? null,
    };

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
      throw new Error(`client-login-${login.response.status}`);
    }
    cookie = cookieFrom(login.response);

    const list = await call('/client/storage/services?environment=dev&providerType=cloudflare-r2', {
      headers: { accept: 'application/json', cookie },
    });
    result.listStatus = list.response.status;
    if (list.response.status !== 200) {
      result.failure = list.body?.error?.code ?? `service-list-${list.response.status}`;
      response.statusCode = 200;
      response.end(JSON.stringify(result));
      return;
    }

    const services = Array.isArray(list.body?.result) ? list.body.result : [];
    result.serviceCount = services.length;
    result.services = services.map((service) => ({
      serviceId: service?.serviceId ?? null,
      environment: service?.environment ?? null,
      providerType: service?.providerType ?? null,
      ownership: service?.ownership ?? null,
      status: service?.status ?? null,
      lastTestStatus: service?.lastTestStatus ?? null,
      lastDiagnosticCode: service?.lastDiagnosticCode ?? null,
      capabilityKeys: service?.capabilities && typeof service.capabilities === 'object'
        ? Object.keys(service.capabilities).sort()
        : [],
      safeMetadataKeys: service?.safeMetadata && typeof service.safeMetadata === 'object'
        ? Object.keys(service.safeMetadata).sort()
        : [],
    }));
    result.forbiddenPublicKeyHits = forbiddenKeyHits(list.body);
    result.passed =
      ready.response.status === 200 &&
      result.signedOut.status === 401 &&
      result.signedOut.code === 'client-login-required' &&
      result.loginStatus === 204 &&
      result.listStatus === 200 &&
      result.forbiddenPublicKeyHits.length === 0;
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

  response.statusCode = result.passed ? 200 : 500;
  response.end(JSON.stringify(result));
}
