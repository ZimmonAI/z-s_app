import type {
  ClientStorageEnvironment,
  ClientStorageOverview,
  ConfigurationVersionSnapshot,
  IntegrationTokenMetadata,
} from './client-storage-configuration.js';
import { controlPage, escapeHtml } from './storage-control-html.js';

export interface ClientAccountView {
  readonly clientId: string;
  readonly displayLabel: string;
}

function environmentNavigation(environment: ClientStorageEnvironment): string {
  return `<nav class="panel" aria-label="Storage environment">
    <strong>Environment</strong>
    <a href="/client/storage?environment=dev"${environment === 'dev' ? ' aria-current="page"' : ''}>Dev</a>
    <a href="/client/storage?environment=staging"${environment === 'staging' ? ' aria-current="page"' : ''}>Staging</a>
    <a href="/client/storage?environment=prod"${environment === 'prod' ? ' aria-current="page"' : ''}>Production</a>
  </nav>`;
}

function activeVersionSummary(overview: Readonly<ClientStorageOverview>): string {
  if (overview.activeVersion === undefined) {
    return '<p>No active configuration. Runtime routing remains on the separately governed existing authority.</p>';
  }
  const activatedAt = overview.activeVersion.activatedAt === undefined
    ? ''
    : `<p>Activated: ${escapeHtml(overview.activeVersion.activatedAt)}</p>`;
  return `<p>Active version: <strong>v${overview.activeVersion.versionNumber}</strong></p>
    ${activatedAt}`;
}

export function clientLoginPage(configured: boolean, error?: string): string {
  const status = configured
    ? '<p>Use the client account credential to open the client storage surface.</p>'
    : '<p class="error">client-login-not-configured</p>';
  const errorBlock = error === undefined ? '' : `<p class="error">${escapeHtml(error)}</p>`;
  return controlPage('Client login', `<main>
  <header>
    <p class="caption">Z-s client access</p>
    <h1>Client login</h1>
    ${status}
  </header>
  <form class="panel stack" method="post" action="/client/session">
    ${errorBlock}
    <label for="client-id">Client ID<input id="client-id" name="clientId" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
    <label for="client-credential">Client credential<input id="client-credential" name="clientCredential" type="password" autocomplete="new-password" autocapitalize="none" spellcheck="false" required></label>
    <button type="submit"${configured ? '' : ' disabled'}>Open client storage</button>
  </form>
</main>`);
}

export function clientStoragePage(
  account: Readonly<ClientAccountView>,
  overview?: Readonly<ClientStorageOverview>,
): string {
  const content = overview === undefined
    ? `<section class="panel stack" aria-label="Client storage status">
      <h2>Configuration platform unavailable</h2>
      <p class="error">client-storage-configuration-not-configured</p>
      <p>Your authenticated browser session is active, but configuration persistence is unavailable.</p>
    </section>`
    : `${environmentNavigation(overview.environment)}
    <section class="panel stack" aria-label="Active configuration">
      <h2>Configuration status</h2>
      ${activeVersionSummary(overview)}
      <p>Draft versions: <strong>${overview.draftVersions.length}</strong></p>
      <p>Provider connection references: <strong>${overview.providerConnectionCount}</strong></p>
      <p>Integration tokens: <strong>${overview.integrationTokenCount}</strong></p>
      <p><a href="/client/storage/configuration?environment=${overview.environment}">Open configuration workspace</a></p>
    </section>`;
  return controlPage('Client storage', `<main>
  <header>
    <p class="caption">Z-s client storage</p>
    <h1>${escapeHtml(account.displayLabel)}</h1>
    <p>Authenticated client: <strong>${escapeHtml(account.clientId)}</strong></p>
  </header>
  ${content}
</main>`);
}

function draftRows(overview: Readonly<ClientStorageOverview>): string {
  if (overview.draftVersions.length === 0) return '<p>No draft configurations.</p>';
  return `<ul>${overview.draftVersions.map((draft) => `<li>
    <a href="/client/storage/configurations/${encodeURIComponent(draft.id)}?environment=${overview.environment}">
      Version ${draft.versionNumber}
    </a>
    — ${escapeHtml(draft.validationState)}
  </li>`).join('')}</ul>`;
}

function tokenRows(tokens: readonly Readonly<IntegrationTokenMetadata>[]): string {
  if (tokens.length === 0) return '<p>No integration tokens.</p>';
  return `<ul>${tokens.map((token) => `<li>
    <strong>${escapeHtml(token.displayLabel)}</strong>
    <span>${escapeHtml(token.tokenId)}</span>
    <span>${escapeHtml(token.status)}</span>
    <span>${escapeHtml(token.scopes.join(', '))}</span>
  </li>`).join('')}</ul>`;
}

export function clientStorageConfigurationPage(
  account: Readonly<ClientAccountView>,
  overview: Readonly<ClientStorageOverview>,
  tokens: readonly Readonly<IntegrationTokenMetadata>[],
  error?: string,
): string {
  const errorBlock = error === undefined ? '' : `<p class="error">${escapeHtml(error)}</p>`;
  return controlPage('Storage configuration', `<main>
  <header>
    <p class="caption">Z-s client storage</p>
    <h1>Configuration workspace</h1>
    <p>${escapeHtml(account.displayLabel)} · ${escapeHtml(overview.environment)}</p>
    ${errorBlock}
  </header>
  ${environmentNavigation(overview.environment)}
  <section class="panel stack" aria-label="Configuration versions">
    <h2>Versions</h2>
    ${activeVersionSummary(overview)}
    ${draftRows(overview)}
    <p>Draft CRUD, validation, activation, and clone operations are available through the authenticated JSON endpoints under <code>/client/storage/configurations</code>.</p>
  </section>
  <section class="panel stack" aria-label="Integration tokens">
    <h2>Integration tokens</h2>
    ${tokenRows(tokens)}
    <p>Raw token values are returned only by create and rotate responses. Metadata listings never contain token values or digests.</p>
  </section>
  <section class="panel stack" aria-label="Runtime boundary">
    <h2>Runtime boundary</h2>
    <p>Browser sessions manage configuration only. Integration tokens do not authorize this workspace, and this configuration does not become generic runtime routing authority until the later runtime-routing handoff.</p>
  </section>
</main>`);
}

export function clientConfigurationVersionPage(
  account: Readonly<ClientAccountView>,
  version: Readonly<ConfigurationVersionSnapshot>,
): string {
  return controlPage('Configuration version', `<main>
  <header>
    <p class="caption">Z-s client storage</p>
    <h1>Configuration version ${version.versionNumber}</h1>
    <p>${escapeHtml(account.displayLabel)} · ${escapeHtml(version.environment)}</p>
  </header>
  <section class="panel stack">
    <p>State: <strong>${escapeHtml(version.state)}</strong></p>
    <p>Validation: <strong>${escapeHtml(version.validationState)}</strong></p>
    <p>Provider connections: ${version.providerConnections.length}</p>
    <p>Vaults: ${version.vaults.length}</p>
    <p>Routes: ${version.routes.length}</p>
    <p>Image presets: ${version.imagePresets.length}</p>
  </section>
</main>`);
}
