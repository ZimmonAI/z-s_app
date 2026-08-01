import { controlPage, escapeHtml } from './storage-control-html.js';

export interface ClientAccountView {
  readonly clientId: string;
  readonly displayLabel: string;
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

export function clientStoragePage(account: Readonly<ClientAccountView>): string {
  return controlPage('Client storage', `<main>
  <header>
    <p class="caption">Z-s client storage</p>
    <h1>${escapeHtml(account.displayLabel)}</h1>
    <p>Authenticated client: <strong>${escapeHtml(account.clientId)}</strong></p>
  </header>
  <section class="panel stack" aria-label="Client storage status">
    <h2>Storage access</h2>
    <p>Your client browser session is active. Scoped storage editing is not enabled in this MVP.</p>
  </section>
</main>`);
}
