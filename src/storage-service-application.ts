import { randomUUID } from 'node:crypto';
import type {
  ClientStorageConfigurationStore,
  ClientStorageEnvironment,
  ConfigurationVersionSnapshot,
} from './client-storage-configuration.js';
import type { ProviderSecretStore } from './provider-secret-store.js';
import {
  StorageProviderAdapterError,
  type StorageProviderAdapterRegistry,
} from './storage-provider-adapter.js';
import {
  StorageServiceError,
  requiredStorageServiceCapabilities,
  storageServiceSecretContext,
  type StorageServiceActivityEvent,
  type StorageServiceDependencySnapshot,
  type StorageServiceListFilter,
  type StorageServiceRepository,
  type StorageServiceSnapshot,
} from './storage-service.js';

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const LABEL_PATTERN = /^.{1,160}$/s;

export class StorageServiceApplicationService {
  readonly #repository: StorageServiceRepository;
  readonly #secrets: ProviderSecretStore;
  readonly #adapters: StorageProviderAdapterRegistry;
  readonly #configurations: ClientStorageConfigurationStore;

  constructor(options: Readonly<{
    repository: StorageServiceRepository;
    secrets: ProviderSecretStore;
    adapters: StorageProviderAdapterRegistry;
    configurations: ClientStorageConfigurationStore;
  }>) {
    this.#repository = options.repository;
    this.#secrets = options.secrets;
    this.#adapters = options.adapters;
    this.#configurations = options.configurations;
  }

  get configured(): boolean {
    return this.#repository.configured && this.#secrets.configured;
  }

  manifests() {
    return this.#adapters.manifests();
  }

  list(
    clientId: string,
    filter: Readonly<StorageServiceListFilter>,
  ): Promise<readonly Readonly<StorageServiceSnapshot>[]> {
    return this.#repository.list(clientId, filter);
  }

  read(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
  ): Promise<Readonly<StorageServiceSnapshot>> {
    return this.#repository.read(clientId, environment, serviceId);
  }

  dependencies(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
  ): Promise<Readonly<StorageServiceDependencySnapshot>> {
    return this.#repository.dependencies(clientId, environment, serviceId);
  }

  activity(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
  ): Promise<readonly Readonly<StorageServiceActivityEvent>[]> {
    return this.#repository.activity(clientId, environment, serviceId);
  }

