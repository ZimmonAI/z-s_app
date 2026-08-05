import type { ClientStorageEnvironment } from './client-storage-configuration.js';
import { controlPage, escapeHtml } from './storage-control-html.js';
import type { StorageProviderManifest } from './storage-provider-adapter.js';
import type {
  StorageServiceActivityEvent,
  StorageServiceDependencySnapshot,
  StorageServiceSnapshot,
} from './storage-service.js';
import { storageServiceClientScript } from './storage-service-client.js';

export interface StorageServiceAccountView {
  readonly clientId: string;
  readonly displayLabel: string;
}

function environmentNavigation(environment: ClientStorageEnvironment): string {
  return `<nav class="environment-nav" aria-label="Storage environment">
    <span class="environment-nav-label">Environment</span>
    ${(['dev', 'staging', 'prod'] as const).map((value) => `<a href="/client/storage/services?environment=${value}"${
      environment === value ? ' aria-current="page"' : ''
    }>${value === 'prod' ? 'Production' : value[0]?.toUpperCase()}${value.slice(1)}</a>`).join('')}
  </nav>`;
}

function statusBadge(status: string): string {
  return `<span class="badge" data-status="${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function formatDate(value: string | undefined): string {
  if (value === undefined) return 'Never';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? escapeHtml(date.toISOString()) : escapeHtml(value);
}

function serviceUrl(service: Readonly<StorageServiceSnapshot>, suffix = ''): string {
  return `/client/storage/services/${encodeURIComponent(service.serviceId)}${suffix}?environment=${service.environment}`;
}

function tabs(service: Readonly<StorageServiceSnapshot>, active: string): string {
  const items = [
    ['overview', '', 'Overview'],
    ['setup', '/setup', 'Setup'],
    ['workflow', '/workflow', 'Workflow'],
    ['activity', '/activity', 'Activity'],
  ] as const;
  return `<nav class="environment-nav" aria-label="Storage service sections">
    ${items.map(([value, suffix, label]) => `<a href="${serviceUrl(service, suffix)}"${
      active === value ? ' aria-current="page"' : ''
    }>${label}</a>`).join('')}
  </nav>`;
}

function serviceHeader(
  account: Readonly<StorageServiceAccountView>,
  service: Readonly<StorageServiceSnapshot>,
): string {
  return `<header>
    <p class="caption">Z-s storage service management</p>
    <h1>${escapeHtml(service.displayName)}</h1>
    <p>${escapeHtml(account.displayLabel)} · ${escapeHtml(service.environment)} · <code>${escapeHtml(service.serviceId)}</code></p>
    <div class="toolbar">${statusBadge(service.status)} ${statusBadge(service.ownership)}</div>
  </header>`;
}

function safeServiceSummary(service: Readonly<StorageServiceSnapshot>): string {
  const safeMetadata = Object.entries(service.safeMetadata)
    .filter(([key]) => !/secret|credential|endpoint|bucket|token|key/i.test(key))
    .map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd></div>`)
    .join('');
  return `<dl class="definition-list">
    <div><dt>Provider</dt><dd>${escapeHtml(service.providerType)}</dd></div>
    <div><dt>Ownership</dt><dd>${escapeHtml(service.ownership)}</dd></div>
    <div><dt>Last connection test</dt><dd>${escapeHtml(service.lastTestStatus)} · ${formatDate(service.lastTestedAt)}</dd></div>
    ${service.lastDiagnosticCode === undefined ? '' : `<div><dt>Safe diagnostic</dt><dd><code>${escapeHtml(service.lastDiagnosticCode)}</code></dd></div>`}
    ${safeMetadata}
  </dl>`;
}

