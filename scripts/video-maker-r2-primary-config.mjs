import { readFile } from 'node:fs/promises';

const BASE_URL = 'https://z-s-app.vercel.app';
const ENVIRONMENT = 'dev';

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

async function json(response) {
  const type = response.headers.get('content-type') ?? '';
  return type.includes('application/json') ? response.json().catch(() => null) : null;
}

async function call(path, init = {}) {
  const response = await fetch(new URL(path, BASE_URL), { redirect: 'follow', ...init });
  return { response, body: await json(response) };
}

const account = parseAccount(await readFile('.test_account', 'utf8'));
const login = await call('/client/session', {
  method: 'POST',
  headers: { accept: 'application/json', 'content-type': 'application/json' },
  body: JSON.stringify({ clientId: account.clientId, clientCredential: account.clientCredential }),
});
if (login.response.status !== 204) throw new Error(`login-${login.response.status}`);
const cookie = cookieFrom(login.response);

try {
  const overview = await call(`/client/storage/configurations?environment=${ENVIRONMENT}`, {
    headers: { accept: 'application/json', cookie },
  });
  if (overview.response.status !== 200) throw new Error(`overview-${overview.response.status}`);
  const activeId = overview.body?.result?.activeVersion?.id;
  if (typeof activeId !== 'string') throw new Error('active-configuration-missing');

  const active = await call(`/client/storage/configurations/${encodeURIComponent(activeId)}?environment=${ENVIRONMENT}`, {
    headers: { accept: 'application/json', cookie },
  });
  if (active.response.status !== 200) throw new Error(`active-${active.response.status}`);
  const version = active.body?.result;
  const connections = new Map((version?.providerConnections ?? []).map((item) => [item.connectionId, item]));
  const vaults = new Map((version?.vaults ?? []).map((item) => [item.vaultId, item]));
  const routes = (version?.routes ?? []).map((route) => ({
    routeId: route.routeId,
    assetClass: route.assetClass,
    imagePresetId: route.imagePresetId ?? null,
    targets: (route.targets ?? []).map((target, order) => {
      const vault = vaults.get(target.vaultId);
      const connection = vault ? connections.get(vault.providerConnectionId) : undefined;
      return {
        order,
        role: target.role,
        vaultId: target.vaultId,
        vaultPurpose: vault?.purpose ?? null,
        retention: vault?.retention ?? null,
        providerConnectionId: vault?.providerConnectionId ?? null,
        providerType: connection?.providerType ?? null,
      };
    }),
  }));

  console.log(JSON.stringify({
    environment: ENVIRONMENT,
    versionId: version?.id ?? null,
    versionNumber: version?.versionNumber ?? null,
    state: version?.state ?? null,
    validationState: version?.validationState ?? null,
    routes,
  }, null, 2));
} finally {
  await fetch(new URL('/client/session', BASE_URL), { method: 'DELETE', headers: { cookie } }).catch(() => undefined);
}
