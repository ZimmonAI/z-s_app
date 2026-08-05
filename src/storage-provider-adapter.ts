import type { ClientStorageEnvironment } from './client-storage-configuration.js';
import type { ResolvedS3CredentialBinding } from './runtime-s3-provider.js';

export const STORAGE_SERVICE_CAPABILITY_KEYS = [
  'objectWrite',
  'objectRead',
  'objectHead',
  'rangeRead',
  'objectDelete',
  'copyVerification',
  'replicaTarget',
  'derivativeOutputTarget',
  'retentionDeleteTarget',
] as const;

export type StorageServiceCapabilityKey =
  (typeof STORAGE_SERVICE_CAPABILITY_KEYS)[number];

export type StorageServiceCapabilities = Readonly<
  Record<StorageServiceCapabilityKey, boolean>
>;

export interface ProviderSetupField {
  readonly name: string;
  readonly label: string;
  readonly secret: boolean;
  readonly required: boolean;
  readonly maximumLength: number;
}

export interface StorageProviderManifest {
  readonly providerType: string;
  readonly displayName: string;
  readonly protocolFamily: string;
  readonly adapterStatus: 'accepted' | 'planned';
  readonly setupFields: readonly Readonly<ProviderSetupField>[];
  readonly capabilities: StorageServiceCapabilities;
  readonly requiredOperations: readonly string[];
  readonly forbiddenOutputs: readonly string[];
}

export interface StorageProviderTestInput {
  readonly clientId: string;
  readonly environment: ClientStorageEnvironment;
  readonly serviceId: string;
  readonly credentials: Readonly<Record<string, string>>;
  readonly testScope: Readonly<Record<string, string>>;
}

export interface StorageProviderTestResult {
  readonly connected: boolean;
  readonly capabilities: StorageServiceCapabilities;
  readonly diagnosticCode: string | null;
  readonly testedAt: string;
}

export interface StorageProviderAdapter {
  getProviderManifest(): Readonly<StorageProviderManifest>;
  validateSafeSetupMetadata(
    safeMetadata: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>>;
  validateSecretInput(
    secretInput: Readonly<Record<string, string>>,
  ): Readonly<Record<string, string>>;
  testConnection(
    input: Readonly<StorageProviderTestInput>,
  ): Promise<Readonly<StorageProviderTestResult>>;
  resolveRuntimeBinding(
    credentials: Readonly<Record<string, string>>,
  ): Readonly<ResolvedS3CredentialBinding>;
  normalizeProviderError(error: unknown): string;
}

export class StorageProviderAdapterError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = 'StorageProviderAdapterError';
    this.status = status;
    this.code = code;
  }
}

export class StorageProviderAdapterRegistry {
  readonly #adapters: ReadonlyMap<string, StorageProviderAdapter>;

  constructor(adapters: readonly StorageProviderAdapter[]) {
    this.#adapters = new Map(adapters.map((adapter) => [
      adapter.getProviderManifest().providerType,
      adapter,
    ]));
  }

  get(providerType: string): StorageProviderAdapter {
    const adapter = this.#adapters.get(providerType);
    if (adapter === undefined) {
      throw new StorageProviderAdapterError(409, 'storage-provider-adapter-unavailable');
    }
    return adapter;
  }

  manifests(): readonly Readonly<StorageProviderManifest>[] {
    return Object.freeze([...this.#adapters.values()].map((adapter) =>
      adapter.getProviderManifest()));
  }
}
