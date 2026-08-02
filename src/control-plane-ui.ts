import type { ClientCredentialAuthenticator } from './client-control-auth.js';
import { createUnavailableClientCredentialAuthenticator } from './client-control-auth.js';
import {
  clientConfigurationVersionPage,
  clientLoginPage,
  clientStorageConfigurationPage,
  clientStoragePage,
  type ClientAccountView,
} from './client-control-pages.js';
import {
  ClientStorageConfigurationError,
  createUnavailableClientStorageConfigurationStore,
  type ClientStorageConfigurationStore,
} from './client-storage-configuration.js';
import {
  clientStorageEnvironmentFromUrl,
  configurationDocumentFromPayload,
  createConfigurationDraftFromPayload,
  integrationTokenInputFromPayload,
} from './client-storage-control-request.js';
import { createControlLoginAttemptLimiter } from './control-plane-ui-abuse.js';
import {
  ControlPlaneUiError,
  readClientCredential,
  readControlJsonPayload,
  readPassword,
  readPlanPayload,
  wantsJson,
} from './control-plane-ui-request.js';
import {
  issueSignedSession,
  readSignedSessionClaims,
  safeEquals,
  sessionCookie,
  validSignedSession,
} from './control-plane-session.js';
import type { HttpStorageRuntime } from './runtime-contract.js';
import { storageControlFormErrorCode } from './storage-control-form.js';
import { buildStorageControlPlan, storageControlPlanErrorCode } from './storage-control-plan.js';
import { loginPage, storagePlannerPage, storagePlanResultPage } from './storage-control-pages.js';

const SESSION_COOKIE = 'zs_control_session';
const SESSION_SUBJECT = 'z-s-control';
const CLIENT_SESSION_COOKIE = 'zs_client_session';
const CLIENT_SESSION_SUBJECT_PREFIX = 'z-s-client:';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

export interface ControlPlaneUiOptions {
  readonly adminPassword?: string;
  readonly sessionSigningKey?: string;
  readonly clientCredentialAuthenticator?: ClientCredentialAuthenticator;
  readonly clientStorageConfigurationStore?: ClientStorageConfigurationStore;
  readonly now?: () => Date;
}

function operatorConfigured(options: Readonly<ControlPlaneUiOptions>): boolean {
  return options.adminPassword !== undefined && options.sessionSigningKey !== undefined;
}

function clientConfigured(
  options: Readonly<ControlPlaneUiOptions>,
  authenticator: ClientCredentialAuthenticator,
): boolean {
  return authenticator.configured && options.sessionSigningKey !== undefined;
}

function html(body: string, status = 200, headers?: HeadersInit): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...(headers ?? {}),
    },
  });
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(headers ?? {}),
    },
  });
}

function redirect(location: string, headers?: HeadersInit): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      'cache-control': 'no-store',
      ...(headers ?? {}),
    },
  });
}

function loginAttemptKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded !== undefined && forwarded !== '') return forwarded;
  const direct = request.headers.get('x-real-ip')?.trim();
  return direct === undefined || direct === '' ? 'unknown-client' : direct;
}

function operatorAuthenticated(
  request: Request,
  options: Readonly<ControlPlaneUiOptions>,
  now: Date,
): boolean {
  if (!operatorConfigured(options)) return false;
  return validSignedSession(request, {
    cookieName: SESSION_COOKIE,
    subject: SESSION_SUBJECT,
    ttlSeconds: SESSION_TTL_SECONDS,
    signingKey: options.sessionSigningKey ?? '',
  }, now);
}

function clientSessionAccount(
  request: Request,
  options: Readonly<ControlPlaneUiOptions>,
  now: Date,
  labels: ReadonlyMap<string, string>,
): Readonly<ClientAccountView> | null {
  if (options.sessionSigningKey === undefined) return null;
  const claims = readSignedSessionClaims(request, {
    cookieName: CLIENT_SESSION_COOKIE,
    signingKey: options.sessionSigningKey,
  }, now);
  if (claims === null || !claims.subject.startsWith(CLIENT_SESSION_SUBJECT_PREFIX)) return null;
  const clientId = claims.subject.slice(CLIENT_SESSION_SUBJECT_PREFIX.length);
  if (!CLIENT_ID_PATTERN.test(clientId)) return null;
  return Object.freeze({
    clientId,
    displayLabel: labels.get(clientId) ?? clientId,
  });
}

