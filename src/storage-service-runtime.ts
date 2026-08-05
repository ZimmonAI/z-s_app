import { readSignedSessionClaims } from './control-plane-session.js';
import {
  ControlPlaneUiError,
  readControlJsonPayload,
} from './control-plane-ui-request.js';
import type { HttpStorageRuntime } from './runtime-contract.js';
import type { StorageServiceApplicationService } from './storage-service-application.js';
import {
  StorageServiceError,
  type StorageServiceSnapshot,
} from './storage-service.js';
import {
  createStorageServiceInput,
  storageServiceEnvironmentFromUrl,
  storageServiceFilterFromUrl,
  storageServiceSecretReplacementInput,
  storageServiceTestScope,
} from './storage-service-request.js';
import {
  storageServiceActivityPage,
  storageServiceDetailPage,
  storageServiceNewPage,
  storageServiceSetupPage,
  storageServicesPage,
  storageServiceWorkflowPage,
  type StorageServiceAccountView,
} from './storage-service-presentation.js';

const CLIENT_SESSION_COOKIE = 'zs_client_session';
const CLIENT_SESSION_SUBJECT_PREFIX = 'z-s-client:';
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const SERVICE_PATH = /^\/client\/storage\/services\/([^/]+)(?:\/(setup|workflow|activity|test|secret|configuration-drafts|disable|archive))?$/;

export interface StorageServiceRuntimeOptions {
  readonly service: StorageServiceApplicationService;
  readonly sessionSigningKey?: string;
  readonly now?: () => Date;
}


class StorageServiceMutationLimiter {
  readonly #attempts = new Map<string, number[]>();

  assertAllowed(key: string, now: Date): void {
    const cutoff = now.getTime() - 60_000;
    const recent = (this.#attempts.get(key) ?? []).filter((value) => value > cutoff);
    if (recent.length >= 12) {
      throw new ControlPlaneUiError(429, 'storage-service-rate-limited');
    }
    recent.push(now.getTime());
    this.#attempts.set(key, recent);
    if (this.#attempts.size > 2048) {
      for (const [candidate, values] of this.#attempts) {
        if (values.every((value) => value <= cutoff)) this.#attempts.delete(candidate);
      }
    }
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, 'cache-control': 'no-store' },
  });
}

function clientAccount(
  request: Request,
  signingKey: string | undefined,
  now: Date,
): Readonly<StorageServiceAccountView> | null {
  if (signingKey === undefined) return null;
  const claims = readSignedSessionClaims(request, {
    cookieName: CLIENT_SESSION_COOKIE,
    signingKey,
  }, now);
  if (claims === null || !claims.subject.startsWith(CLIENT_SESSION_SUBJECT_PREFIX)) return null;
  const clientId = claims.subject.slice(CLIENT_SESSION_SUBJECT_PREFIX.length);
  if (!CLIENT_ID_PATTERN.test(clientId)) return null;
  return Object.freeze({ clientId, displayLabel: clientId });
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ControlPlaneUiError(400, 'invalid-path-identifier');
  }
}

function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (origin === null || origin !== new URL(request.url).origin) {
    throw new ControlPlaneUiError(403, 'storage-service-csrf-check-failed');
  }
}

function publicService(service: Readonly<StorageServiceSnapshot>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    serviceId: service.serviceId,
    environment: service.environment,
    displayName: service.displayName,
    providerType: service.providerType,
    ownership: service.ownership,
    status: service.status,
    safeMetadata: service.safeMetadata,
    capabilities: service.capabilities,
    lastTestStatus: service.lastTestStatus,
    ...(service.lastTestedAt === undefined ? {} : { lastTestedAt: service.lastTestedAt }),
    ...(service.lastDiagnosticCode === undefined
      ? {}
      : { lastDiagnosticCode: service.lastDiagnosticCode }),
    createdAt: service.createdAt,
    updatedAt: service.updatedAt,
  });
}

function safeError(error: unknown): Readonly<{ status: number; code: string }> {
  if (
    error instanceof StorageServiceError ||
    error instanceof ControlPlaneUiError
  ) {
    return Object.freeze({ status: error.status, code: error.code });
  }
  if (error !== null && typeof error === 'object') {
    const candidate = error as Record<string, unknown>;
    if (typeof candidate.status === 'number' && typeof candidate.code === 'string') {
      return Object.freeze({ status: candidate.status, code: candidate.code });
    }
  }
  return Object.freeze({ status: 503, code: 'storage-service-unavailable' });
}

function expectsJson(request: Request): boolean {
  return (request.headers.get('accept') ?? '').toLowerCase().includes('application/json');
}


