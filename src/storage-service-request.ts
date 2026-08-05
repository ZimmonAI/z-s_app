import {
  CLIENT_STORAGE_ENVIRONMENTS,
  type ClientStorageEnvironment,
} from './client-storage-configuration.js';
import { ControlPlaneUiError } from './control-plane-ui-request.js';
import {
  STORAGE_SERVICE_STATUSES,
  type StorageServiceListFilter,
  type StorageServiceOwnership,
  type StorageServiceStatus,
} from './storage-service.js';

function record(value: unknown, code: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControlPlaneUiError(400, code);
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== 'string') throw new ControlPlaneUiError(400, code);
  return value;
}

function stringMap(
  value: unknown,
  code: string,
): Readonly<Record<string, string>> {
  const input = record(value, code);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(input)) {
    if (typeof item !== 'string') throw new ControlPlaneUiError(400, code);
    result[key] = item;
  }
  return Object.freeze(result);
}

export function storageServiceEnvironment(value: unknown): ClientStorageEnvironment {
  if (
    typeof value !== 'string' ||
    !(CLIENT_STORAGE_ENVIRONMENTS as readonly string[]).includes(value)
  ) {
    throw new ControlPlaneUiError(400, 'invalid-client-storage-environment');
  }
  return value as ClientStorageEnvironment;
}

export function storageServiceEnvironmentFromUrl(url: URL): ClientStorageEnvironment {
  return storageServiceEnvironment(url.searchParams.get('environment') ?? 'dev');
}

export function storageServiceFilterFromUrl(url: URL): Readonly<StorageServiceListFilter> {
  const environmentValue = url.searchParams.get('environment');
  const ownershipValue = url.searchParams.get('ownership');
  const statusValue = url.searchParams.get('status');
  const providerType = url.searchParams.get('providerType')?.trim() || undefined;
  let ownership: StorageServiceOwnership | undefined;
  if (ownershipValue !== null && ownershipValue !== '') {
    if (ownershipValue !== 'z-s-managed' && ownershipValue !== 'client-owned') {
      throw new ControlPlaneUiError(400, 'invalid-storage-service-ownership');
    }
    ownership = ownershipValue;
  }
  let status: StorageServiceStatus | undefined;
  if (statusValue !== null && statusValue !== '') {
    if (!(STORAGE_SERVICE_STATUSES as readonly string[]).includes(statusValue)) {
      throw new ControlPlaneUiError(400, 'invalid-storage-service-status');
    }
    status = statusValue as StorageServiceStatus;
  }
  return Object.freeze({
    ...(environmentValue === null || environmentValue === ''
      ? {}
      : { environment: storageServiceEnvironment(environmentValue) }),
    ...(providerType === undefined ? {} : { providerType }),
    ...(ownership === undefined ? {} : { ownership }),
    ...(status === undefined ? {} : { status }),
  });
}

export function createStorageServiceInput(payload: unknown): Readonly<{
  serviceId: string;
  environment: ClientStorageEnvironment;
  displayName: string;
  providerType: string;
  safeMetadata: Readonly<Record<string, unknown>>;
  secretInput: Readonly<Record<string, string>>;
  testScope: Readonly<Record<string, string>>;
}> {
  const input = record(payload, 'invalid-storage-service-input');
  return Object.freeze({
    serviceId: stringValue(input.serviceId, 'invalid-storage-service-id'),
    environment: storageServiceEnvironment(input.environment),
    displayName: stringValue(input.displayName, 'invalid-storage-service-display-name'),
    providerType: stringValue(input.providerType, 'invalid-storage-provider-type'),
    safeMetadata: record(input.safeMetadata ?? {}, 'invalid-storage-service-safe-metadata'),
    secretInput: stringMap(input.secretInput, 'invalid-storage-service-secret-input'),
    testScope: stringMap(input.testScope ?? {}, 'invalid-storage-service-test-scope'),
  });
}

export function storageServiceSecretReplacementInput(payload: unknown): Readonly<{
  secretInput: Readonly<Record<string, string>>;
  testScope: Readonly<Record<string, string>>;
}> {
  const input = record(payload, 'invalid-storage-service-secret-input');
  return Object.freeze({
    secretInput: stringMap(input.secretInput, 'invalid-storage-service-secret-input'),
    testScope: stringMap(input.testScope ?? {}, 'invalid-storage-service-test-scope'),
  });
}

export function storageServiceTestScope(payload: unknown): Readonly<Record<string, string>> {
  const input = record(payload, 'invalid-storage-service-test-input');
  return stringMap(input.testScope ?? {}, 'invalid-storage-service-test-scope');
}
