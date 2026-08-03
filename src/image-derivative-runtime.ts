import type { ClientStorageEnvironment } from './client-storage-configuration.js';
import { readSignedSessionClaims } from './control-plane-session.js';
import {
  IMAGE_DERIVATIVE_LIMITS,
  ImageDerivativeError,
  type ImageDerivativeStore,
} from './image-derivative.js';
import type { HttpStorageRuntime } from './runtime-contract.js';
import type { BoundedImageDerivativeWorker } from './image-derivative-worker.js';

const CLIENT_SESSION_COOKIE = 'zs_client_session';
const CLIENT_SESSION_SUBJECT_PREFIX = 'z-s-client:';
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const UPLOAD_ROUTE = /^\/v1\/object-write-intents\/[^/]+\/content$/;

export interface ImageDerivativeRuntimeOptions {
  readonly store: ImageDerivativeStore;
  readonly sessionSigningKey?: string;
  readonly worker?: BoundedImageDerivativeWorker;
  readonly now?: () => Date;
}

function environment(url: URL): ClientStorageEnvironment {
  const value = url.searchParams.get('environment') ?? 'dev';
  if (value === 'dev' || value === 'staging' || value === 'prod') return value;
  throw new ImageDerivativeError('invalid-request', 'invalid-client-storage-environment');
}

