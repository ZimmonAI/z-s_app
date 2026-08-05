import type {
  ClientStorageEnvironment,
  ConfigurationVersionSnapshot,
} from './client-storage-configuration.js';
import type { ProviderSecretContext } from './provider-secret-store.js';
import {
  STORAGE_SERVICE_CAPABILITY_KEYS,
  type StorageServiceCapabilities,
} from './storage-provider-adapter.js';

export const STORAGE_SERVICE_STATUSES = [
  'setup_incomplete',
  'validating',
  'ready',
  'degraded',
  'auth_failed',
  'unreachable',
  'misconfigured',
  'disabled',
  'archived',
] as const;

export type StorageServiceStatus = (typeof STORAGE_SERVICE_STATUSES)[number];
export type StorageServiceOwnership = 'z-s-managed' | 'client-owned';

export interface StorageServiceSnapshot {
  readonly id: string;
  readonly serviceId: string;
  readonly clientId: string;
  readonly environment: ClientStorageEnvironment;
  readonly displayName: string;
  readonly providerType: string;
  readonly ownership: StorageServiceOwnership;
  readonly managedSecretReferenceId?: string;
  readonly status: StorageServiceStatus;
  readonly safeMetadata: Readonly<Record<string, unknown>>;
  readonly capabilities: StorageServiceCapabilities;
  readonly lastTestStatus: 'never' | 'passed' | 'failed';
  readonly lastTestedAt?: string;
  readonly lastDiagnosticCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StorageServiceDependencySnapshot {
  readonly draftConfigurationCount: number;
  readonly activeConfigurationCount: number;
  readonly vaultCount: number;
  readonly routeCount: number;
  readonly objectCopyCount: number;
  readonly derivativeOutputCount: number;
}

export interface StorageServiceActivityEvent {
  readonly id: string;
  readonly eventType: string;
  readonly safeSummary: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface StorageServiceListFilter {
  readonly environment?: ClientStorageEnvironment;
  readonly providerType?: string;
  readonly ownership?: StorageServiceOwnership;
  readonly status?: StorageServiceStatus;
}

export interface StorageServiceRepository {
  readonly configured: boolean;
  create(
    input: Readonly<{
      id: string;
      serviceId: string;
      clientId: string;
      environment: ClientStorageEnvironment;
      displayName: string;
      providerType: string;
      ownership: StorageServiceOwnership;
      safeMetadata: Readonly<Record<string, unknown>>;
      capabilities: StorageServiceCapabilities;
    }>,
    now: Date,
  ): Promise<Readonly<StorageServiceSnapshot>>;
  list(
    clientId: string,
    filter: Readonly<StorageServiceListFilter>,
  ): Promise<readonly Readonly<StorageServiceSnapshot>[]>;
  read(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
  ): Promise<Readonly<StorageServiceSnapshot>>;
  readByInternalId(
    internalId: string,
  ): Promise<Readonly<StorageServiceSnapshot>>;
  activeSecretId(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
  ): Promise<string | undefined>;
  bindSecret(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
    secretId: string,
    now: Date,
  ): Promise<void>;
  recordTest(
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
  ): Promise<Readonly<StorageServiceSnapshot>>;
  setStatus(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
    status: 'disabled' | 'archived',
    now: Date,
  ): Promise<Readonly<StorageServiceSnapshot>>;
  dependencies(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
  ): Promise<Readonly<StorageServiceDependencySnapshot>>;
  activity(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
  ): Promise<readonly Readonly<StorageServiceActivityEvent>[]>;
  recordActivity(
    clientId: string,
    environment: ClientStorageEnvironment,
    serviceId: string,
    eventType: string,
    safeSummary: Readonly<Record<string, unknown>>,
    now: Date,
  ): Promise<void>;
}

export class StorageServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = 'StorageServiceError';
    this.status = status;
    this.code = code;
  }
}

export function storageServiceSecretContext(service: Readonly<StorageServiceSnapshot>): ProviderSecretContext {
  return Object.freeze({
    clientId: service.clientId,
    environment: service.environment,
    serviceId: service.serviceId,
    providerType: service.providerType,
  });
}

export function storageServiceStatusForTest(
  connected: boolean,
  diagnosticCode: string | null,
): StorageServiceStatus {
  if (connected) return 'ready';
  const diagnostic = diagnosticCode ?? '';
  if (diagnostic.includes('authentication') || diagnostic.includes('authorization')) {
    return 'auth_failed';
  }
  if (
    diagnostic.includes('unreachable') ||
    diagnostic.includes('temporarily-unavailable') ||
    diagnostic.includes('timeout') ||
    diagnostic.includes('network')
  ) {
    return 'unreachable';
  }
  if (
    diagnostic.includes('invalid') ||
    diagnostic.includes('target-unavailable') ||
    diagnostic.includes('bucket') ||
    diagnostic.includes('prefix')
  ) {
    return 'misconfigured';
  }
  return 'degraded';
}

export function requiredStorageServiceCapabilities(
  version: Readonly<ConfigurationVersionSnapshot>,
): readonly (keyof StorageServiceCapabilities)[] {
  const required = new Set<keyof StorageServiceCapabilities>([
    'objectWrite',
    'objectRead',
    'objectHead',
    'rangeRead',
    'copyVerification',
  ]);
  if (version.routes.some((route) => route.targets.some((target) => target.role === 'replica'))) {
    required.add('replicaTarget');
  }
  if (version.imagePresets.length > 0) required.add('derivativeOutputTarget');
  if (version.vaults.some((vault) => vault.retention.mode === 'delete-after-days')) {
    required.add('objectDelete');
    required.add('retentionDeleteTarget');
  }
  return Object.freeze([...required]);
}

export function completeCapabilities(
  value: Partial<StorageServiceCapabilities>,
): StorageServiceCapabilities {
  return Object.freeze(Object.fromEntries(
    STORAGE_SERVICE_CAPABILITY_KEYS.map((key) => [key, value[key] === true]),
  ) as unknown as StorageServiceCapabilities);
}
