export type StorageServiceClientModel = Readonly<
  | { kind: 'create' }
  | { kind: 'detail' | 'setup'; environment: string; serviceId: string }
>;

export function storageServiceClientScript(model: StorageServiceClientModel): string {
  return `<script type="module">
const model = ${JSON.stringify(model)};
const statusNode = document.querySelector('#storage-service-status');

function setStatus(message, kind = 'info') {
  if (!(statusNode instanceof HTMLElement)) return;
  statusNode.hidden = false;
  statusNode.dataset.kind = kind;
  statusNode.textContent = message;
  statusNode.focus();
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { accept: 'application/json', ...(init.headers || {}) },
    credentials: 'same-origin',
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const code = body && body.error && body.error.code || 'storage-service-request-failed';
    throw new Error(code);
  }
  return body;
}

function secretInput(form) {
  const data = new FormData(form);
  return {
    accountId: String(data.get('accountId') || ''),
    accessKeyId: String(data.get('accessKeyId') || ''),
    secretAccessKey: String(data.get('secretAccessKey') || ''),
    bucket: String(data.get('bucket') || ''),
  };
}

function testScope(form) {
  return { prefix: String(new FormData(form).get('prefix') || '') };
}

const createForm = document.querySelector('[data-storage-service-create-form]');
if (createForm instanceof HTMLFormElement) {
  createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(createForm);
    setStatus('Encrypting, testing, and saving storage service…', 'loading');
    try {
      const body = await requestJson('/client/storage/services', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          serviceId: String(data.get('serviceId') || ''),
          environment: String(data.get('environment') || 'dev'),
          displayName: String(data.get('displayName') || ''),
          providerType: String(data.get('providerType') || ''),
          safeMetadata: { accountLabel: String(data.get('accountLabel') || '') },
          secretInput: secretInput(createForm),
          testScope: testScope(createForm),
        }),
      });
      createForm.reset();
      location.assign('/client/storage/services/' + encodeURIComponent(body.result.serviceId)
        + '?environment=' + encodeURIComponent(body.result.environment));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'storage-service-request-failed', 'error');
    }
  });
}

const replaceForm = document.querySelector('[data-storage-service-replace-form]');
if (replaceForm instanceof HTMLFormElement && model.kind === 'setup') {
  replaceForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus('Replacing encrypted secret and retesting…', 'loading');
    try {
      await requestJson('/client/storage/services/' + encodeURIComponent(model.serviceId)
        + '/secret?environment=' + encodeURIComponent(model.environment), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          secretInput: secretInput(replaceForm),
          testScope: testScope(replaceForm),
        }),
      });
      replaceForm.reset();
      setStatus('Secret replaced and connection test completed.', 'success');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'storage-service-request-failed', 'error');
    }
  });
}

async function detailAction(suffix, method, success) {
  if (model.kind !== 'detail') return;
  setStatus('Applying storage service action…', 'loading');
  try {
    const body = await requestJson('/client/storage/services/' + encodeURIComponent(model.serviceId)
      + suffix + '?environment=' + encodeURIComponent(model.environment), {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ testScope: { prefix: 'z-s-connection-test' } }),
    });
    if (suffix === '/configuration-drafts') {
      location.assign('/client/storage/configurations/' + encodeURIComponent(body.result.versionId)
        + '?environment=' + encodeURIComponent(model.environment));
      return;
    }
    setStatus(success, 'success');
    location.reload();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'storage-service-request-failed', 'error');
  }
}

document.querySelector('[data-service-test]')?.addEventListener('click', () =>
  detailAction('/test', 'POST', 'Connection test completed.'));
document.querySelector('[data-service-create-draft]')?.addEventListener('click', () =>
  detailAction('/configuration-drafts', 'POST', 'Configuration draft created.'));
document.querySelector('[data-service-disable]')?.addEventListener('click', () =>
  detailAction('/disable', 'POST', 'Storage service disabled.'));
document.querySelector('[data-service-archive]')?.addEventListener('click', () =>
  detailAction('/archive', 'POST', 'Storage service archived.'));
</script>`;
}