function clientApiAccount(
  request: Request,
  options: Readonly<ControlPlaneUiOptions>,
  now: Date,
  labels: ReadonlyMap<string, string>,
): Readonly<ClientAccountView> {
  const account = clientSessionAccount(request, options, now, labels);
  if (account === null) throw new ControlPlaneUiError(401, 'client-login-required');
  return account;
}

function decodedPathValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ControlPlaneUiError(400, 'invalid-path-identifier');
  }
}

function acceptsHtml(request: Request): boolean {
  return (request.headers.get('accept') ?? '').toLowerCase().includes('text/html');
}

export function createControlPlaneUiRuntime(
  storageRuntime: HttpStorageRuntime,
  options: ControlPlaneUiOptions = {},
): HttpStorageRuntime {
  const now = options.now ?? (() => new Date());
  const clientAuthenticator =
    options.clientCredentialAuthenticator ?? createUnavailableClientCredentialAuthenticator();
  const configurationStore =
    options.clientStorageConfigurationStore ?? createUnavailableClientStorageConfigurationStore();
  const operatorLoginLimiter = createControlLoginAttemptLimiter();
  const clientLoginLimiter = createControlLoginAttemptLimiter('client-login-rate-limited');
  const clientLabels = new Map<string, string>();

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const snapshot = now();
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        return redirect(operatorAuthenticated(request, options, snapshot) ? '/admin/storage' : '/login');
      }
      if (request.method === 'GET' && url.pathname === '/login') {
        return html(loginPage(operatorConfigured(options)));
      }
      if (request.method === 'GET' && url.pathname === '/favicon.ico') {
        return new Response(null, {
          status: 204,
          headers: { 'cache-control': 'public, max-age=86400' },
        });
      }
      if (request.method === 'POST' && url.pathname === '/admin/session') {
        if (!operatorConfigured(options)) {
          throw new ControlPlaneUiError(503, 'control-login-not-configured');
        }
        const attemptKey = loginAttemptKey(request);
        operatorLoginLimiter.assertAllowed(attemptKey, snapshot);
        const password = await readPassword(request);
        if (!safeEquals(password, options.adminPassword ?? '')) {
          operatorLoginLimiter.recordFailure(attemptKey, snapshot);
          throw new ControlPlaneUiError(401, 'invalid-control-password');
        }
        operatorLoginLimiter.recordSuccess(attemptKey);
        const token = issueSignedSession({
          cookieName: SESSION_COOKIE,
          subject: SESSION_SUBJECT,
          ttlSeconds: SESSION_TTL_SECONDS,
          signingKey: options.sessionSigningKey ?? '',
        }, snapshot);
        const cookie = sessionCookie(request, SESSION_COOKIE, token, SESSION_TTL_SECONDS);
        if (wantsJson(request)) {
          return new Response(null, { status: 204, headers: { 'set-cookie': cookie } });
        }
        return redirect('/admin/storage', { 'set-cookie': cookie });
      }
      if (request.method === 'DELETE' && url.pathname === '/admin/session') {
        return new Response(null, {
          status: 204,
          headers: { 'set-cookie': sessionCookie(request, SESSION_COOKIE, '', 0) },
        });
      }
      if (request.method === 'GET' && url.pathname === '/admin/storage') {
        if (!operatorAuthenticated(request, options, snapshot)) return redirect('/login');
        return html(storagePlannerPage());
      }
      if (request.method === 'POST' && url.pathname === '/admin/storage/plans') {
        if (!operatorAuthenticated(request, options, snapshot)) {
          return json({ error: { code: 'login-required' } }, 401);
        }
        const plan = buildStorageControlPlan(await readPlanPayload(request));
        if (wantsJson(request)) return json({ result: plan });
        return html(storagePlanResultPage(plan));
      }
      if (request.method === 'GET' && url.pathname === '/client') {
        const account = clientSessionAccount(request, options, snapshot, clientLabels);
        return redirect(account === null ? '/client/login' : '/client/storage');
      }
      if (request.method === 'GET' && url.pathname === '/client/login') {
        return html(clientLoginPage(clientConfigured(options, clientAuthenticator)));
      }
      if (request.method === 'POST' && url.pathname === '/client/session') {
        if (!clientConfigured(options, clientAuthenticator)) {
          throw new ControlPlaneUiError(503, 'client-login-not-configured');
        }
        const attemptKey = loginAttemptKey(request);
        clientLoginLimiter.assertAllowed(attemptKey, snapshot);
        const credential = await readClientCredential(request);
        const result = await clientAuthenticator.authenticate({ ...credential, now: snapshot });
        if (result.kind === 'not-configured') {
          throw new ControlPlaneUiError(503, 'client-login-not-configured');
        }
        if (result.kind === 'disabled') {
          clientLoginLimiter.recordFailure(attemptKey, snapshot);
          throw new ControlPlaneUiError(403, 'client-disabled');
        }
        if (result.kind === 'invalid') {
          clientLoginLimiter.recordFailure(attemptKey, snapshot);
          throw new ControlPlaneUiError(401, 'invalid-client-credential');
        }
        clientLoginLimiter.recordSuccess(attemptKey);
        clientLabels.set(result.clientId, result.displayLabel);
        const token = issueSignedSession({
          cookieName: CLIENT_SESSION_COOKIE,
          subject: `${CLIENT_SESSION_SUBJECT_PREFIX}${result.clientId}`,
          ttlSeconds: SESSION_TTL_SECONDS,
          signingKey: options.sessionSigningKey ?? '',
        }, snapshot);
        const cookie = sessionCookie(
          request,
          CLIENT_SESSION_COOKIE,
          token,
          SESSION_TTL_SECONDS,
        );
        if (wantsJson(request)) {
          return new Response(null, { status: 204, headers: { 'set-cookie': cookie } });
        }
        return redirect('/client/storage', { 'set-cookie': cookie });
      }
      if (request.method === 'DELETE' && url.pathname === '/client/session') {
        return new Response(null, {
          status: 204,
          headers: { 'set-cookie': sessionCookie(request, CLIENT_SESSION_COOKIE, '', 0) },
        });
      }
      if (request.method === 'GET' && url.pathname === '/client/storage') {
        const account = clientSessionAccount(request, options, snapshot, clientLabels);
        if (account === null) return redirect('/client/login');
        if (!configurationStore.configured) return html(clientStoragePage(account));
        const overview = await configurationStore.overview(
          account.clientId,
          clientStorageEnvironmentFromUrl(url),
        );
        return html(clientStoragePage(account, overview));
      }
      if (request.method === 'GET' && url.pathname === '/client/storage/configuration') {
        const account = clientSessionAccount(request, options, snapshot, clientLabels);
        if (account === null) return redirect('/client/login');
        const environment = clientStorageEnvironmentFromUrl(url);
        const [overview, tokens] = await Promise.all([
          configurationStore.overview(account.clientId, environment),
          configurationStore.listIntegrationTokens(account.clientId, environment, snapshot),
        ]);
        return html(clientStorageConfigurationPage(account, overview, tokens));
      }
      if (url.pathname === '/client/storage/configurations') {
        const account = clientApiAccount(request, options, snapshot, clientLabels);
        if (request.method === 'GET') {
          const overview = await configurationStore.overview(
            account.clientId,
            clientStorageEnvironmentFromUrl(url),
          );
          return json({ result: overview });
        }
        if (request.method === 'POST') {
          const result = await configurationStore.createDraft(
            account.clientId,
            createConfigurationDraftFromPayload(await readControlJsonPayload(request)),
            snapshot,
          );
          return json({ result }, 201);
        }
      }
      const configurationMatch = url.pathname.match(
        /^\/client\/storage\/configurations\/([^/]+)(?:\/(activate|clone))?$/,
      );
      if (configurationMatch !== null) {
        const account = clientApiAccount(request, options, snapshot, clientLabels);
        const versionId = decodedPathValue(configurationMatch[1] ?? '');
        const action = configurationMatch[2];
        const environment = clientStorageEnvironmentFromUrl(url);
        if (action === undefined && request.method === 'GET') {
          const result = await configurationStore.readVersion(
            account.clientId,
            environment,
            versionId,
          );
          if (acceptsHtml(request)) return html(clientConfigurationVersionPage(account, result));
          return json({ result });
        }
        if (action === undefined && request.method === 'PUT') {
          const result = await configurationStore.replaceDraft(
            account.clientId,
            environment,
            versionId,
            configurationDocumentFromPayload(await readControlJsonPayload(request)),
            snapshot,
          );
          return json({ result });
        }
        if (action === undefined && request.method === 'DELETE') {
          await configurationStore.deleteDraft(account.clientId, environment, versionId);
          return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
        }
        if (action === 'activate' && request.method === 'POST') {
          const result = await configurationStore.activateDraft(
            account.clientId,
            environment,
            versionId,
            snapshot,
          );
          return json({ result });
        }
        if (action === 'clone' && request.method === 'POST') {
          const result = await configurationStore.cloneVersion(
            account.clientId,
            environment,
            versionId,
            snapshot,
          );
          return json({ result }, 201);
        }
      }
      if (url.pathname === '/client/storage/integration-tokens') {
        const account = clientApiAccount(request, options, snapshot, clientLabels);
        if (request.method === 'GET') {
          const result = await configurationStore.listIntegrationTokens(
            account.clientId,
            clientStorageEnvironmentFromUrl(url),
            snapshot,
          );
          return json({ result });
        }
        if (request.method === 'POST') {
          const result = await configurationStore.createIntegrationToken(
            account.clientId,
            integrationTokenInputFromPayload(await readControlJsonPayload(request)),
            snapshot,
          );
          return json({ result }, 201);
        }
      }
      const tokenMatch = url.pathname.match(
        /^\/client\/storage\/integration-tokens\/([^/]+)(?:\/(rotate))?$/,
      );
      if (tokenMatch !== null) {
        const account = clientApiAccount(request, options, snapshot, clientLabels);
        const tokenId = decodedPathValue(tokenMatch[1] ?? '');
        const action = tokenMatch[2];
        const environment = clientStorageEnvironmentFromUrl(url);
        if (action === 'rotate' && request.method === 'POST') {
          const result = await configurationStore.rotateIntegrationToken(
            account.clientId,
            environment,
            tokenId,
            snapshot,
          );
          return json({ result }, 201);
        }
        if (action === undefined && request.method === 'DELETE') {
          const result = await configurationStore.revokeIntegrationToken(
            account.clientId,
            environment,
            tokenId,
            snapshot,
          );
          return json({ result });
        }
      }
      return storageRuntime.handle(request);
    } catch (error) {
      if (error instanceof ClientStorageConfigurationError) {
        if (url.pathname.startsWith('/client/storage/') && url.pathname !== '/client/storage/configuration') {
          return json({ error: { code: error.code } }, error.status);
        }
        const account = clientSessionAccount(request, options, snapshot, clientLabels);
        if (account !== null) return html(clientStoragePage(account), error.status);
        return json({ error: { code: error.code } }, error.status);
      }
      if (error instanceof ControlPlaneUiError) {
        if (url.pathname.startsWith('/client/storage/')) {
          return json({ error: { code: error.code } }, error.status);
        }
        if (wantsJson(request)) return json({ error: { code: error.code } }, error.status);
        if (url.pathname === '/admin/storage/plans') {
          return html(storagePlannerPage(error.code), error.status);
        }
        if (url.pathname.startsWith('/client')) {
          return html(
            clientLoginPage(clientConfigured(options, clientAuthenticator), error.code),
            error.status,
          );
        }
        return html(loginPage(operatorConfigured(options), error.code), error.status);
      }
      const formCode = storageControlFormErrorCode(error);
      const code = formCode === 'internal-error' ? storageControlPlanErrorCode(error) : formCode;
      if (code !== 'internal-error') {
        if (wantsJson(request)) return json({ error: { code } }, 400);
        if (url.pathname === '/admin/storage/plans') return html(storagePlannerPage(code), 400);
        return json({ error: { code } }, 400);
      }
      throw error;
    }
  }

  return Object.freeze({
    handle,
    health: () => storageRuntime.health(),
    readiness: () => storageRuntime.readiness(),
  });
}
