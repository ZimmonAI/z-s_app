import { readFile } from 'node:fs/promises';

const BASE_URL = 'https://z-s-app.vercel.app';
const ENVIRONMENT = 'dev';
const EXPECTED_ASSET_CLASSES = ['document', 'image', 'video'];

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

function errorCode(body) {
  return body?.error?.code ?? body?.error?.diagnostic?.code ?? null;
}

function routeSnapshot(version) {
  const connections = new Map((version?.providerConnections ?? []).map((item) => [item.connectionId, item]));
  const vaults = new Map((version?.vaults ?? []).map((item) => [item.vaultId, item]));
  return (version?.routes ?? []).map((route) => ({
    routeId: route.routeId,
    assetClass: route.assetClass,
    targets: (route.targets ?? []).map((target, order) => {
      const vault = vaults.get(target.vaultId);
      const connection = vault ? connections.get(vault.providerConnectionId) : undefined;
      return {
        order,
        role: target.role,
        vaultId: target.vaultId,
        providerConnectionId: vault?.providerConnectionId ?? null,
        providerType: connection?.providerType ?? null,
        retention: vault?.retention ?? null,
      };
    }),
  }));
}

function assertExpectedBefore(version) {
  const routes = routeSnapshot(version);
  const classes = routes.map((route) => route.assetClass).sort();
  if (JSON.stringify(classes) !== JSON.stringify(EXPECTED_ASSET_CLASSES)) {
    throw new Error(`unexpected-asset-classes:${classes.join(',')}`);
  }
  for (const route of routes) {
    if (route.targets.length !== 2) throw new Error(`unexpected-target-count:${route.assetClass}`);
    const [primary, replica] = route.targets;
    if (
      primary?.order !== 0 || primary.role !== 'primary' || primary.providerType !== 'minio' ||
      replica?.order !== 1 || replica.role !== 'replica' || replica.providerType !== 'r2'
    ) {
      throw new Error(`unexpected-route-authority:${route.assetClass}`);
    }
  }
  return routes;
}

function flippedRoutes(version) {
  const connections = new Map((version.providerConnections ?? []).map((item) => [item.connectionId, item]));
  const vaults = new Map((version.vaults ?? []).map((item) => [item.vaultId, item]));
  return version.routes.map((route) => {
    const enriched = route.targets.map((target) => {
      const vault = vaults.get(target.vaultId);
      const connection = vault ? connections.get(vault.providerConnectionId) : undefined;
      return { target, providerType: connection?.providerType };
    });
    const r2 = enriched.find((item) => item.providerType === 'r2')?.target;
    const minio = enriched.find((item) => item.providerType === 'minio')?.target;
    if (!r2 || !minio || enriched.length !== 2) throw new Error(`route-flip-unavailable:${route.assetClass}`);
    return {
      routeId: route.routeId,
      assetClass: route.assetClass,
      targets: [
        { role: 'primary', vaultId: r2.vaultId },
        { role: 'replica', vaultId: minio.vaultId },
      ],
      ...(route.imagePresetId ? { imagePresetId: route.imagePresetId } : {}),
    };
  });
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
  const activeVersion = active.body?.result;
  const before = assertExpectedBefore(activeVersion);

  const cloned = await call(`/client/storage/configurations/${encodeURIComponent(activeId)}/clone?environment=${ENVIRONMENT}`, {
    method: 'POST',
    headers: { accept: 'application/json', cookie, origin: BASE_URL },
  });
  if (cloned.response.status !== 201 && cloned.response.status !== 200) {
    throw new Error(`clone-${cloned.response.status}-${errorCode(cloned.body) ?? 'unknown'}`);
  }
  const draft = cloned.body?.result;
  if (typeof draft?.id !== 'string' || draft.state !== 'draft') throw new Error('clone-result-invalid');

  const saved = await call(`/client/storage/configurations/${encodeURIComponent(draft.id)}?environment=${ENVIRONMENT}`, {
    method: 'PUT',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      cookie,
      origin: BASE_URL,
    },
    body: JSON.stringify({
      providerConnections: draft.providerConnections,
      vaults: draft.vaults,
      routes: flippedRoutes(draft),
      imagePresets: draft.imagePresets,
    }),
  });
  if (saved.response.status !== 200) {
    throw new Error(`save-${saved.response.status}-${errorCode(saved.body) ?? 'unknown'}`);
  }
  const savedDraft = saved.body?.result;
  if (savedDraft?.validationState !== 'valid') {
    throw new Error(`draft-invalid:${JSON.stringify(savedDraft?.validationErrors ?? [])}`);
  }

  const activated = await call(`/client/storage/configurations/${encodeURIComponent(draft.id)}/activate?environment=${ENVIRONMENT}`, {
    method: 'POST',
    headers: { accept: 'application/json', cookie, origin: BASE_URL },
  });
  if (activated.response.status !== 200) {
    throw new Error(`activate-${activated.response.status}-${errorCode(activated.body) ?? 'unknown'}`);
  }

  const afterOverview = await call(`/client/storage/configurations?environment=${ENVIRONMENT}`, {
    headers: { accept: 'application/json', cookie },
  });
  const afterId = afterOverview.body?.result?.activeVersion?.id;
  if (typeof afterId !== 'string') throw new Error('post-activation-active-missing');
  const afterResponse = await call(`/client/storage/configurations/${encodeURIComponent(afterId)}?environment=${ENVIRONMENT}`, {
    headers: { accept: 'application/json', cookie },
  });
  if (afterResponse.response.status !== 200) throw new Error(`post-active-${afterResponse.response.status}`);
  const afterVersion = afterResponse.body?.result;
  const after = routeSnapshot(afterVersion);

  for (const route of after) {
    const [primary, replica] = route.targets;
    if (
      primary?.order !== 0 || primary.role !== 'primary' || primary.providerType !== 'r2' ||
      replica?.order !== 1 || replica.role !== 'replica' || replica.providerType !== 'minio'
    ) {
      throw new Error(`post-activation-route-invalid:${route.assetClass}`);
    }
  }

  console.log(JSON.stringify({
    changed: true,
    environment: ENVIRONMENT,
    previousVersionNumber: activeVersion.versionNumber,
    activeVersionNumber: afterVersion.versionNumber,
    previousRoutes: before,
    activeRoutes: after,
  }, null, 2));
} finally {
  await fetch(new URL('/client/session', BASE_URL), { method: 'DELETE', headers: { cookie } }).catch(() => undefined);
}
