import {
  ClientStorageConfigurationError,
  type ClientStorageConfigurationStore,
  type ClientStorageEnvironment,
  type ClientStorageOverview,
  type ConfigurationDraftDocument,
  type ConfigurationVersionSnapshot,
  type CreateConfigurationDraftInput,
  type IntegrationTokenAuthenticationResult,
  type IntegrationTokenCreationResult,
  type IntegrationTokenMetadata,
  type IntegrationTokenScope,
  type ProviderConnectionInput,
} from './client-storage-configuration.js';

export interface ConfigurationActivationPolicy {
  assertAllowed(
    clientId: string,
    environment: ClientStorageEnvironment,
    version: Readonly<ConfigurationVersionSnapshot>,
  ): Promise<void>;
}

function publicConnection(
  connection: Readonly<ProviderConnectionInput>,
): ProviderConnectionInput {
  return Object.freeze({
    connectionId: connection.connectionId,
    displayLabel: connection.displayLabel,
    providerType: connection.providerType,
    secretReferenceId: '',
    safeMetadata: Object.freeze({ ...(connection.safeMetadata ?? {}) }),
  });
}

export function publicConfigurationVersion(
  version: Readonly<ConfigurationVersionSnapshot>,
): Readonly<ConfigurationVersionSnapshot> {
  return Object.freeze({
    ...version,
    providerConnections: Object.freeze(version.providerConnections.map(publicConnection)),
  });
}

function preserveConnectionAuthority(
  current: Readonly<ConfigurationVersionSnapshot>,
  input: Readonly<ConfigurationDraftDocument>,
): Readonly<ConfigurationDraftDocument> {
  const existing = new Map(current.providerConnections.map((connection) => [
    connection.connectionId,
    connection,
  ]));
  return Object.freeze({
    ...input,
    providerConnections: Object.freeze(input.providerConnections.map((connection) => {
      const authority = existing.get(connection.connectionId);
      if (connection.secretReferenceId.trim() !== '') return connection;
      if (authority === undefined) return connection;
      return Object.freeze({
        ...connection,
        secretReferenceId: authority.secretReferenceId,
        safeMetadata: Object.freeze({
          ...(authority.safeMetadata ?? {}),
          ...(connection.safeMetadata ?? {}),
        }),
      });
    })),
  });
}

export class SafeClientStorageConfigurationStore
implements ClientStorageConfigurationStore {
  readonly configured: boolean;
  readonly #store: ClientStorageConfigurationStore;
  readonly #activationPolicy: ConfigurationActivationPolicy | undefined;

  constructor(
    store: ClientStorageConfigurationStore,
    activationPolicy?: ConfigurationActivationPolicy,
  ) {
    this.#store = store;
    this.#activationPolicy = activationPolicy;
    this.configured = store.configured;
  }

  overview(
    clientId: string,
    environment: ClientStorageEnvironment,
  ): Promise<Readonly<ClientStorageOverview>> {
    return this.#store.overview(clientId, environment);
  }

  async createDraft(
    clientId: string,
    input: Readonly<CreateConfigurationDraftInput>,
    now?: Date,
    clonedFromVersionId?: string,
  ): Promise<Readonly<ConfigurationVersionSnapshot>> {
    return publicConfigurationVersion(
      await this.#store.createDraft(clientId, input, now, clonedFromVersionId),
    );
  }

  async readVersion(
    clientId: string,
    environment: ClientStorageEnvironment,
    versionId: string,
  ): Promise<Readonly<ConfigurationVersionSnapshot>> {
    return publicConfigurationVersion(
      await this.#store.readVersion(clientId, environment, versionId),
    );
  }

  async replaceDraft(
    clientId: string,
    environment: ClientStorageEnvironment,
    versionId: string,
    input: Readonly<ConfigurationDraftDocument>,
    now?: Date,
  ): Promise<Readonly<ConfigurationVersionSnapshot>> {
    const current = await this.#store.readVersion(clientId, environment, versionId);
    const result = await this.#store.replaceDraft(
      clientId,
      environment,
      versionId,
      preserveConnectionAuthority(current, input),
      now,
    );
    return publicConfigurationVersion(result);
  }

  deleteDraft(
    clientId: string,
    environment: ClientStorageEnvironment,
    versionId: string,
  ): Promise<void> {
    return this.#store.deleteDraft(clientId, environment, versionId);
  }

  async activateDraft(
    clientId: string,
    environment: ClientStorageEnvironment,
    versionId: string,
    now?: Date,
  ): Promise<Readonly<ConfigurationVersionSnapshot>> {
    const version = await this.#store.readVersion(clientId, environment, versionId);
    try {
      await this.#activationPolicy?.assertAllowed(clientId, environment, version);
    } catch (error) {
      if (error !== null && typeof error === 'object') {
        const candidate = error as Record<string, unknown>;
        if (typeof candidate.status === 'number' && typeof candidate.code === 'string') {
          throw new ClientStorageConfigurationError(candidate.status, candidate.code);
        }
      }
      throw error;
    }
    return publicConfigurationVersion(
      await this.#store.activateDraft(clientId, environment, versionId, now),
    );
  }

  async cloneVersion(
    clientId: string,
    environment: ClientStorageEnvironment,
    versionId: string,
    now?: Date,
  ): Promise<Readonly<ConfigurationVersionSnapshot>> {
    return publicConfigurationVersion(
      await this.#store.cloneVersion(clientId, environment, versionId, now),
    );
  }

  listIntegrationTokens(
    clientId: string,
    environment: ClientStorageEnvironment,
    now?: Date,
  ): Promise<readonly Readonly<IntegrationTokenMetadata>[]> {
    return this.#store.listIntegrationTokens(clientId, environment, now);
  }

  createIntegrationToken(
    clientId: string,
    input: Readonly<{
      environment: ClientStorageEnvironment;
      tokenId: string;
      displayLabel: string;
      scopes: readonly IntegrationTokenScope[];
      expiresAt?: Date;
    }>,
    now?: Date,
  ): Promise<Readonly<IntegrationTokenCreationResult>> {
    return this.#store.createIntegrationToken(clientId, input, now);
  }

  rotateIntegrationToken(
    clientId: string,
    environment: ClientStorageEnvironment,
    tokenId: string,
    now?: Date,
  ): Promise<Readonly<IntegrationTokenCreationResult>> {
    return this.#store.rotateIntegrationToken(clientId, environment, tokenId, now);
  }

  revokeIntegrationToken(
    clientId: string,
    environment: ClientStorageEnvironment,
    tokenId: string,
    now?: Date,
  ): Promise<Readonly<IntegrationTokenMetadata>> {
    return this.#store.revokeIntegrationToken(clientId, environment, tokenId, now);
  }

  authenticateIntegrationToken(
    token: string,
    requiredScope?: IntegrationTokenScope,
    now?: Date,
  ): Promise<Readonly<IntegrationTokenAuthenticationResult>> {
    return this.#store.authenticateIntegrationToken(token, requiredScope, now);
  }
}
