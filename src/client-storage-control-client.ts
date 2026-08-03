import { CLIENT_STORAGE_EDITOR_SCRIPT } from './client-storage-control-editor-client.js';

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

${CLIENT_STORAGE_EDITOR_SCRIPT}

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
        route.targets.push({
          role: route.targets.length === 0 ? 'primary' : 'replica',
          vaultId: vault ? vault.vaultId : '',
        });
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
      } else if (button.dataset.rotateTokenId) {
        event.preventDefault();
        await rotateToken(button.dataset.rotateTokenId);
      } else if (button.dataset.revokeTokenId) {
        event.preventDefault();
        await revokeToken(button.dataset.revokeTokenId);
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
        if (copyState instanceof HTMLElement) {
          copyState.textContent = 'Copied. Store it in the application secret manager now.';
        }
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
