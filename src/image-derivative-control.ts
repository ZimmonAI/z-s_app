import type { ClientStorageEnvironment } from './client-storage-configuration.js';
import { CLIENT_STORAGE_ENVIRONMENTS } from './client-storage-configuration.js';
import {
  IMAGE_DERIVATIVE_LIMITS,
  type ImageDerivativeStatusSnapshot,
  type ImageDerivativeStore,
} from './image-derivative.js';
import { readSignedSessionClaims } from './control-plane-session.js';
import { escapeHtml } from './storage-control-html.js';
import type { HttpStorageRuntime } from './runtime-contract.js';

const CLIENT_SESSION_COOKIE = 'zs_client_session';
const CLIENT_SESSION_SUBJECT_PREFIX = 'z-s-client:';
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const WORKSPACE_INSERTION_MARKER = '<section class="panel stack" aria-labelledby="activity-title">';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function environment(url: URL): ClientStorageEnvironment | null {
  const value = url.searchParams.get('environment') ?? 'dev';
  return (CLIENT_STORAGE_ENVIRONMENTS as readonly string[]).includes(value)
    ? value as ClientStorageEnvironment
    : null;
}

function clientId(request: Request, signingKey: string | undefined, now: Date): string | null {
  if (signingKey === undefined) return null;
  const claims = readSignedSessionClaims(request, {
    cookieName: CLIENT_SESSION_COOKIE,
    signingKey,
  }, now);
  if (claims === null || !claims.subject.startsWith(CLIENT_SESSION_SUBJECT_PREFIX)) return null;
  const value = claims.subject.slice(CLIENT_SESSION_SUBJECT_PREFIX.length);
  return CLIENT_ID_PATTERN.test(value) ? value : null;
}

function date(value: string | undefined): string {
  if (value === undefined) return '—';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? escapeHtml(parsed.toISOString().replace('T', ' ').replace('.000Z', ' UTC'))
    : escapeHtml(value);
}

function badge(value: string): string {
  return `<span class="badge" data-status="${escapeHtml(value)}">${escapeHtml(value)}</span>`;
}

function derivativeRows(rows: readonly Readonly<ImageDerivativeStatusSnapshot>[]): string {
  if (rows.length === 0) {
    return `<div class="state-message">
      <strong>No image derivative jobs</strong>
      <p>Verified image uploads will appear here when their immutable configuration route has an image preset.</p>
    </div>`;
  }
  return `<div class="table-scroll"><table>
    <thead><tr><th>Preset</th><th>Width</th><th>Format</th><th>State</th><th>Attempts</th><th>Updated</th><th>Diagnostic</th></tr></thead>
    <tbody>${rows.map((row) => `<tr>
      <th scope="row"><code>${escapeHtml(row.presetId)}</code></th>
      <td>${row.width}px</td>
      <td>${escapeHtml(row.outputFormat)}</td>
      <td>${badge(row.state)}</td>
      <td>${row.attemptCount}</td>
      <td>${date(row.updatedAt)}</td>
      <td>${row.safeDiagnosticCode === undefined ? '—' : `<code>${escapeHtml(row.safeDiagnosticCode)}</code>`}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function section(input: {
  rows?: readonly Readonly<ImageDerivativeStatusSnapshot>[];
  unavailableCode?: string;
}): string {
  const content = input.rows === undefined
    ? `<div class="state-message" data-kind="unavailable">
      <strong>Image derivative status unavailable</strong>
      <p>${escapeHtml(input.unavailableCode ?? 'image-derivative-store-unavailable')}</p>
      <p>Configuration and integration-token workflows remain available.</p>
    </div>`
    : `${derivativeRows(input.rows)}
      <p class="help">The table is bounded to ${IMAGE_DERIVATIVE_LIMITS.maximumStatusRows} safe rows. Processor availability is independent from this workspace; queued work remains durable when no worker is running.</p>`;
  return `<section class="panel stack" aria-labelledby="image-derivative-status-title" data-image-derivative-status>
    <div class="section-heading">
      <div><p class="caption">Bounded image processing</p><h2 id="image-derivative-status-title">Image derivative status</h2></div>
      <span class="badge">safe metadata</span>
    </div>
    ${content}
  </section>
  `;
}

async function injectWorkspace(
  response: Response,
  store: ImageDerivativeStore,
  accountClientId: string,
  selectedEnvironment: ClientStorageEnvironment,
): Promise<Response> {
  if (response.status !== 200 || !(response.headers.get('content-type') ?? '').includes('text/html')) {
    return response;
  }
  const source = await response.text();
  if (!source.includes(WORKSPACE_INSERTION_MARKER) || source.includes('data-image-derivative-status')) {
    return new Response(source, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  let addition: string;
  if (!store.configured) {
    addition = section({ unavailableCode: 'image-derivative-store-unavailable' });
  } else {
    try {
      const rows = await store.listStatus(
        accountClientId,
        selectedEnvironment,
        IMAGE_DERIVATIVE_LIMITS.maximumStatusRows,
      );
      addition = section({ rows });
    } catch (error) {
      const code = error instanceof Error && /^[a-z0-9][a-z0-9-]{0,95}$/.test(error.message)
        ? error.message
        : 'image-derivative-status-unavailable';
      addition = section({ unavailableCode: code });
    }
  }
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(source.replace(WORKSPACE_INSERTION_MARKER, addition + WORKSPACE_INSERTION_MARKER), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export interface ImageDerivativeControlOptions {
  readonly store: ImageDerivativeStore;
  readonly sessionSigningKey?: string;
  readonly now?: () => Date;
}

export function createImageDerivativeControlRuntime(
  runtime: HttpStorageRuntime,
  options: ImageDerivativeControlOptions,
): HttpStorageRuntime {
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const snapshot = now();
      if (request.method === 'GET' && url.pathname === '/client/storage/image-derivatives') {
        const accountClientId = clientId(request, options.sessionSigningKey, snapshot);
        if (accountClientId === null) return json({ error: { code: 'client-login-required' } }, 401);
        const selectedEnvironment = environment(url);
        if (selectedEnvironment === null) {
          return json({ error: { code: 'invalid-client-storage-environment' } }, 400);
        }
        if (!options.store.configured) {
          return json({ error: { code: 'image-derivative-store-unavailable' } }, 503);
        }
        try {
          const result = await options.store.listStatus(
            accountClientId,
            selectedEnvironment,
            IMAGE_DERIVATIVE_LIMITS.maximumStatusRows,
          );
          return json({ result });
        } catch (error) {
          const code = error instanceof Error && /^[a-z0-9][a-z0-9-]{0,95}$/.test(error.message)
            ? error.message
            : 'image-derivative-status-unavailable';
          return json({ error: { code } }, 503);
        }
      }

      const response = await runtime.handle(request);
      if (request.method !== 'GET' || url.pathname !== '/client/storage/configuration') {
        return response;
      }
      const accountClientId = clientId(request, options.sessionSigningKey, snapshot);
      const selectedEnvironment = environment(url);
      if (accountClientId === null || selectedEnvironment === null) return response;
      return injectWorkspace(response, options.store, accountClientId, selectedEnvironment);
    },
    health: () => runtime.health(),
    readiness: () => runtime.readiness(),
  });
}
