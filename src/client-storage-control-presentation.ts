import type {
  ClientStorageEnvironment,
  ClientStorageOverview,
  ConfigurationVersionSnapshot,
  IntegrationTokenMetadata,
} from './client-storage-configuration.js';
import { clientStorageControlClientScript } from './client-storage-control-client.js';
import { controlPage, escapeHtml } from './storage-control-html.js';

export interface ClientStorageControlAccountView {
  readonly clientId: string;
  readonly displayLabel: string;
}

function environmentNavigation(
  environment: ClientStorageEnvironment,
  path = '/client/storage',
): string {
  const items: readonly Readonly<{
    value: ClientStorageEnvironment;
    label: string;
  }>[] = [
    { value: 'dev', label: 'Dev' },
    { value: 'staging', label: 'Staging' },
    { value: 'prod', label: 'Production' },
  ];
  return `<nav class="environment-nav" aria-label="Storage environment">
    <span class="environment-nav-label">Environment</span>
    ${items.map((item) => `<a href="${path}?environment=${item.value}"${
      environment === item.value ? ' aria-current="page"' : ''
    }>${item.label}</a>`).join('')}
  </nav>`;
}

function statusBadge(status: string): string {
  return `<span class="badge" data-status="${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function formatDate(value: string | undefined): string {
  if (value === undefined) return 'Not available';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? escapeHtml(date.toISOString().replace('T', ' ').replace('.000Z', ' UTC'))
    : escapeHtml(value);
}

function pageStatus(): string {
  return '<div id="client-storage-status" class="state-message" role="status" aria-live="polite" tabindex="-1" hidden></div>';
}

function controlDialogs(): string {
  return `<dialog id="client-storage-confirm" aria-labelledby="client-storage-confirm-title">
    <form method="dialog" class="stack">
      <h2 id="client-storage-confirm-title">Confirm action</h2>
      <p data-confirm-message></p>
      <div class="toolbar">
        <button type="button" class="button-secondary" data-confirm-cancel>Cancel</button>
        <button type="button" class="button-primary" data-confirm-accept>Confirm</button>
      </div>
    </form>
  </dialog>
  <dialog id="client-storage-token-reveal" aria-labelledby="client-storage-token-reveal-title">
    <div class="stack">
      <div>
        <p class="caption">Reveal-once bearer secret</p>
        <h2 id="client-storage-token-reveal-title">Store this token now</h2>
      </div>
      <div class="state-message" data-kind="warning">
        <strong>Token ID and bearer token are different.</strong>
        <p>Token ID: <code data-reveal-token-id></code>. The raw bearer token below is returned only for this create or rotate response.</p>
      </div>
      <pre data-raw-token tabindex="-1" aria-label="Raw integration bearer token"></pre>
      <div class="toolbar">
        <button type="button" data-copy-raw-token>Copy bearer token</button>
        <span class="help" data-token-copy-state aria-live="polite"></span>
      </div>
      <label class="option-line">
        <input type="checkbox" data-token-acknowledgement>
        I stored the bearer token in the application secret manager.
      </label>
      <button type="button" class="button-secondary" data-close-token-reveal disabled>Close and clear token</button>
    </div>
  </dialog>`;
}

function activeVersionSummary(overview: Readonly<ClientStorageOverview>): string {
  if (overview.activeVersion === undefined) {
    return `<div class="state-message" data-kind="warning">
      <strong>No active configuration</strong>
      <p>Runtime routing remains on the separately governed existing authority until a valid draft is activated.</p>
    </div>`;
  }
  return `<div class="metric">
    <span class="metric-label">Active version</span>
    <strong>v${overview.activeVersion.versionNumber}</strong>
    ${statusBadge(overview.activeVersion.state)}
    <span class="help">Activated ${formatDate(overview.activeVersion.activatedAt)}</span>
  </div>`;
}

function overviewMetrics(overview: Readonly<ClientStorageOverview>): string {
  return `<div class="metrics" aria-label="Storage configuration summary">
    ${activeVersionSummary(overview)}
    <div class="metric">
      <span class="metric-label">Drafts</span>
      <strong>${overview.draftVersions.length}</strong>
      <span class="help">Editable versions awaiting review</span>
    </div>
    <div class="metric">
      <span class="metric-label">Provider references</span>
      <strong>${overview.providerConnectionCount}</strong>
      <span class="help">Safe references; credentials are never shown</span>
    </div>
    <div class="metric">
      <span class="metric-label">Integration tokens</span>
      <strong>${overview.integrationTokenCount}</strong>
      <span class="help">Metadata count for this environment</span>
    </div>
  </div>`;
}

function draftList(overview: Readonly<ClientStorageOverview>): string {
  if (overview.draftVersions.length === 0) {
    return '<p class="state-message">No draft configurations. Create one to prepare a policy change.</p>';
  }
  return `<div class="table-scroll"><table>
    <thead><tr><th>Version</th><th>Validation</th><th>Updated</th><th>Actions</th></tr></thead>
    <tbody>${overview.draftVersions.map((draft) => `<tr>
      <th scope="row"><a href="/client/storage/configurations/${encodeURIComponent(draft.id)}?environment=${overview.environment}">v${draft.versionNumber}</a></th>
      <td>${statusBadge(draft.validationState)}</td>
      <td>${formatDate(draft.updatedAt)}</td>
      <td><div class="toolbar">
        <a class="button-link" href="/client/storage/configurations/${encodeURIComponent(draft.id)}?environment=${overview.environment}">Open editor</a>
        <button type="button" class="button-secondary" data-clone-version="${escapeHtml(draft.id)}">Clone</button>
      </div></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function tokenRows(tokens: readonly Readonly<IntegrationTokenMetadata>[]): string {
  if (tokens.length === 0) {
    return '<p class="state-message">No integration tokens for this environment.</p>';
  }
  return `<div class="table-scroll"><table>
    <thead><tr><th>Token ID</th><th>Label</th><th>Scopes</th><th>Status</th><th>Expiry</th><th>Actions</th></tr></thead>
    <tbody>${tokens.map((token) => `<tr>
      <th scope="row"><code>${escapeHtml(token.tokenId)}</code></th>
      <td>${escapeHtml(token.displayLabel)}</td>
      <td>${escapeHtml(token.scopes.join(', '))}</td>
      <td>${statusBadge(token.status)}</td>
      <td>${formatDate(token.expiresAt)}</td>
      <td><div class="toolbar">
        <button type="button" class="button-secondary" data-rotate-token="${escapeHtml(token.tokenId)}"${token.status === 'active' ? '' : ' disabled'}>Rotate</button>
        <button type="button" class="button-danger" data-revoke-token="${escapeHtml(token.tokenId)}"${token.status === 'active' ? '' : ' disabled'}>Revoke</button>
      </div></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function tokenCreateForm(environment: ClientStorageEnvironment): string {
  return `<form class="subpanel stack" data-token-create-form>
    <div>
      <h3>Create integration token</h3>
      <p class="help">The token ID is durable metadata. The raw bearer token is revealed once after creation.</p>
    </div>
    <div class="field-grid">
      <label>Token ID
        <input name="tokenId" required pattern="[a-z0-9][a-z0-9._:-]{0,127}" autocomplete="off" placeholder="runtime-writer">
      </label>
      <label>Display label
        <input name="displayLabel" required maxlength="160" autocomplete="off" placeholder="Production runtime writer">
      </label>
      <label>Optional expiry
        <input name="expiresAt" type="datetime-local">
      </label>
    </div>
    <fieldset class="stack">
      <legend>Runtime scopes</legend>
      <label class="option-line"><input type="checkbox" name="scope" value="object:write"> Object write</label>
      <label class="option-line"><input type="checkbox" name="scope" value="object:read"> Object read</label>
      <label class="option-line"><input type="checkbox" name="scope" value="object:manage"> Object manage</label>
    </fieldset>
    <input type="hidden" name="environment" value="${environment}">
    <button type="submit">Create and reveal token once</button>
  </form>`;
}

function validationSummary(version: Readonly<ConfigurationVersionSnapshot>): string {
  if (version.validationErrors.length === 0) {
    return `<div class="state-message" data-kind="${version.validationState === 'valid' ? 'success' : 'info'}">
      <strong>${version.validationState === 'valid' ? 'Server validation passed' : 'No validation errors recorded yet'}</strong>
      <p>Saving the draft runs the authoritative server validation again.</p>
    </div>`;
  }
  return `<div class="state-message" data-kind="error">
    <strong>Resolve these server validation errors:</strong>
    <ul>${version.validationErrors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul>
  </div>`;
}

function versionReadOnlyDetails(version: Readonly<ConfigurationVersionSnapshot>): string {
  return `<div class="metrics" aria-label="Configuration coverage">
    <div class="metric"><span class="metric-label">Provider references</span><strong>${version.providerConnections.length}</strong></div>
    <div class="metric"><span class="metric-label">Vaults</span><strong>${version.vaults.length}</strong></div>
    <div class="metric"><span class="metric-label">Routes</span><strong>${version.routes.length}</strong></div>
    <div class="metric"><span class="metric-label">Image presets</span><strong>${version.imagePresets.length}</strong></div>
  </div>
  <section class="panel stack" aria-labelledby="read-only-policy-title">
    <div class="section-heading">
      <div><p class="caption">Immutable policy</p><h2 id="read-only-policy-title">Configuration contents</h2></div>
      ${statusBadge(version.state)}
    </div>
    <div class="card-grid">
      ${version.vaults.map((vault) => `<article class="subpanel">
        <h3>${escapeHtml(vault.displayLabel)}</h3>
        <p>${escapeHtml(vault.purpose)} · ${escapeHtml(vault.bucketLabel)}</p>
        <p class="help">Prefix: <code>${escapeHtml(vault.prefixTemplate)}</code></p>
      </article>`).join('') || '<p>No vaults.</p>'}
    </div>
    <div class="table-scroll"><table>
      <thead><tr><th>Asset class</th><th>Route ID</th><th>Ordered targets</th><th>Image preset</th></tr></thead>
      <tbody>${version.routes.map((route) => `<tr>
        <th scope="row">${escapeHtml(route.assetClass)}</th>
        <td><code>${escapeHtml(route.routeId)}</code></td>
        <td>${route.targets.map((target, index) => `${index + 1}. ${escapeHtml(target.role)} → ${escapeHtml(target.vaultId)}`).join('<br>')}</td>
        <td>${route.imagePresetId === undefined ? '—' : escapeHtml(route.imagePresetId)}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </section>`;
}

function activityUnavailable(): string {
  return `<div class="state-message" data-kind="unavailable">
    <strong>Detailed activity is unavailable in the current client API.</strong>
    <p>The existing source records safe audit events, but it does not yet expose a client-scoped read contract. This control center therefore shows configuration and token state without inventing or leaking activity details.</p>
  </div>`;
}

export function clientStorageControlOverviewPage(
  account: Readonly<ClientStorageControlAccountView>,
  overview?: Readonly<ClientStorageOverview>,
): string {
  const content = overview === undefined
    ? `<section class="panel stack" aria-label="Client storage status">
      <h2>Configuration platform unavailable</h2>
      <div class="state-message" data-kind="error">
        <strong>client-storage-configuration-not-configured</strong>
        <p>Your authenticated browser session is active, but configuration persistence is unavailable.</p>
      </div>
    </section>`
    : `${environmentNavigation(overview.environment)}
    <section class="panel stack" aria-labelledby="storage-state-title">
      <div class="section-heading">
        <div><p class="caption">Environment state</p><h2 id="storage-state-title">Storage configuration</h2></div>
        <a class="button-link" href="/client/storage/configuration?environment=${overview.environment}">Open workspace</a>
      </div>
      ${overviewMetrics(overview)}
      <div class="toolbar">
        <button type="button" data-create-draft>${overview.activeVersion === undefined ? 'Create first draft' : 'Clone active into draft'}</button>
        ${overview.activeVersion === undefined ? '' : `<a class="button-link" href="/client/storage/configurations/${encodeURIComponent(overview.activeVersion.id)}?environment=${overview.environment}">Inspect active version</a>`}
      </div>
    </section>
    <section class="panel stack" aria-labelledby="attention-title">
      <div><p class="caption">Safe attention summary</p><h2 id="attention-title">Next actions</h2></div>
      ${overview.draftVersions.length === 0
        ? '<p>No drafts require attention. Clone the active configuration before changing policy.</p>'
        : `<p>${overview.draftVersions.length} draft configuration${overview.draftVersions.length === 1 ? '' : 's'} can be reviewed in the workspace.</p>`}
      <p>Route and vault coverage is available inside each configuration version. Provider-private endpoints, credentials, object keys, and signed URLs are never displayed.</p>
    </section>`;
  const model = overview === undefined
    ? { kind: 'unavailable', environment: 'dev' }
    : {
      kind: 'overview',
      environment: overview.environment,
      activeVersionId: overview.activeVersion?.id,
    };
  return controlPage('Client storage', `<main data-client-storage-control>
  <header>
    <p class="caption">Z-s client storage control center</p>
    <h1>${escapeHtml(account.displayLabel)}</h1>
    <p>Authenticated client: <strong>${escapeHtml(account.clientId)}</strong></p>
  </header>
  ${pageStatus()}
  ${content}
  ${controlDialogs()}
</main>
${clientStorageControlClientScript(model)}`);
}

export function clientStorageControlWorkspacePage(
  account: Readonly<ClientStorageControlAccountView>,
  overview: Readonly<ClientStorageOverview>,
  tokens: readonly Readonly<IntegrationTokenMetadata>[],
  error?: string,
): string {
  const errorBlock = error === undefined
    ? ''
    : `<div class="state-message" data-kind="error"><strong>${escapeHtml(error)}</strong></div>`;
  return controlPage('Storage configuration', `<main data-client-storage-control>
  <header>
    <p class="caption">Z-s client storage control center</p>
    <h1>Configuration workspace</h1>
    <p>${escapeHtml(account.displayLabel)} · ${escapeHtml(overview.environment)}</p>
    ${errorBlock}
  </header>
  ${pageStatus()}
  ${environmentNavigation(overview.environment, '/client/storage/configuration')}
  <section class="panel stack" aria-labelledby="versions-title">
    <div class="section-heading">
      <div><p class="caption">Immutable lifecycle</p><h2 id="versions-title">Configuration versions</h2></div>
      <button type="button" data-create-draft>${overview.activeVersion === undefined ? 'Create draft' : 'Clone active into draft'}</button>
    </div>
    ${overviewMetrics(overview)}
    ${overview.activeVersion === undefined ? '' : `<div class="toolbar">
      <a class="button-link" href="/client/storage/configurations/${encodeURIComponent(overview.activeVersion.id)}?environment=${overview.environment}">Inspect active v${overview.activeVersion.versionNumber}</a>
      <button type="button" class="button-secondary" data-clone-version="${escapeHtml(overview.activeVersion.id)}">Clone active</button>
    </div>`}
    <div class="stack">
      <h3>Drafts</h3>
      ${draftList(overview)}
    </div>
    <div class="state-message" data-kind="unavailable">
      <strong>Historical index gap</strong>
      <p>The existing overview API returns the active version and drafts, but not a superseded-version index. Known active or draft versions remain inspectable and cloneable without changing the API contract.</p>
    </div>
  </section>
  <section class="panel stack" aria-labelledby="tokens-title">
    <div class="section-heading">
      <div><p class="caption">Runtime credentials</p><h2 id="tokens-title">Integration tokens</h2></div>
      <span class="badge">metadata only</span>
    </div>
    ${tokenRows(tokens)}
    ${tokenCreateForm(overview.environment)}
  </section>
  <section class="panel stack" aria-labelledby="activity-title">
    <div><p class="caption">Safe operational context</p><h2 id="activity-title">Activity and health</h2></div>
    ${activityUnavailable()}
  </section>
  <section class="panel stack" aria-labelledby="boundary-title">
    <div><p class="caption">Authorization boundary</p><h2 id="boundary-title">Browser and runtime credentials stay separate</h2></div>
    <p>Browser client sessions manage configuration. Integration tokens authorize scoped runtime object APIs and cannot authorize this workspace.</p>
  </section>
  ${controlDialogs()}
</main>
${clientStorageControlClientScript({
    kind: 'workspace',
    environment: overview.environment,
    activeVersionId: overview.activeVersion?.id,
  })}`);
}

export function clientStorageControlVersionPage(
  account: Readonly<ClientStorageControlAccountView>,
  version: Readonly<ConfigurationVersionSnapshot>,
): string {
  const draft = version.state === 'draft';
  const actions = draft
    ? `<div class="toolbar sticky-actions">
      <button type="button" data-save-draft>Save and validate</button>
      <button type="button" class="button-primary" data-activate-version="${escapeHtml(version.id)}"${version.validationState === 'valid' ? '' : ' disabled'}>Activate valid draft</button>
      <button type="button" class="button-secondary" data-clone-version="${escapeHtml(version.id)}">Clone draft</button>
      <button type="button" class="button-danger" data-discard-version="${escapeHtml(version.id)}">Discard draft</button>
    </div>`
    : `<div class="toolbar">
      <button type="button" data-clone-version="${escapeHtml(version.id)}">Clone into new draft</button>
      <a class="button-link" href="/client/storage/configuration?environment=${version.environment}">Back to workspace</a>
    </div>`;
  const editor = draft
    ? `<section class="panel stack" aria-labelledby="provider-title">
      <div class="section-heading">
        <div><p class="caption">Safe references</p><h2 id="provider-title">Approved provider connections</h2></div>
        <span class="badge">read-only references</span>
      </div>
      <p>Vaults select these references. Raw provider credentials, endpoints, and private connection material are never displayed or accepted.</p>
      <div data-provider-list></div>
    </section>
    <section class="panel stack" aria-labelledby="vault-title">
      <div class="section-heading">
        <div><p class="caption">Logical destinations</p><h2 id="vault-title">Vaults and retention</h2></div>
        <button type="button" class="button-secondary" data-add-vault>Add vault</button>
      </div>
      <div class="stack" data-vault-list></div>
    </section>
    <section class="panel stack" aria-labelledby="route-title">
      <div class="section-heading">
        <div><p class="caption">Provider-neutral routing</p><h2 id="route-title">Image, video, and document routes</h2></div>
        <button type="button" class="button-secondary" data-add-route>Add route</button>
      </div>
      <p>Each route must contain exactly one primary target and may contain ordered replicas.</p>
      <div class="stack" data-route-list></div>
    </section>
    <section class="panel stack" aria-labelledby="preset-title">
      <div class="section-heading">
        <div><p class="caption">Image policy metadata</p><h2 id="preset-title">Image derivative presets</h2></div>
        <button type="button" class="button-secondary" data-add-preset>Add image preset</button>
      </div>
      <div class="stack" data-preset-list></div>
    </section>`
    : versionReadOnlyDetails(version);
  return controlPage(`Configuration version ${version.versionNumber}`, `<main data-client-storage-control>
  <header>
    <p class="caption">Z-s client storage control center</p>
    <h1>Configuration version ${version.versionNumber}</h1>
    <p>${escapeHtml(account.displayLabel)} · ${escapeHtml(version.environment)} · ${statusBadge(version.state)} · ${statusBadge(version.validationState)}</p>
  </header>
  ${pageStatus()}
  ${environmentNavigation(version.environment, '/client/storage/configuration')}
  <section class="panel stack" aria-labelledby="identity-title">
    <div class="section-heading">
      <div><p class="caption">Version identity</p><h2 id="identity-title">Lifecycle and validation</h2></div>
      <span class="help">Updated ${formatDate(version.updatedAt)}</span>
    </div>
    <dl class="definition-list">
      <div><dt>Version</dt><dd>v${version.versionNumber}</dd></div>
      <div><dt>State</dt><dd>${statusBadge(version.state)}</dd></div>
      <div><dt>Validation</dt><dd>${statusBadge(version.validationState)}</dd></div>
      <div><dt>Created</dt><dd>${formatDate(version.createdAt)}</dd></div>
      ${version.activatedAt === undefined ? '' : `<div><dt>Activated</dt><dd>${formatDate(version.activatedAt)}</dd></div>`}
      ${version.supersededAt === undefined ? '' : `<div><dt>Superseded</dt><dd>${formatDate(version.supersededAt)}</dd></div>`}
    </dl>
    <div data-validation-summary tabindex="-1">${validationSummary(version)}</div>
    ${actions}
  </section>
  ${editor}
  <section class="panel stack" aria-labelledby="compare-title">
    <div><p class="caption">Review support</p><h2 id="compare-title">Compare with active version</h2></div>
    <div data-comparison><p class="state-message">Loading safe comparison…</p></div>
  </section>
  ${draft ? actions : ''}
  ${controlDialogs()}
</main>
${clientStorageControlClientScript({
    kind: 'editor',
    environment: version.environment,
    version,
  })}`);
}
