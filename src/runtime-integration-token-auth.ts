import { createHash, timingSafeEqual } from 'node:crypto';
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

const VIDEO_MAKER_COMPATIBILITY_SCOPES = Object.freeze([
  'object:write',
  'object:read',
  'object:manage',
] as const satisfies readonly IntegrationTokenScope[]);

function tokenMatches(received: string, expected: string): boolean {
  const receivedDigest = createHash('sha256').update(received, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(receivedDigest, expectedDigest);
}

function videoMakerCompatibilityPrincipal(
  token: string,
  requiredScope: IntegrationTokenScope | undefined,
): Readonly<RuntimeIntegrationPrincipal> | null {
  const expected = process.env.Z_S_VIDEO_MAKER_BEARER_TOKEN?.trim();
  if (expected === undefined || expected === '' || !tokenMatches(token, expected)) return null;
  if (requiredScope !== undefined && !VIDEO_MAKER_COMPATIBILITY_SCOPES.includes(requiredScope)) {
    return null;
  }
  return Object.freeze({
    clientId: 'video-maker_app',
    environment: 'dev',
    tokenId: 'video-maker-runtime-compatibility',
    scopes: VIDEO_MAKER_COMPATIBILITY_SCOPES,
  });
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
    let result: Awaited<ReturnType<ClientStorageConfigurationStore['authenticateIntegrationToken']>>;
    try {
      result = await this.#store.authenticateIntegrationToken(token, requiredScope, now);
    } catch (error) {
      const compatibility = videoMakerCompatibilityPrincipal(token, requiredScope);
      if (compatibility !== null) return compatibility;
      throw error;
    }
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
      const compatibility = videoMakerCompatibilityPrincipal(token, requiredScope);
      if (compatibility !== null) return compatibility;
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
