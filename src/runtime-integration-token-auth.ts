import type {
  ClientStorageConfigurationStore,
  ClientStorageEnvironment,
  IntegrationTokenScope,
} from './client-storage-configuration.js';
import type { SafeDiagnosticCategory } from './runtime-contract.js';

export interface RuntimeIntegrationPrincipal {
  clientId: string;
  environment: ClientStorageEnvironment;
  tokenId: string;
  scopes: readonly IntegrationTokenScope[];
}

export class RuntimeIntegrationTokenAuthenticationError extends Error {
  readonly category: SafeDiagnosticCategory;
  readonly code: string;
  readonly status: 401 | 403;
  readonly retryable = false;

  constructor(category: SafeDiagnosticCategory, code: string, status: 401 | 403) {
    super(code);
    this.name = 'RuntimeIntegrationTokenAuthenticationError';
    this.category = category;
    this.code = code;
    this.status = status;
  }
}

export interface RuntimeIntegrationTokenAuthenticator {
  authenticate(
    token: string,
    requiredScope?: IntegrationTokenScope,
    now?: Date,
  ): Promise<Readonly<RuntimeIntegrationPrincipal>>;
}

export class ConfigurationStoreRuntimeIntegrationTokenAuthenticator
implements RuntimeIntegrationTokenAuthenticator {
  readonly #store: ClientStorageConfigurationStore;

  constructor(store: ClientStorageConfigurationStore) {
    this.#store = store;
  }

  async authenticate(
    token: string,
    requiredScope?: IntegrationTokenScope,
    now = new Date(),
  ): Promise<Readonly<RuntimeIntegrationPrincipal>> {
    const result = await this.#store.authenticateIntegrationToken(token, requiredScope, now);
    if (result.kind === 'client-disabled') {
      throw new RuntimeIntegrationTokenAuthenticationError(
        'unauthorized',
        'integration-token-client-disabled',
        403,
      );
    }
    if (result.kind === 'scope-denied') {
      throw new RuntimeIntegrationTokenAuthenticationError(
        'unauthorized',
        'integration-token-scope-denied',
        403,
      );
    }
    if (result.kind !== 'authenticated') {
      throw new RuntimeIntegrationTokenAuthenticationError(
        'unauthenticated',
        'integration-token-invalid',
        401,
      );
    }
    return Object.freeze({
      clientId: result.clientId,
      environment: result.environment,
      tokenId: result.tokenId,
      scopes: Object.freeze([...result.scopes]),
    });
  }
}

export function requireRuntimeIntegrationScope(
  principal: Readonly<RuntimeIntegrationPrincipal>,
  requiredScope: IntegrationTokenScope,
): void {
  if (!principal.scopes.includes(requiredScope)) {
    throw new RuntimeIntegrationTokenAuthenticationError(
      'unauthorized',
      'integration-token-scope-denied',
      403,
    );
  }
}