function clientId(
  request: Request,
  signingKey: string | undefined,
  now: Date,
): string | null {
  if (signingKey === undefined) return null;
  const claims = readSignedSessionClaims(request, {
    cookieName: CLIENT_SESSION_COOKIE,
    signingKey,
  }, now);
  if (claims === null || !claims.subject.startsWith(CLIENT_SESSION_SUBJECT_PREFIX)) return null;
  const value = claims.subject.slice(CLIENT_SESSION_SUBJECT_PREFIX.length);
  return CLIENT_ID_PATTERN.test(value) ? value : null;
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

function safeError(error: unknown): Readonly<{ code: string; status: number }> {
  if (error instanceof ImageDerivativeError) {
    const status = error.category === 'invalid-request'
      ? 400
      : error.category === 'duplicate-conflict'
        ? 409
        : error.category === 'not-ready' || error.category === 'dependency-unavailable'
          ? 503
          : 500;
    return Object.freeze({ code: error.code, status });
  }
  return Object.freeze({ code: 'image-derivative-status-unavailable', status: 503 });
}

function statusSection(environmentValue: ClientStorageEnvironment): string {
  return `<section class="panel stack" aria-labelledby="image-derivative-title" data-image-derivative-status>
    <div class="section-heading">
      <div><p class="caption">Bounded image processing</p><h2 id="image-derivative-title">Image derivative status</h2></div>
      <span class="badge">safe metadata only</span>
    </div>
    <p>Derivative jobs use the immutable configuration version and preset captured from each verified source image. Provider locators, keys, buckets, checksums, credentials, and signed URLs are not exposed here.</p>
    <div class="state-message" data-image-derivative-state role="status" aria-live="polite">Loading image derivative status…</div>
    <div class="table-scroll" data-image-derivative-table hidden>
      <table>
        <thead><tr><th>Preset</th><th>Width</th><th>Format</th><th>State</th><th>Attempts</th><th>Updated</th></tr></thead>
        <tbody data-image-derivative-rows></tbody>
      </table>
    </div>
  </section>
  <script type="module">
    (() => {
      const root = document.querySelector('[data-image-derivative-status]');
      if (!(root instanceof HTMLElement)) return;
      const state = root.querySelector('[data-image-derivative-state]');
      const table = root.querySelector('[data-image-derivative-table]');
      const rows = root.querySelector('[data-image-derivative-rows]');
      if (!(state instanceof HTMLElement) || !(table instanceof HTMLElement) || !(rows instanceof HTMLElement)) return;
      const setState = (message, kind) => {
        state.textContent = message;
        state.dataset.kind = kind;
        state.hidden = false;
        table.hidden = true;
      };
      const cell = (value) => {
        const element = document.createElement('td');
        element.textContent = String(value);
        return element;
      };
      fetch('/client/storage/image-derivatives?environment=${environmentValue}', {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      }).then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(payload.result)) {
          const code = payload?.error?.code;
          throw new Error(typeof code === 'string' ? code : 'image-derivative-status-unavailable');
        }
        rows.replaceChildren();
        if (payload.result.length === 0) {
          setState('No image derivative jobs exist for this environment.', 'info');
          return;
        }
        for (const item of payload.result) {
          const row = document.createElement('tr');
          const heading = document.createElement('th');
          heading.scope = 'row';
          heading.textContent = String(item.presetId ?? 'unknown');
          row.append(
            heading,
            cell(item.width ?? '—'),
            cell(item.format ?? '—'),
            cell(item.state ?? '—'),
            cell(item.attemptCount ?? '—'),
            cell(item.updatedAt ?? '—'),
          );
          rows.append(row);
        }
        state.hidden = true;
        table.hidden = false;
      }).catch((error) => {
        setState(error instanceof Error ? error.message : 'image-derivative-status-unavailable', 'unavailable');
      });
    })();
  </script>`;
}

async function injectWorkspaceStatus(
  response: Response,
  environmentValue: ClientStorageEnvironment,
): Promise<Response> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || !contentType.toLowerCase().includes('text/html')) return response;
  const body = await response.text();
  if (body.includes('data-image-derivative-status')) {
    return new Response(body, { status: response.status, headers: response.headers });
  }
  const marker = '<section class="panel stack" aria-labelledby="activity-title">';
  const section = statusSection(environmentValue);
  const next = body.includes(marker)
    ? body.replace(marker, `${section}\n  ${marker}`)
    : body.replace('</main>', `${section}\n</main>`);
  return new Response(next, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function enqueueFromResponse(store: ImageDerivativeStore, response: Response, now: Date): Promise<number> {
  if (!response.ok) return 0;
  try {
    const payload: unknown = await response.clone().json();
    if (payload === null || typeof payload !== 'object') return 0;
    const result = (payload as Record<string, unknown>).result;
    if (result === null || typeof result !== 'object') return 0;
    const storageObjectId = (result as Record<string, unknown>).storageObjectId;
    if (typeof storageObjectId !== 'string') return 0;
    return await store.enqueueVerifiedSource(storageObjectId, now);
  } catch {
    // Upload completion remains authoritative. Enqueue is idempotent and can be replayed by repair tooling.
    return 0;
  }
}

async function processEnqueuedJobs(
  worker: BoundedImageDerivativeWorker | undefined,
  enqueued: number,
  now: Date,
): Promise<void> {
  if (worker === undefined || enqueued < 1) return;
  const batches = Math.ceil(IMAGE_DERIVATIVE_LIMITS.maximumWidthsPerPreset /
    IMAGE_DERIVATIVE_LIMITS.maximumConcurrentJobs) + 1;
  for (let index = 0; index < batches; index += 1) {
    const result = await worker.runBatch(`upload-${now.getTime()}-${index + 1}`, now);
    if (result.processed === 0) return;
  }
}

export function createImageDerivativeRuntime(
  runtime: HttpStorageRuntime,
  options: Readonly<ImageDerivativeRuntimeOptions>,
): HttpStorageRuntime {
  const now = options.now ?? (() => new Date());

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const snapshot = now();
    if (request.method === 'GET' && url.pathname === '/client/storage/image-derivatives') {
      const account = clientId(request, options.sessionSigningKey, snapshot);
      if (account === null) return json({ error: { code: 'client-login-required' } }, 401);
      if (!options.store.configured) {
        return json({ error: { code: 'image-derivative-store-not-configured' } }, 503);
      }
      try {
        const result = await options.store.listStatus(
          account,
          environment(url),
          IMAGE_DERIVATIVE_LIMITS.statusResultLimit,
        );
        return json({ result });
      } catch (error) {
        const safe = safeError(error);
        return json({ error: { code: safe.code } }, safe.status);
      }
    }

    const response = await runtime.handle(request);
    if (
      request.method === 'GET' &&
      url.pathname === '/client/storage/configuration' &&
      clientId(request, options.sessionSigningKey, snapshot) !== null
    ) {
      return injectWorkspaceStatus(response, environment(url));
    }
    if (request.method === 'PUT' && UPLOAD_ROUTE.test(url.pathname)) {
      const enqueued = await enqueueFromResponse(options.store, response, snapshot);
      try {
        await processEnqueuedJobs(options.worker, enqueued, snapshot);
      } catch {
        // Derivative execution never changes the already-recorded upload completion response.
      }
    }
    return response;
  }

  return Object.freeze({
    handle,
    health: () => runtime.health(),
    readiness: () => runtime.readiness(),
  });
}
