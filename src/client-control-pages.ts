import type {
  ClientStorageOverview,
  ConfigurationVersionSnapshot,
  IntegrationTokenMetadata,
} from './client-storage-configuration.js';
import {
  clientStorageControlOverviewPage,
  clientStorageControlVersionPage,
  clientStorageControlWorkspacePage,
  type ClientStorageControlAccountView,
} from './client-storage-control-presentation.js';
import { controlPage, escapeHtml } from './storage-control-html.js';

export interface ClientAccountView extends ClientStorageControlAccountView {}

export function clientLoginPage(configured: boolean, error?: string): string {
  const status = configured
    ? '<p>Use the client account credential to open the client storage surface.</p>'
    : '<p class="state-message" data-kind="error">client-login-not-configured</p>';
  const errorBlock = error === undefined
    ? ''
    : `<p class="state-message" data-kind="error">${escapeHtml(error)}</p>`;
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
  return clientStorageControlOverviewPage(account, overview);
}

export function clientStorageConfigurationPage(
  account: Readonly<ClientAccountView>,
  overview: Readonly<ClientStorageOverview>,
  tokens: readonly Readonly<IntegrationTokenMetadata>[],
  error?: string,
): string {
  return clientStorageControlWorkspacePage(account, overview, tokens, error);
}

export function clientConfigurationVersionPage(
  account: Readonly<ClientAccountView>,
  version: Readonly<ConfigurationVersionSnapshot>,
): string {
  return clientStorageControlVersionPage(account, version);
}
