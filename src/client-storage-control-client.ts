function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

const CLIENT_STORAGE_CONTROL_SCRIPT = String.raw`
(() => {
  'use strict';

  const dataNode = document.getElementById('client-storage-control-data');
  const root = document.querySelector('[data-client-storage-control]');
  if (!(dataNode instanceof HTMLScriptElement) || !(root instanceof HTMLElement)) return;

  const model = JSON.parse(dataNode.textContent || '{}');
  const environment = String(model.environment || 'dev');
  const statusNode = document.getElementById('client-storage-status');
  const confirmDialog = document.getElementById('client-storage-confirm');
  const revealDialog = document.getElementById('client-storage-token-reveal');
  let pendingConfirmation = null;
  let reloadAfterReveal = false;

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function setStatus(message, kind) {
    if (!(statusNode instanceof HTMLElement)) return;
    statusNode.textContent = message;
    statusNode.dataset.kind = kind || 'info';
    statusNode.hidden = false;
    statusNode.focus({ preventScroll: true });
  }

  function clearStatus() {
    if (!(statusNode instanceof HTMLElement)) return;
    statusNode.textContent = '';
    statusNode.hidden = true;
    delete statusNode.dataset.kind;
  }

  async function requestJson(url, options) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
    });
    if (response.status === 204) return undefined;
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : undefined;
    if (!response.ok) {
      const code = body && body.error && body.error.code
        ? String(body.error.code)
        : 'request-failed';
      const error = new Error(code);
      error.code = code;
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function configurationUrl(versionId, action) {
    const suffix = action ? '/' + encodeURIComponent(action) : '';
    return '/client/storage/configurations/' + encodeURIComponent(versionId) + suffix
      + '?environment=' + encodeURIComponent(environment);
  }

  function editorUrl(versionId) {
    return configurationUrl(versionId, '');
  }

  function openConfirmation(message, confirmLabel, destructive) {
    if (!(confirmDialog instanceof HTMLDialogElement)) {
      return Promise.resolve(window.confirm(message));
    }
    const messageNode = confirmDialog.querySelector('[data-confirm-message]');
    const confirmButton = confirmDialog.querySelector('[data-confirm-accept]');
    if (messageNode instanceof HTMLElement) messageNode.textContent = message;
    if (confirmButton instanceof HTMLButtonElement) {
      confirmButton.textContent = confirmLabel;
      confirmButton.classList.toggle('button-danger', Boolean(destructive));
      confirmButton.classList.toggle('button-primary', !destructive);
    }
    confirmDialog.showModal();
    if (confirmButton instanceof HTMLButtonElement) confirmButton.focus();
    return new Promise((resolve) => {
      pendingConfirmation = resolve;
    });
  }

  function settleConfirmation(value) {
    if (typeof pendingConfirmation === 'function') pendingConfirmation(value);
    pendingConfirmation = null;
    if (confirmDialog instanceof HTMLDialogElement && confirmDialog.open) confirmDialog.close();
  }

  function revealToken(result, reason) {
    if (!(revealDialog instanceof HTMLDialogElement)) return;
    const tokenNode = revealDialog.querySelector('[data-raw-token]');
    const tokenIdNode = revealDialog.querySelector('[data-reveal-token-id]');
    const acknowledgement = revealDialog.querySelector('[data-token-acknowledgement]');
    const closeButton = revealDialog.querySelector('[data-close-token-reveal]');
    const copyState = revealDialog.querySelector('[data-token-copy-state]');
    if (tokenNode instanceof HTMLElement) tokenNode.textContent = String(result.token || '');
    if (tokenIdNode instanceof HTMLElement) {
      tokenIdNode.textContent = String(result.metadata && result.metadata.tokenId || '');
    }
    if (acknowledgement instanceof HTMLInputElement) acknowledgement.checked = false;
    if (closeButton instanceof HTMLButtonElement) closeButton.disabled = true;
    if (copyState instanceof HTMLElement) copyState.textContent = '';
    reloadAfterReveal = true;
    revealDialog.showModal();
    if (tokenNode instanceof HTMLElement) tokenNode.focus();
    setStatus(reason + ' The raw bearer token is visible only in this dialog.', 'success');
  }

  function closeTokenReveal() {
    if (!(revealDialog instanceof HTMLDialogElement)) return;
    const tokenNode = revealDialog.querySelector('[data-raw-token]');
    if (tokenNode instanceof HTMLElement) tokenNode.textContent = '';
    revealDialog.close();
    if (reloadAfterReveal) window.location.reload();
  }

  async function createDraft() {
    clearStatus();
    setStatus('Creating a configuration draft…', 'loading');
    let body;
    if (model.activeVersionId) {
      body = await requestJson(configurationUrl(String(model.activeVersionId), 'clone'), {
        method: 'POST',
      });
    } else {
      body = await requestJson('/client/storage/configurations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          environment,
          providerConnections: [],
          vaults: [],
          routes: [],
          imagePresets: [],
        }),
      });
    }
    window.location.assign(editorUrl(String(body.result.id)));
  }

  async function cloneVersion(versionId) {
    setStatus('Cloning configuration version…', 'loading');
    const body = await requestJson(configurationUrl(versionId, 'clone'), { method: 'POST' });
    window.location.assign(editorUrl(String(body.result.id)));
  }

  async function activateVersion(versionId) {
    const accepted = await openConfirmation(
      'Activate this valid draft? The current active version will become immutable history.',
      'Activate draft',
      false,
    );
    if (!accepted) return;
    setStatus('Activating configuration version…', 'loading');
    await requestJson(configurationUrl(versionId, 'activate'), { method: 'POST' });
    window.location.assign('/client/storage/configuration?environment=' + encodeURIComponent(environment));
  }

  async function discardVersion(versionId) {
    const accepted = await openConfirmation(
      'Discard this draft permanently? Active and superseded versions cannot be discarded.',
      'Discard draft',
      true,
    );
    if (!accepted) return;
    setStatus('Discarding draft…', 'loading');
    await requestJson(configurationUrl(versionId, ''), { method: 'DELETE' });
    window.location.assign('/client/storage/configuration?environment=' + encodeURIComponent(environment));
  }

  function defaultVault(index) {
    const connection = model.version.providerConnections[0];
    return {
      vaultId: 'vault-' + (index + 1),
      providerConnectionId: connection ? connection.connectionId : '',
      displayLabel: 'Vault ' + (index + 1),
      purpose: 'custom',
      bucketLabel: 'storage-vault-' + (index + 1),
      prefixTemplate: 'storage/vault-' + (index + 1) + '/*',
      retention: { mode: 'permanent' },
    };
  }

  function defaultRoute(index) {
    const vault = model.version.vaults[0];
    const assetClasses = ['image', 'video', 'document'];
    return {
      routeId: 'route-' + (index + 1),
      assetClass: assetClasses[index % assetClasses.length],
      targets: vault ? [{ role: 'primary', vaultId: vault.vaultId }] : [],
    };
  }

  function defaultPreset(index) {
    const vault = model.version.vaults[0];
    return {
      presetId: 'image-preset-' + (index + 1),
      targetVaultId: vault ? vault.vaultId : '',
      widths: [512, 1024],
      outputFormat: 'webp',
      quality: 82,
      fit: 'inside',
    };
  }

  function option(value, label, selected) {
    return '<option value="' + escapeHtml(value) + '"'
      + (selected ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
  }

  function providerOptions(selected) {
    return model.version.providerConnections.map((connection) => option(
      connection.connectionId,
      connection.displayLabel + ' (' + connection.connectionId + ')',
      connection.connectionId === selected,
    )).join('');
  }

  function vaultOptions(selected) {
    return model.version.vaults.map((vault) => option(
      vault.vaultId,
      vault.displayLabel + ' (' + vault.vaultId + ')',
      vault.vaultId === selected,
    )).join('');
  }

  function presetOptions(selected) {
    return '<option value="">No image preset</option>' + model.version.imagePresets.map((preset) => option(
      preset.presetId,
      preset.presetId,
      preset.presetId === selected,
    )).join('');
  }

  function syncEditorState() {
    if (model.kind !== 'editor' || model.version.state !== 'draft') return;
    const vaults = Array.from(document.querySelectorAll('[data-vault-row]')).map((row) => {
      const retentionMode = row.querySelector('[name="retentionMode"]');
      const deleteAfterDays = row.querySelector('[name="deleteAfterDays"]');
      const retention = retentionMode instanceof HTMLSelectElement && retentionMode.value === 'delete-after-days'
        ? { mode: 'delete-after-days', deleteAfterDays: Number(deleteAfterDays instanceof HTMLInputElement ? deleteAfterDays.value : 0) }
        : { mode: 'permanent' };
      return {
        vaultId: row.querySelector('[name="vaultId"]').value,
        providerConnectionId: row.querySelector('[name="providerConnectionId"]').value,
        displayLabel: row.querySelector('[name="displayLabel"]').value,
        purpose: row.querySelector('[name="purpose"]').value,
        bucketLabel: row.querySelector('[name="bucketLabel"]').value,
        prefixTemplate: row.querySelector('[name="prefixTemplate"]').value,
        retention,
      };
    });
    const routes = Array.from(document.querySelectorAll('[data-route-row]')).map((row) => {
      const imagePresetId = row.querySelector('[name="imagePresetId"]').value;
      const targets = Array.from(row.querySelectorAll('[data-target-row]')).map((targetRow) => ({
        role: targetRow.querySelector('[name="targetRole"]').value,
        vaultId: targetRow.querySelector('[name="targetVaultId"]').value,
      }));
      return {
        routeId: row.querySelector('[name="routeId"]').value,
        assetClass: row.querySelector('[name="assetClass"]').value,
        targets,
        ...(imagePresetId ? { imagePresetId } : {}),
      };
    });
    const imagePresets = Array.from(document.querySelectorAll('[data-preset-row]')).map((row) => ({
      presetId: row.querySelector('[name="presetId"]').value,
      targetVaultId: row.querySelector('[name="targetVaultId"]').value,
      widths: row.querySelector('[name="widths"]').value.split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value)),
      outputFormat: row.querySelector('[name="outputFormat"]').value,
      quality: Number(row.querySelector('[name="quality"]').value),
      fit: row.querySelector('[name="fit"]').value,
    }));
    model.version.vaults = vaults;
    model.version.routes = routes;
    model.version.imagePresets = imagePresets;
  }

  function renderProviders() {
    const container = document.querySelector('[data-provider-list]');
    if (!(container instanceof HTMLElement)) return;
    if (model.version.providerConnections.length === 0) {
      container.innerHTML = '<div class="state-message" data-kind="unavailable">'
        + '<strong>No approved provider references are available in this draft.</strong>'
        + '<p>Clone an active or historical configuration to reuse approved references. Provider credential onboarding remains outside this workspace.</p>'
        + '</div>';
      return;
    }
    container.innerHTML = '<div class="card-grid">' + model.version.providerConnections.map((connection) => (
      '<article class="subpanel">'
      + '<h3>' + escapeHtml(connection.displayLabel) + '</h3>'
      + '<p><span class="badge">' + escapeHtml(connection.providerType) + '</span></p>'
      + '<dl class="definition-list"><div><dt>Connection ID</dt><dd><code>'
      + escapeHtml(connection.connectionId) + '</code></dd></div></dl>'
      + '</article>'
    )).join('') + '</div>';
  }

  function renderVaults() {
    const container = document.querySelector('[data-vault-list]');
    if (!(container instanceof HTMLElement)) return;
    if (model.version.vaults.length === 0) {
      container.innerHTML = '<p class="state-message">No logical vaults in this draft.</p>';
      return;
    }
    container.innerHTML = model.version.vaults.map((vault, index) => {
      const retentionMode = vault.retention && vault.retention.mode || 'permanent';
      const deleteAfterDays = retentionMode === 'delete-after-days' ? vault.retention.deleteAfterDays : '';
      return '<fieldset class="subpanel stack" data-vault-row data-index="' + index + '">'
        + '<legend>Vault ' + (index + 1) + '</legend>'
        + '<div class="field-grid">'
        + '<label>Vault ID<input name="vaultId" value="' + escapeHtml(vault.vaultId) + '" required pattern="[a-z0-9][a-z0-9._:-]{0,127}"></label>'
        + '<label>Display label<input name="displayLabel" value="' + escapeHtml(vault.displayLabel) + '" required maxlength="160"></label>'
        + '<label>Approved provider reference<select name="providerConnectionId" required>' + providerOptions(vault.providerConnectionId) + '</select></label>'
        + '<label>Purpose<select name="purpose">'
        + ['originals', 'hot-copy', 'derivatives', 'archive', 'custom'].map((value) => option(value, value, value === vault.purpose)).join('')
        + '</select></label>'
        + '<label>Safe bucket label<input name="bucketLabel" value="' + escapeHtml(vault.bucketLabel) + '" required maxlength="255"></label>'
        + '<label>Prefix template<input name="prefixTemplate" value="' + escapeHtml(vault.prefixTemplate) + '" required aria-describedby="prefix-help-' + index + '"></label>'
        + '<p class="help" id="prefix-help-' + index + '">Relative prefix ending in <code>/*</code>; provider-private object keys are never shown.</p>'
        + '<label>Retention<select name="retentionMode">'
        + option('permanent', 'Permanent', retentionMode === 'permanent')
        + option('delete-after-days', 'Delete after days', retentionMode === 'delete-after-days')
        + '</select></label>'
        + '<label>Delete after days<input name="deleteAfterDays" type="number" min="1" max="36500" value="' + escapeHtml(deleteAfterDays) + '"></label>'
        + '</div>'
        + '<button type="button" class="button-secondary" data-remove-vault="' + index + '">Remove vault</button>'
        + '</fieldset>';
    }).join('');
  }

  function renderTargets(route, routeIndex) {
    if (route.targets.length === 0) {
      return '<p class="state-message" data-kind="warning">Add exactly one primary target before activation.</p>';
    }
    return route.targets.map((target, targetIndex) => (
      '<div class="target-row" data-target-row data-target-index="' + targetIndex + '">'
      + '<label>Role<select name="targetRole">'
      + option('primary', 'Primary', target.role === 'primary')
      + option('replica', 'Replica', target.role === 'replica')
      + '</select></label>'
      + '<label>Vault<select name="targetVaultId" required>' + vaultOptions(target.vaultId) + '</select></label>'
      + '<div class="toolbar" aria-label="Target order controls">'
      + '<button type="button" class="button-secondary" data-move-target-up="' + routeIndex + ':' + targetIndex + '"' + (targetIndex === 0 ? ' disabled' : '') + '>Move up</button>'
      + '<button type="button" class="button-secondary" data-move-target-down="' + routeIndex + ':' + targetIndex + '"' + (targetIndex === route.targets.length - 1 ? ' disabled' : '') + '>Move down</button>'
      + '<button type="button" class="button-secondary" data-remove-target="' + routeIndex + ':' + targetIndex + '">Remove</button>'
      + '</div>'
      + '</div>'
    )).join('');
  }

  function renderRoutes() {
    const container = document.querySelector('[data-route-list]');
    if (!(container instanceof HTMLElement)) return;
    if (model.version.routes.length === 0) {
      container.innerHTML = '<p class="state-message">No image, video, or document routes in this draft.</p>';
      return;
    }
    container.innerHTML = model.version.routes.map((route, index) => (
      '<fieldset class="subpanel stack" data-route-row data-index="' + index + '">'
      + '<legend>Route ' + (index + 1) + '</legend>'
      + '<div class="field-grid">'
      + '<label>Route ID<input name="routeId" value="' + escapeHtml(route.routeId) + '" required></label>'
      + '<label>Asset class<select name="assetClass">'
      + ['image', 'video', 'document'].map((value) => option(value, value, value === route.assetClass)).join('')
      + '</select></label>'
      + '<label>Image derivative preset<select name="imagePresetId">' + presetOptions(route.imagePresetId || '') + '</select></label>'
      + '</div>'
      + '<div class="stack" aria-label="Ordered route targets">' + renderTargets(route, index) + '</div>'
      + '<div class="toolbar">'
      + '<button type="button" class="button-secondary" data-add-target="' + index + '">Add target</button>'
      + '<button type="button" class="button-secondary" data-remove-route="' + index + '">Remove route</button>'
      + '</div>'
      + '</fieldset>'
    )).join('');
  }

  function renderPresets() {
    const container = document.querySelector('[data-preset-list]');
    if (!(container instanceof HTMLElement)) return;
    if (model.version.imagePresets.length === 0) {
      container.innerHTML = '<p class="state-message">No image derivative presets in this draft.</p>';
      return;
    }
    container.innerHTML = model.version.imagePresets.map((preset, index) => (
      '<fieldset class="subpanel stack" data-preset-row data-index="' + index + '">'
      + '<legend>Image preset ' + (index + 1) + '</legend>'
      + '<div class="field-grid">'
      + '<label>Preset ID<input name="presetId" value="' + escapeHtml(preset.presetId) + '" required></label>'
      + '<label>Target vault<select name="targetVaultId" required>' + vaultOptions(preset.targetVaultId) + '</select></label>'
      + '<label>Widths<input name="widths" value="' + escapeHtml(preset.widths.join(', ')) + '" aria-describedby="width-help-' + index + '" required></label>'
      + '<p class="help" id="width-help-' + index + '">Comma-separated widths from 16 to 16384 pixels.</p>'
      + '<label>Output format<select name="outputFormat">'
      + ['webp', 'avif', 'jpeg', 'png'].map((value) => option(value, value, value === preset.outputFormat)).join('')
      + '</select></label>'
      + '<label>Quality<input name="quality" type="number" min="1" max="100" value="' + escapeHtml(preset.quality) + '" required></label>'
      + '<label>Fit<select name="fit">'
      + ['inside', 'cover', 'contain', 'fill'].map((value) => option(value, value, value === preset.fit)).join('')
      + '</select></label>'
      + '</div>'
      + '<button type="button" class="button-secondary" data-remove-preset="' + index + '">Remove preset</button>'
      + '</fieldset>'
    )).join('');
  }

  function renderEditor() {
    if (model.kind !== 'editor') return;
    renderProviders();
    if (model.version.state === 'draft') {
      renderVaults();
      renderRoutes();
      renderPresets();
    }
  }

  function comparisonItems(current, active) {
    const sections = [
      ['Provider references', current.providerConnections, active.providerConnections, 'connectionId'],
      ['Vaults', current.vaults, active.vaults, 'vaultId'],
      ['Routes', current.routes, active.routes, 'routeId'],
      ['Image presets', current.imagePresets, active.imagePresets, 'presetId'],
    ];
    return sections.map(([label, left, right, key]) => {
      const leftIds = new Set(left.map((item) => item[key]));
      const rightIds = new Set(right.map((item) => item[key]));
      const added = Array.from(leftIds).filter((id) => !rightIds.has(id));
      const removed = Array.from(rightIds).filter((id) => !leftIds.has(id));
      return { label, current: left.length, active: right.length, added, removed };
    });
  }

  async function loadComparison() {
    const container = document.querySelector('[data-comparison]');
    if (!(container instanceof HTMLElement) || model.kind !== 'editor') return;
    if (model.version.state !== 'draft') {
      container.innerHTML = '<p>This immutable version is available for inspection and cloning.</p>';
      return;
    }
    try {
      const overviewBody = await requestJson('/client/storage/configurations?environment=' + encodeURIComponent(environment));
      const active = overviewBody.result.activeVersion;
      if (!active) {
        container.innerHTML = '<p>No active version exists. This draft would become the first active configuration.</p>';
        return;
      }
      const activeBody = await requestJson(configurationUrl(String(active.id), ''));
      const items = comparisonItems(model.version, activeBody.result);
      container.innerHTML = '<div class="table-scroll"><table><thead><tr><th>Section</th><th>Draft</th><th>Active</th><th>Changed identities</th></tr></thead><tbody>'
        + items.map((item) => '<tr><th scope="row">' + escapeHtml(item.label) + '</th><td>' + item.current + '</td><td>' + item.active + '</td><td>'
          + (item.added.length ? 'Added: ' + escapeHtml(item.added.join(', ')) + '. ' : '')
          + (item.removed.length ? 'Removed: ' + escapeHtml(item.removed.join(', ')) + '.' : '')
          + (!item.added.length && !item.removed.length ? 'Same identities; field values may still differ.' : '')
          + '</td></tr>').join('')
        + '</tbody></table></div>';
    } catch (error) {
      container.innerHTML = '<p class="state-message" data-kind="error">Comparison unavailable: '
        + escapeHtml(error.code || error.message) + '</p>';
    }
  }

  async function saveDraft() {
    syncEditorState();
    setStatus('Saving and validating draft…', 'loading');
    const body = await requestJson(configurationUrl(String(model.version.id), ''), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providerConnections: model.version.providerConnections,
        vaults: model.version.vaults,
        routes: model.version.routes,
        imagePresets: model.version.imagePresets,
      }),
    });
    model.version = body.result;
    setStatus(
      body.result.validationState === 'valid'
        ? 'Draft saved and server validation passed.'
        : 'Draft saved. Server validation found issues.',
      body.result.validationState === 'valid' ? 'success' : 'warning',
    );
    const validation = document.querySelector('[data-validation-summary]');
    if (validation instanceof HTMLElement) {
      validation.innerHTML = body.result.validationErrors.length === 0
        ? '<p class="state-message" data-kind="success">No validation errors.</p>'
        : '<div class="state-message" data-kind="error"><strong>Resolve these server validation errors:</strong><ul>'
          + body.result.validationErrors.map((error) => '<li>' + escapeHtml(error) + '</li>').join('')
          + '</ul></div>';
      validation.focus();
    }
    await loadComparison();
  }

  async function createToken(form) {
    const data = new FormData(form);
    const scopes = data.getAll('scope').map(String);
    const expiresValue = String(data.get('expiresAt') || '').trim();
    const payload = {
      environment,
      tokenId: String(data.get('tokenId') || ''),
      displayLabel: String(data.get('displayLabel') || ''),
      scopes,
      ...(expiresValue ? { expiresAt: new Date(expiresValue).toISOString() } : {}),
    };
    setStatus('Creating integration token…', 'loading');
    const body = await requestJson('/client/storage/integration-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    revealToken(body.result, 'Integration token created.');
  }

  async function rotateToken(tokenId) {
    const accepted = await openConfirmation(
      'Rotate token ID ' + tokenId + '? The current bearer token will be revoked immediately.',
      'Rotate token',
      false,
    );
    if (!accepted) return;
    setStatus('Rotating integration token…', 'loading');
    const body = await requestJson(
      '/client/storage/integration-tokens/' + encodeURIComponent(tokenId) + '/rotate?environment=' + encodeURIComponent(environment),
      { method: 'POST' },
    );
    revealToken(body.result, 'Integration token rotated.');
  }

  async function revokeToken(tokenId) {
    const accepted = await openConfirmation(
      'Revoke token ID ' + tokenId + '? Runtime calls using its bearer value will stop working.',
      'Revoke token',
      true,
    );
    if (!accepted) return;
    setStatus('Revoking integration token…', 'loading');
    await requestJson(
      '/client/storage/integration-tokens/' + encodeURIComponent(tokenId) + '?environment=' + encodeURIComponent(environment),
      { method: 'DELETE' },
    );
    window.location.reload();
  }

  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.matches('[data-token-create-form]')) {
      event.preventDefault();
      try {
        await createToken(form);
      } catch (error) {
        setStatus('Token creation failed: ' + (error.code || error.message), 'error');
      }
    }
  });

  document.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('button, a');
    if (!(button instanceof HTMLElement)) return;
    try {
      if (button.hasAttribute('data-create-draft')) {
        event.preventDefault();
        await createDraft();
      } else if (button.dataset.cloneVersion) {
        event.preventDefault();
        await cloneVersion(button.dataset.cloneVersion);
      } else if (button.dataset.activateVersion) {
        event.preventDefault();
        await activateVersion(button.dataset.activateVersion);
      } else if (button.dataset.discardVersion) {
        event.preventDefault();
        await discardVersion(button.dataset.discardVersion);
      } else if (button.hasAttribute('data-save-draft')) {
        event.preventDefault();
        await saveDraft();
      } else if (button.hasAttribute('data-add-vault')) {
        syncEditorState();
        model.version.vaults.push(defaultVault(model.version.vaults.length));
        renderVaults();
        renderRoutes();
        renderPresets();
      } else if (button.dataset.removeVault) {
        syncEditorState();
        model.version.vaults.splice(Number(button.dataset.removeVault), 1);
        renderVaults();
        renderRoutes();
        renderPresets();
      } else if (button.hasAttribute('data-add-route')) {
        syncEditorState();
        model.version.routes.push(defaultRoute(model.version.routes.length));
        renderRoutes();
      } else if (button.dataset.removeRoute) {
        syncEditorState();
        model.version.routes.splice(Number(button.dataset.removeRoute), 1);
        renderRoutes();
      } else if (button.hasAttribute('data-add-preset')) {
        syncEditorState();
        model.version.imagePresets.push(defaultPreset(model.version.imagePresets.length));
        renderPresets();
        renderRoutes();
      } else if (button.dataset.removePreset) {
        syncEditorState();
        model.version.imagePresets.splice(Number(button.dataset.removePreset), 1);
        renderPresets();
        renderRoutes();
      } else if (button.dataset.addTarget) {
        syncEditorState();
        const route = model.version.routes[Number(button.dataset.addTarget)];
        const vault = model.version.vaults[0];
        route.targets.push({ role: route.targets.length === 0 ? 'primary' : 'replica', vaultId: vault ? vault.vaultId : '' });
        renderRoutes();
      } else if (button.dataset.removeTarget) {
        syncEditorState();
        const [routeIndex, targetIndex] = button.dataset.removeTarget.split(':').map(Number);
        model.version.routes[routeIndex].targets.splice(targetIndex, 1);
        renderRoutes();
      } else if (button.dataset.moveTargetUp || button.dataset.moveTargetDown) {
        syncEditorState();
        const value = button.dataset.moveTargetUp || button.dataset.moveTargetDown;
        const [routeIndex, targetIndex] = value.split(':').map(Number);
        const direction = button.dataset.moveTargetUp ? -1 : 1;
        const targets = model.version.routes[routeIndex].targets;
        const nextIndex = targetIndex + direction;
        [targets[targetIndex], targets[nextIndex]] = [targets[nextIndex], targets[targetIndex]];
        renderRoutes();
      } else if (button.dataset.rotateToken) {
        event.preventDefault();
        await rotateToken(button.dataset.rotateToken);
      } else if (button.dataset.revokeToken) {
        event.preventDefault();
        await revokeToken(button.dataset.revokeToken);
      } else if (button.hasAttribute('data-confirm-accept')) {
        event.preventDefault();
        settleConfirmation(true);
      } else if (button.hasAttribute('data-confirm-cancel')) {
        event.preventDefault();
        settleConfirmation(false);
      } else if (button.hasAttribute('data-copy-raw-token')) {
        event.preventDefault();
        const tokenNode = revealDialog && revealDialog.querySelector('[data-raw-token]');
        const copyState = revealDialog && revealDialog.querySelector('[data-token-copy-state]');
        const token = tokenNode instanceof HTMLElement ? tokenNode.textContent || '' : '';
        await navigator.clipboard.writeText(token);
        if (copyState instanceof HTMLElement) copyState.textContent = 'Copied. Store it in the application secret manager now.';
      } else if (button.hasAttribute('data-close-token-reveal')) {
        event.preventDefault();
        closeTokenReveal();
      }
    } catch (error) {
      setStatus('Action failed: ' + (error.code || error.message), 'error');
    }
  });

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.hasAttribute('data-token-acknowledgement')) {
      const closeButton = revealDialog && revealDialog.querySelector('[data-close-token-reveal]');
      if (closeButton instanceof HTMLButtonElement) closeButton.disabled = !target.checked;
    }
  });

  if (confirmDialog instanceof HTMLDialogElement) {
    confirmDialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      settleConfirmation(false);
    });
  }
  if (revealDialog instanceof HTMLDialogElement) {
    revealDialog.addEventListener('cancel', (event) => event.preventDefault());
  }

  renderEditor();
  void loadComparison();
})();
`;

export function clientStorageControlClientScript(model: unknown): string {
  return `<script id="client-storage-control-data" type="application/json">${scriptJson(model)}</script>
<script>${CLIENT_STORAGE_CONTROL_SCRIPT}</script>`;
}
