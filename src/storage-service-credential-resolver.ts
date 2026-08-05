import type { ProviderSecretStore } from './provider-secret-store.js';
import type { StorageProviderAdapterRegistry } from './storage-provider-adapter.js';
import type { StorageServiceRepository } from './storage-service.js';
import { StorageServiceError, storageServiceSecretContext } from './storage-service.js';
import type {
  ProviderCredentialResolver,
  ResolvedS3CredentialBinding,
} from './runtime-s3-provider.js';

const STORAGE_SERVICE_REFERENCE_PREFIX = 'zs-storage-service:';

export class StorageServiceProviderCredentialResolver
implements ProviderCredentialResolver {
  readonly #services: StorageServiceRepository;
  readonly #secrets: ProviderSecretStore;
  readonly #adapters: StorageProviderAdapterRegistry;
  readonly #managedResolver: ProviderCredentialResolver;

  constructor(options: Readonly<{
    services: StorageServiceRepository;
    secrets: ProviderSecretStore;
    adapters: StorageProviderAdapterRegistry;
    managedResolver: ProviderCredentialResolver;
  }>) {
    this.#services = options.services;
    this.#secrets = options.secrets;
    this.#adapters = options.adapters;
    this.#managedResolver = options.managedResolver;
  }

  async resolve(
    referenceId: string,
  ): Promise<Readonly<ResolvedS3CredentialBinding>> {
    if (!referenceId.startsWith(STORAGE_SERVICE_REFERENCE_PREFIX)) {
      return this.#managedResolver.resolve(referenceId);
    }
    const internalId = referenceId.slice(STORAGE_SERVICE_REFERENCE_PREFIX.length);
    const service = await this.#services.readByInternalId(internalId);
    if (service.status !== 'ready') {
      throw new StorageServiceError(503, 'storage-service-not-ready');
    }
    if (service.ownership === 'z-s-managed') {
      const reference = service.managedSecretReferenceId;
      if (reference === undefined || reference.length < 1) {
        throw new StorageServiceError(503, 'managed-storage-service-binding-unavailable');
      }
      return this.#managedResolver.resolve(reference);
    }
    const secretId = await this.#services.activeSecretId(
      service.clientId,
      service.environment,
      service.serviceId,
    );
    if (secretId === undefined) {
      throw new StorageServiceError(503, 'storage-service-secret-missing');
    }
    const credentials = await this.#secrets.resolve(
      storageServiceSecretContext(service),
      secretId,
    );
    return this.#adapters.get(service.providerType).resolveRuntimeBinding(credentials);
  }
}

export function storageServiceSecretReference(internalServiceId: string): string {
  return `${STORAGE_SERVICE_REFERENCE_PREFIX}${internalServiceId}`;
}