async function injectStorageServiceNavigation(response: Response, environment: string): Promise<Response> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || !contentType.toLowerCase().includes('text/html')) return response;
  const body = await response.text();
  if (body.includes('data-storage-service-navigation')) {
    return new Response(body, { status: response.status, headers: response.headers });
  }
  const link = `<section class="panel stack" data-storage-service-navigation>
    <div class="section-heading"><div><p class="caption">Provider-neutral services</p><h2>Storage services</h2></div>
    <a class="button-link" href="/client/storage/services?environment=${environment}">Manage storage services</a></div>
    <p>Connect, test, and govern managed or client-owned storage without exposing credentials or provider-private details.</p>
  </section>`;
  const next = body.replace('</main>', `${link}
</main>`);
  return new Response(next, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createStorageServiceRuntime(
  runtime: HttpStorageRuntime,
  options: Readonly<StorageServiceRuntimeOptions>,
): HttpStorageRuntime {
  const now = options.now ?? (() => new Date());
  const mutationLimiter = new StorageServiceMutationLimiter();

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const isServiceRoute = url.pathname === '/client/storage/services' ||
      url.pathname === '/client/storage/services/new' || SERVICE_PATH.test(url.pathname);
    if (!isServiceRoute) {
      const response = await runtime.handle(request);
      if (
        request.method === 'GET' &&
        (url.pathname === '/client/storage' || url.pathname === '/client/storage/configuration')
      ) {
        return injectStorageServiceNavigation(
          response,
          url.searchParams.get('environment') ?? 'dev',
        );
      }
      return response;
    }

    const snapshot = now();
    const account = clientAccount(request, options.sessionSigningKey, snapshot);
    if (account === null) {
      return expectsJson(request)
        ? json({ error: { code: 'client-login-required' } }, 401)
        : redirect('/client/login');
    }
    if (!options.service.configured) {
      return expectsJson(request)
        ? json({ error: { code: 'storage-service-store-not-configured' } }, 503)
        : html('<h1>storage-service-store-not-configured</h1>', 503);
    }

    try {
      if (request.method === 'GET' && url.pathname === '/client/storage/services') {
        const filter = storageServiceFilterFromUrl(url);
        const environment = filter.environment ?? storageServiceEnvironmentFromUrl(url);
        const services = await options.service.list(account.clientId, filter);
        if (expectsJson(request)) return json({ result: services.map(publicService) });
        return html(storageServicesPage(account, environment, services));
      }
      if (request.method === 'GET' && url.pathname === '/client/storage/services/new') {
        return html(storageServiceNewPage(
          account,
          storageServiceEnvironmentFromUrl(url),
          options.service.manifests(),
        ));
      }
      if (request.method === 'POST' && url.pathname === '/client/storage/services') {
        assertSameOrigin(request);
        mutationLimiter.assertAllowed(`${account.clientId}:create`, snapshot);
        const service = await options.service.createClientOwned(
          account.clientId,
          createStorageServiceInput(await readControlJsonPayload(request)),
          snapshot,
        );
        return json({ result: publicService(service) }, 201);
      }

      const match = url.pathname.match(SERVICE_PATH);
      if (match === null) return runtime.handle(request);
      const serviceId = decoded(match[1] ?? '');
      const action = match[2];
      const environment = storageServiceEnvironmentFromUrl(url);
      const service = await options.service.read(account.clientId, environment, serviceId);

      if (request.method === 'GET' && action === undefined) {
        const dependencies = await options.service.dependencies(
          account.clientId,
          environment,
          serviceId,
        );
        if (expectsJson(request)) {
          return json({ result: { service: publicService(service), dependencies } });
        }
        return html(storageServiceDetailPage(account, service, dependencies));
      }
      if (request.method === 'GET' && action === 'setup') {
        return html(storageServiceSetupPage(account, service));
      }
      if (request.method === 'GET' && action === 'workflow') {
        return html(storageServiceWorkflowPage(account, service));
      }
      if (request.method === 'GET' && action === 'activity') {
        const activity = await options.service.activity(account.clientId, environment, serviceId);
        if (expectsJson(request)) return json({ result: activity });
        return html(storageServiceActivityPage(account, service, activity));
      }

      assertSameOrigin(request);
      mutationLimiter.assertAllowed(`${account.clientId}:${serviceId}:${action ?? 'unknown'}`, snapshot);
      if (request.method === 'POST' && action === 'test') {
        const result = await options.service.test(
          account.clientId,
          environment,
          serviceId,
          storageServiceTestScope(await readControlJsonPayload(request)),
          snapshot,
        );
        return json({ result: publicService(result) });
      }
      if (request.method === 'PUT' && action === 'secret') {
        const input = storageServiceSecretReplacementInput(await readControlJsonPayload(request));
        const result = await options.service.replaceSecret(
          account.clientId,
          environment,
          serviceId,
          input.secretInput,
          input.testScope,
          snapshot,
        );
        return json({ result: publicService(result) });
      }
      if (request.method === 'POST' && action === 'configuration-drafts') {
        await readControlJsonPayload(request);
        const draft = await options.service.createConfigurationDraft(
          account.clientId,
          environment,
          serviceId,
          snapshot,
        );
        return json({ result: { versionId: draft.id, versionNumber: draft.versionNumber } }, 201);
      }
      if (request.method === 'POST' && (action === 'disable' || action === 'archive')) {
        await readControlJsonPayload(request);
        const result = await options.service.disableOrArchive(
          account.clientId,
          environment,
          serviceId,
          action === 'disable' ? 'disabled' : 'archived',
          snapshot,
        );
        return json({ result: publicService(result) });
      }
      return json({ error: { code: 'route-not-found' } }, 404);
    } catch (error) {
      const safe = safeError(error);
      return json({ error: { code: safe.code } }, safe.status);
    }
  }

  return Object.freeze({
    handle,
    health: () => runtime.health(),
    readiness: () => runtime.readiness(),
  });
}