function capabilityTable(service: Readonly<StorageServiceSnapshot>): string {
  return `<div class="table-scroll"><table>
    <thead><tr><th>Capability</th><th>Available</th></tr></thead>
    <tbody>${Object.entries(service.capabilities).map(([key, value]) => `<tr>
      <th scope="row">${escapeHtml(key)}</th><td>${value ? 'Yes' : 'No'}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

export function storageServicesPage(
  account: Readonly<StorageServiceAccountView>,
  environment: ClientStorageEnvironment,
  services: readonly Readonly<StorageServiceSnapshot>[],
): string {
  const rows = services.length === 0
    ? '<p class="state-message">No storage services match the current filters.</p>'
    : `<div class="table-scroll"><table>
      <thead><tr><th>Service</th><th>Provider</th><th>Ownership</th><th>Status</th><th>Last test</th></tr></thead>
      <tbody>${services.map((service) => `<tr>
        <th scope="row"><a href="${serviceUrl(service)}">${escapeHtml(service.displayName)}</a><br><code>${escapeHtml(service.serviceId)}</code></th>
        <td>${escapeHtml(service.providerType)}</td>
        <td>${escapeHtml(service.ownership)}</td>
        <td>${statusBadge(service.status)}</td>
        <td>${escapeHtml(service.lastTestStatus)} · ${formatDate(service.lastTestedAt)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  return controlPage('Storage services', `<main data-storage-services>
    <header>
      <p class="caption">Z-s client storage control center</p>
      <h1>Storage services</h1>
      <p>${escapeHtml(account.displayLabel)} · provider-neutral service management</p>
    </header>
    ${environmentNavigation(environment)}
    <section class="panel stack">
      <div class="section-heading">
        <div><h2>Connected services</h2><p>Managed and client-owned storage are shown through one safe lifecycle.</p></div>
        <a class="button-link" href="/client/storage/services/new?environment=${environment}">Connect storage service</a>
      </div>
      <form class="field-grid" method="get" action="/client/storage/services">
        <input type="hidden" name="environment" value="${environment}">
        <label>Provider type<input name="providerType" autocomplete="off"></label>
        <label>Ownership<select name="ownership"><option value="">All</option><option value="z-s-managed">Z-s managed</option><option value="client-owned">Client owned</option></select></label>
        <label>Status<select name="status"><option value="">All</option>${['draft', 'awaiting-secret', 'testing', 'ready', 'failed', 'disabled', 'archived'].map((status) => `<option value="${status}">${status}</option>`).join('')}</select></label>
        <button type="submit">Apply filters</button>
      </form>
      ${rows}
    </section>
  </main>`);
}

export function storageServiceNewPage(
  account: Readonly<StorageServiceAccountView>,
  environment: ClientStorageEnvironment,
  manifests: readonly Readonly<StorageProviderManifest>[],
): string {
  const accepted = manifests.filter((manifest) => manifest.adapterStatus === 'accepted');
  return controlPage('Connect storage service', `<main data-storage-service-create>
    <header>
      <p class="caption">Z-s storage service management</p>
      <h1>Connect storage service</h1>
      <p>${escapeHtml(account.displayLabel)} · ${environment}</p>
    </header>
    <div id="storage-service-status" class="state-message" role="status" aria-live="polite" hidden></div>
    <section class="panel stack">
      <div class="state-message" data-kind="warning">
        <strong>Credentials are write-only.</strong>
        <p>Submitted values are encrypted with the deployment master key and are never revealed by the browser or API.</p>
      </div>
      <form class="stack" data-storage-service-create-form>
        <input type="hidden" name="environment" value="${environment}">
        <div class="field-grid">
          <label>Service ID<input name="serviceId" required pattern="[a-z0-9][a-z0-9._:-]{0,127}" autocomplete="off"></label>
          <label>Display name<input name="displayName" required maxlength="160" autocomplete="off"></label>
          <label>Provider<select name="providerType" required>${accepted.map((manifest) => `<option value="${escapeHtml(manifest.providerType)}">${escapeHtml(manifest.displayName)}</option>`).join('')}</select></label>
          <label>Safe account label<input name="accountLabel" maxlength="160" autocomplete="off"></label>
        </div>
        <fieldset class="stack">
          <legend>Cloudflare R2 credential bundle</legend>
          <div class="field-grid">
            <label>Account ID<input name="accountId" type="password" required autocomplete="new-password"></label>
            <label>Access key ID<input name="accessKeyId" type="password" required autocomplete="new-password"></label>
            <label>Secret access key<input name="secretAccessKey" type="password" required autocomplete="new-password"></label>
            <label>Bounded test bucket<input name="bucket" type="password" required autocomplete="new-password"></label>
            <label>Bounded test prefix<input name="prefix" value="z-s-connection-test" required autocomplete="off"></label>
          </div>
        </fieldset>
        <button type="submit">Encrypt, store, test, and save</button>
      </form>
    </section>
  </main>
  ${storageServiceClientScript({ kind: 'create' })}`);
}

export function storageServiceDetailPage(
  account: Readonly<StorageServiceAccountView>,
  service: Readonly<StorageServiceSnapshot>,
  dependencies: Readonly<StorageServiceDependencySnapshot>,
): string {
  return controlPage(service.displayName, `<main data-storage-service data-environment="${service.environment}" data-service-id="${escapeHtml(service.serviceId)}">
    ${serviceHeader(account, service)}
    ${tabs(service, 'overview')}
    <div id="storage-service-status" class="state-message" role="status" aria-live="polite" hidden></div>
    <section class="grid">
      <article class="panel stack"><h2>Safe service metadata</h2>${safeServiceSummary(service)}</article>
      <article class="panel stack"><h2>Dependencies</h2>
        <div class="metrics">
          <div class="metric"><span class="metric-label">Active configurations</span><strong>${dependencies.activeConfigurationCount}</strong></div>
          <div class="metric"><span class="metric-label">Draft configurations</span><strong>${dependencies.draftConfigurationCount}</strong></div>
          <div class="metric"><span class="metric-label">Persisted copies</span><strong>${dependencies.objectCopyCount}</strong></div>
          <div class="metric"><span class="metric-label">Derivative outputs</span><strong>${dependencies.derivativeOutputCount}</strong></div>
        </div>
      </article>
    </section>
    <section class="panel stack"><h2>Capabilities</h2>${capabilityTable(service)}</section>
    <section class="panel stack">
      <h2>Lifecycle actions</h2>
      <div class="toolbar">
        <button type="button" data-service-test${service.ownership === 'client-owned' ? '' : ' disabled'}>Run bounded test</button>
        <button type="button" data-service-create-draft${service.status === 'ready' ? '' : ' disabled'}>Create configuration draft</button>
        <button type="button" class="button-secondary" data-service-disable${dependencies.activeConfigurationCount > 0 ? ' disabled' : ''}>Disable</button>
        <button type="button" class="button-danger" data-service-archive${dependencies.activeConfigurationCount + dependencies.objectCopyCount + dependencies.derivativeOutputCount > 0 ? ' disabled' : ''}>Archive</button>
      </div>
    </section>
  </main>
  ${storageServiceClientScript({ kind: 'detail', environment: service.environment, serviceId: service.serviceId })}`);
}

export function storageServiceSetupPage(
  account: Readonly<StorageServiceAccountView>,
  service: Readonly<StorageServiceSnapshot>,
): string {
  const replacement = service.ownership === 'client-owned'
    ? `<form class="stack" data-storage-service-replace-form>
        <div class="state-message" data-kind="warning"><strong>Replace-only secret flow.</strong><p>The previous secret is revoked after the new encrypted envelope is persisted.</p></div>
        <div class="field-grid">
          <label>Account ID<input name="accountId" type="password" required autocomplete="new-password"></label>
          <label>Access key ID<input name="accessKeyId" type="password" required autocomplete="new-password"></label>
          <label>Secret access key<input name="secretAccessKey" type="password" required autocomplete="new-password"></label>
          <label>Bounded test bucket<input name="bucket" type="password" required autocomplete="new-password"></label>
          <label>Bounded test prefix<input name="prefix" value="z-s-connection-test" required></label>
        </div>
        <button type="submit">Replace secret and retest</button>
      </form>`
    : '<p class="state-message" data-kind="unavailable">Z-s managed credentials are controlled by deployment operations and cannot be replaced by the client.</p>';
  return controlPage('Storage service setup', `<main data-storage-service data-environment="${service.environment}" data-service-id="${escapeHtml(service.serviceId)}">
    ${serviceHeader(account, service)}${tabs(service, 'setup')}
    <div id="storage-service-status" class="state-message" role="status" aria-live="polite" hidden></div>
    <section class="panel stack"><h2>Credential setup</h2>${replacement}</section>
  </main>
  ${storageServiceClientScript({ kind: 'setup', environment: service.environment, serviceId: service.serviceId })}`);
}

export function storageServiceWorkflowPage(
  account: Readonly<StorageServiceAccountView>,
  service: Readonly<StorageServiceSnapshot>,
): string {
  return controlPage('Storage service workflow', `<main>
    ${serviceHeader(account, service)}${tabs(service, 'workflow')}
    <section class="panel stack"><h2>Lifecycle workflow</h2>
      <ol>
        <li>Save safe service metadata.</li>
        <li>Encrypt the client-owned credential bundle with AES-256-GCM and client/environment/service/provider AAD.</li>
        <li>Run a bounded write, head verification, and cleanup test.</li>
        <li>Expose the service to configuration only after status becomes ready.</li>
        <li>Block activation when readiness or required capabilities no longer match.</li>
        <li>Disable or archive only after dependency checks pass.</li>
      </ol>
    </section>
  </main>`);
}

export function storageServiceActivityPage(
  account: Readonly<StorageServiceAccountView>,
  service: Readonly<StorageServiceSnapshot>,
  activity: readonly Readonly<StorageServiceActivityEvent>[],
): string {
  const content = activity.length === 0
    ? '<p class="state-message">No safe activity events are recorded for this service.</p>'
    : `<div class="table-scroll"><table><thead><tr><th>Time</th><th>Event</th><th>Safe summary</th></tr></thead><tbody>${activity.map((event) => `<tr>
      <td>${formatDate(event.createdAt)}</td><th scope="row">${escapeHtml(event.eventType)}</th><td><code>${escapeHtml(JSON.stringify(event.safeSummary))}</code></td>
    </tr>`).join('')}</tbody></table></div>`;
  return controlPage('Storage service activity', `<main>
    ${serviceHeader(account, service)}${tabs(service, 'activity')}
    <section class="panel stack"><h2>Safe activity</h2>${content}</section>
  </main>`);
}
