import type { ClientStorageEnvironment } from './client-storage-configuration.js';
import type {
  StorageServiceActivityEvent,
  StorageServiceDependencySnapshot,
  StorageServiceListFilter,
  StorageServiceRepository,
  StorageServiceSnapshot,
  StorageServiceStatus,
} from './storage-service.js';
import { StorageServiceError } from './storage-service.js';
import type { StorageServiceCapabilities } from './storage-provider-adapter.js';

interface Entry {
  snapshot: StorageServiceSnapshot;
  activeSecretId?: string;
  activity: StorageServiceActivityEvent[];
  dependencies: StorageServiceDependencySnapshot;
}

function cloneSnapshot(value: Readonly<StorageServiceSnapshot>): StorageServiceSnapshot {
  return Object.freeze({
    ...value,
    safeMetadata: Object.freeze({ ...value.safeMetadata }),
    capabilities: Object.freeze({ ...value.capabilities }),
  });
}

export class InMemoryStorageServiceRepository implements StorageServiceRepository {
  readonly configured = true;
  readonly #entries = new Map<string, Entry>();

  #key(clientId: string, environment: ClientStorageEnvironment, serviceId: string): string {
    return `${clientId}\u0000${environment}\u0000${serviceId}`;
  }

  #entry(clientId: string, environment: ClientStorageEnvironment, serviceId: string): Entry {
    const entry = this.#entries.get(this.#key(clientId, environment, serviceId));
    if (entry === undefined) throw new StorageServiceError(404, 'storage-service-not-found');
    return entry;
  }

  async create(
    input: Readonly<{
      id: string;
      serviceId: string;
      clientId: string;
      environment: ClientStorageEnvironment;
      displayName: string;
      providerType: string;
      ownership: 'z-s-managed' | 'client-owned';
      safeMetadata: Readonly<Record<string, unknown>>;
      capabilities: StorageServiceCapabilities;
    }>,
    now: Date,
  ): Promise<Readonly<StorageServiceSnapshot>> {
    const key = this.#key(input.clientId, input.environment, input.serviceId);
    if (this.#entries.has(key)) throw new StorageServiceError(409, 'storage-service-id-conflict');
    const snapshot = cloneSnapshot({
      id: input.id,
      serviceId: input.serviceId,
      clientId: input.clientId,
      environment: input.environment,
      displayName: input.displayName,
      providerType: input.providerType,
      ownership: input.ownership,
      status: 'awaiting-secret',
      safeMetadata: input.safeMetadata,
      capabilities: input.capabilities,
      lastTestStatus: 'never',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    this.#entries.set(key, {
      snapshot,
      activity: [],
      dependencies: Object.freeze({
        draftConfigurationCount: 0,
        activeConfigurationCount: 0,
        vaultCount: 0,
        routeCount: 0,
        objectCopyCount: 0,
        derivativeOutputCount: 0,
      }),
    });
    return snapshot;
  }

  async list(
    clientId: string,
    filter: Readonly<StorageServiceListFilter>,
  ): Promise<readonly Readonly<StorageServiceSnapshot>[]> {
    return Object.freeze([...this.#entries.values()]
      .map((entry) => entry.snapshot)
      .filter((service) => service.clientId === clientId)
      .filter((service) => filter.environment === undefined || service.environment === filter.environment)
      .filter((service) => filter.providerType === undefined || service.providerType === filter.providerType)
      .filter((service) => filter.ownership === undefined || service.ownership === filter.ownership)
      .filter((service) => filter.status === undefined || service.status === filter.status)
      .map(cloneSnapshot));
  }

  async read(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
  ): Promise<Readonly<StorageServiceSnapshot>> {
    return cloneSnapshot(this.#entry(clientId, environment, serviceId).snapshot);
  }

  async readByInternalId(internalId: string): Promise<Readonly<StorageServiceSnapshot>> {
    const entry = [...this.#entries.values()].find((candidate) =>
      candidate.snapshot.id === internalId);
    if (entry === undefined) throw new StorageServiceError(404, 'storage-service-not-found');
    return cloneSnapshot(entry.snapshot);
  }

  async activeSecretId(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
  ): Promise<string | undefined> {
    return this.#entry(clientId, environment, serviceId).activeSecretId;
  }

  async bindSecret(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
    secretId: string,
    now: Date,
  ): Promise<void> {
    const entry = this.#entry(clientId, environment, serviceId);
    entry.activeSecretId = secretId;
    entry.snapshot = cloneSnapshot({ ...entry.snapshot, status: 'testing', updatedAt: now.toISOString() });
  }

  async recordTest(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
    result: Readonly<{
      connected: boolean;
      capabilities: StorageServiceCapabilities;
      diagnosticCode: string | null;
      testedAt: string;
    }>,
    now: Date,
  ): Promise<Readonly<StorageServiceSnapshot>> {
    const entry = this.#entry(clientId, environment, serviceId);
    entry.snapshot = cloneSnapshot({
      ...entry.snapshot,
      status: result.connected ? 'ready' : 'failed',
      capabilities: result.capabilities,
      lastTestStatus: result.connected ? 'passed' : 'failed',
      lastTestedAt: result.testedAt,
      ...(result.diagnosticCode === null ? {} : { lastDiagnosticCode: result.diagnosticCode }),
      updatedAt: now.toISOString(),
    });
    return cloneSnapshot(entry.snapshot);
  }

  async setStatus(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
    status: 'disabled' | 'archived',
    now: Date,
  ): Promise<Readonly<StorageServiceSnapshot>> {
    const entry = this.#entry(clientId, environment, serviceId);
    entry.snapshot = cloneSnapshot({ ...entry.snapshot, status, updatedAt: now.toISOString() });
    return cloneSnapshot(entry.snapshot);
  }

  async dependencies(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
  ): Promise<Readonly<StorageServiceDependencySnapshot>> {
    return this.#entry(clientId, environment, serviceId).dependencies;
  }

  setDependencies(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
    value: Readonly<StorageServiceDependencySnapshot>,
  ): void {
    this.#entry(clientId, environment, serviceId).dependencies = Object.freeze({ ...value });
  }

  async activity(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
  ): Promise<readonly Readonly<StorageServiceActivityEvent>[]> {
    return Object.freeze(this.#entry(clientId, environment, serviceId).activity.map((event) =>
      Object.freeze({ ...event, safeSummary: Object.freeze({ ...event.safeSummary }) })));
  }

  async recordActivity(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
    eventType: string,
    safeSummary: Readonly<Record<string, unknown>>,
    now: Date,
  ): Promise<void> {
    const entry = this.#entry(clientId, environment, serviceId);
    entry.activity.unshift(Object.freeze({
      id: `${eventType}-${entry.activity.length + 1}`,
      eventType,
      safeSummary: Object.freeze({ ...safeSummary }),
      createdAt: now.toISOString(),
    }));
  }
}