  async createClientOwned(
    clientId: string,
    input: Readonly<{
      serviceId: string;
      environment: ClientStorageEnvironment;
      displayName: string;
      providerType: string;
      safeMetadata: Readonly<Record<string, unknown>>;
      secretInput: Readonly<Record<string, string>>;
      testScope: Readonly<Record<string, string>>;
    }>,
    now = new Date(),
  ): Promise<Readonly<StorageServiceSnapshot>> {
    if (!this.configured) throw new StorageServiceError(503, 'storage-service-store-not-configured');
    if (!IDENTIFIER_PATTERN.test(input.serviceId) || !LABEL_PATTERN.test(input.displayName)) {
      throw new StorageServiceError(400, 'storage-service-input-invalid');
    }
    const adapter = this.#adapters.get(input.providerType);
    const safeMetadata = adapter.validateSafeSetupMetadata(input.safeMetadata);
    const secretInput = adapter.validateSecretInput(input.secretInput);
    let service = await this.#repository.create({
      id: randomUUID(),
      serviceId: input.serviceId,
      clientId,
      environment: input.environment,
      displayName: input.displayName,
      providerType: input.providerType,
      ownership: 'client-owned',
      safeMetadata,
      capabilities: adapter.getProviderManifest().capabilities,
    }, now);
    const secretId = await this.#secrets.store(storageServiceSecretContext(service), secretInput, now);
    await this.#repository.bindSecret(
      clientId,
      input.environment,
      input.serviceId,
      secretId,
      now,
    );
    service = await this.test(clientId, input.environment, input.serviceId, input.testScope, now);
    return service;
  }

  async test(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
    testScope: Readonly<Record<string, string>>,
    now = new Date(),
  ): Promise<Readonly<StorageServiceSnapshot>> {
    const service = await this.#repository.read(clientId, environment, serviceId);
    if (service.ownership !== 'client-owned') {
      throw new StorageServiceError(409, 'managed-storage-service-test-not-client-controlled');
    }
    if (service.status === 'disabled' || service.status === 'archived') {
      throw new StorageServiceError(409, 'storage-service-not-testable');
    }
    const secretId = await this.#repository.activeSecretId(clientId, environment, serviceId);
    if (secretId === undefined) throw new StorageServiceError(409, 'storage-service-secret-missing');
    const credentials = await this.#secrets.resolve(storageServiceSecretContext(service), secretId);
    const adapter = this.#adapters.get(service.providerType);
    try {
      const result = await adapter.testConnection({
        clientId,
        environment,
        serviceId,
        credentials,
        testScope,
      });
      const snapshot = await this.#repository.recordTest(
        clientId,
        environment,
        serviceId,
        result,
        now,
      );
      await this.#repository.recordActivity(
        clientId,
        environment,
        serviceId,
        result.connected ? 'storage-service-test-passed' : 'storage-service-test-failed',
        { diagnosticCode: result.diagnosticCode, connected: result.connected },
        now,
      );
      return snapshot;
    } catch (error) {
      const code = error instanceof StorageProviderAdapterError
        ? error.code
        : adapter.normalizeProviderError(error);
      const result = Object.freeze({
        connected: false,
        capabilities: adapter.getProviderManifest().capabilities,
        diagnosticCode: code,
        testedAt: now.toISOString(),
      });
      return this.#repository.recordTest(clientId, environment, serviceId, result, now);
    }
  }

  async replaceSecret(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
    secretInput: Readonly<Record<string, string>>,
    testScope: Readonly<Record<string, string>>,
    now = new Date(),
  ): Promise<Readonly<StorageServiceSnapshot>> {
    const service = await this.#repository.read(clientId, environment, serviceId);
    if (service.ownership !== 'client-owned') {
      throw new StorageServiceError(409, 'managed-storage-service-secret-not-client-controlled');
    }
    if (service.status === 'disabled' || service.status === 'archived') {
      throw new StorageServiceError(409, 'storage-service-secret-not-replaceable');
    }
    const previous = await this.#repository.activeSecretId(clientId, environment, serviceId);
    if (previous === undefined) throw new StorageServiceError(409, 'storage-service-secret-missing');
    const adapter = this.#adapters.get(service.providerType);
    const validated = adapter.validateSecretInput(secretInput);
    const next = await this.#secrets.store(storageServiceSecretContext(service), validated, now);
    await this.#repository.bindSecret(clientId, environment, serviceId, next, now);
    await this.#secrets.revoke(storageServiceSecretContext(service), previous, now);
    await this.#repository.recordActivity(
      clientId,
      environment,
      serviceId,
      'storage-service-secret-replaced',
      {},
      now,
    );
    return this.test(clientId, environment, serviceId, testScope, now);
  }

  async createConfigurationDraft(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
    now = new Date(),
  ): Promise<Readonly<ConfigurationVersionSnapshot>> {
    const service = await this.#repository.read(clientId, environment, serviceId);
    if (service.status !== 'ready') throw new StorageServiceError(409, 'storage-service-not-ready');
    const overview = await this.#configurations.overview(clientId, environment);
    const connection = Object.freeze({
      connectionId: service.serviceId,
      displayLabel: service.displayName,
      providerType: service.providerType === 'cloudflare-r2' ? 'r2' as const : 's3-compatible' as const,
      secretReferenceId: `zs-storage-service:${service.id}`,
      safeMetadata: Object.freeze({
        storageServiceId: service.serviceId,
        ownership: service.ownership,
      }),
    });
    if (overview.activeVersion !== undefined) {
      const draft = await this.#configurations.cloneVersion(
        clientId,
        environment,
        overview.activeVersion.id,
        now,
      );
      if (draft.providerConnections.some((item) => item.connectionId === connection.connectionId)) {
        return draft;
      }
      return this.#configurations.replaceDraft(clientId, environment, draft.id, {
        providerConnections: Object.freeze([...draft.providerConnections, connection]),
        vaults: draft.vaults,
        routes: draft.routes,
        imagePresets: draft.imagePresets,
      }, now);
    }
    return this.#configurations.createDraft(clientId, {
      environment,
      providerConnections: Object.freeze([connection]),
      vaults: Object.freeze([]),
      routes: Object.freeze([]),
      imagePresets: Object.freeze([]),
    }, now);
  }

  async assertConfigurationActivationAllowed(
    clientId: string,
    environment: ClientStorageEnvironment,
    version: Readonly<ConfigurationVersionSnapshot>,
  ): Promise<void> {
    const required = requiredStorageServiceCapabilities(version);
    for (const connection of version.providerConnections) {
      if (!connection.secretReferenceId.startsWith('zs-storage-service:')) continue;
      const internalId = connection.secretReferenceId.slice('zs-storage-service:'.length);
      const service = await this.#repository.readByInternalId(internalId);
      if (
        service.clientId !== clientId ||
        service.environment !== environment ||
        service.status !== 'ready'
      ) {
        throw new StorageServiceError(409, 'storage-service-not-ready');
      }
      if (required.some((capability) => service.capabilities[capability] !== true)) {
        throw new StorageServiceError(409, 'storage-service-capability-mismatch');
      }
    }
  }

  async disableOrArchive(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
    status: 'disabled' | 'archived',
    now = new Date(),
  ): Promise<Readonly<StorageServiceSnapshot>> {
    const dependencies = await this.#repository.dependencies(clientId, environment, serviceId);
    if (dependencies.activeConfigurationCount > 0) {
      throw new StorageServiceError(409, 'storage-service-active-dependency');
    }
    if (status === 'archived' && (
      dependencies.objectCopyCount > 0 || dependencies.derivativeOutputCount > 0
    )) {
      throw new StorageServiceError(409, 'storage-service-durable-dependency');
    }
    const service = await this.#repository.setStatus(
      clientId,
      environment,
      serviceId,
      status,
      now,
    );
    const secretId = await this.#repository.activeSecretId(clientId, environment, serviceId);
    if (status === 'archived' && secretId !== undefined && service.ownership === 'client-owned') {
      await this.#secrets.revoke(storageServiceSecretContext(service), secretId, now);
    }
    return service;
  }
}
