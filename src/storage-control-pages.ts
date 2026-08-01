import { controlPage, escapeHtml } from './storage-control-html.js';
import { storagePlannerPage } from './storage-control-planner-page.js';
import type { StorageControlPlan } from './storage-control-plan.js';

export { storagePlannerPage };

export function loginPage(configured: boolean, error?: string): string {
  const status = configured
    ? '<p>Use the operator passphrase to open the storage planner.</p>'
    : '<p class="error">Control login is not configured. Set the control password and session signing key.</p>';
  const errorBlock = error === undefined ? '' : `<p class="error">${escapeHtml(error)}</p>`;
  return controlPage('Z-s storage control', `<main>
  <header>
    <p class="caption">Z-s control plane</p>
    <h1>Z-s storage control</h1>
    ${status}
  </header>
  <form class="panel stack" method="post" action="/admin/session">
    ${errorBlock}
    <label for="operator-passphrase">Operator passphrase<input id="operator-passphrase" name="operatorPassphrase" type="password" autocomplete="new-password" autocapitalize="none" spellcheck="false" required></label>
    <button type="submit"${configured ? '' : ' disabled'}>Open storage planner</button>
  </form>
</main>`);
}

export function storagePlanResultPage(plan: Readonly<StorageControlPlan>): string {
  return controlPage('Storage vault plan result', `<main>
  <header>
    <p class="caption">Safe plan preview</p>
    <h1>Storage vault plan result</h1>
    <p>This preview contains secret-reference identities only. Raw provider endpoints, access keys, env values, and tokens stay outside the page.</p>
  </header>
  <pre>${escapeHtml(JSON.stringify({ result: plan }, null, 2))}</pre>
  <p><a href="/admin/storage">Back to planner</a></p>
</main>`);
}
