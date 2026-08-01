const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const BUCKET_LABEL_PATTERN = /^[a-z0-9][a-z0-9.-]{1,127}$/;

export type StorageControlProviderType = 'minio' | 'r2' | 's3-compatible';
export type StorageControlVaultRole = 'canonical' | 'hot' | 'derivative';
export type StorageControlRetentionPolicy = 'permanent' | 'hot-cache-short' | 'custom';
export type StorageControlAssetClass = 'raw-image' | 'raw-video' | 'image-derivative' | 'document';
export type StorageControlImageFormat = 'webp' | 'avif' | 'jpeg' | 'png';

export interface StorageControlVaultPlan {
  readonly vaultId: string;
  readonly driveLabel: string;
  readonly providerType: StorageControlProviderType;
  readonly bucketLabel: string;
  readonly secretReferenceId: string;
  readonly retentionPolicy: StorageControlRetentionPolicy;
  readonly deleteAfterDays?: number;
  readonly role: StorageControlVaultRole;
}

export interface StorageControlRoutePlan {
  readonly assetClass: StorageControlAssetClass;
  readonly primaryVaultId: string;
  readonly replicaVaultId?: string;
  readonly derivativeVaultId?: string;
}

export interface StorageControlImageDerivativePlan {
  readonly derivativeId: string;
  readonly sourceVaultId: string;
  readonly targetVaultId: string;
  readonly widths: readonly number[];
  readonly format: StorageControlImageFormat;
}

export interface StorageControlPlan {
  readonly clientId: string;
  readonly tokenPurpose: string;
  readonly tokenStorage: 'digest-only';
  readonly vaults: readonly StorageControlVaultPlan[];
  readonly routes: readonly StorageControlRoutePlan[];
  readonly imageDerivatives: readonly StorageControlImageDerivativePlan[];
}

class StorageControlPlanError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'StorageControlPlanError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  pattern: RegExp,
): string {
  const value = record[key];
  if (typeof value !== 'string') throw new StorageControlPlanError(`invalid-${key}`);
  const normalized = value.trim();
  if (!pattern.test(normalized)) throw new StorageControlPlanError(`invalid-${key}`);
  return normalized;
}

function requiredLabel(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new StorageControlPlanError(`invalid-${key}`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 160 || /[\u0000-\u001f]/.test(normalized)) {
    throw new StorageControlPlanError(`invalid-${key}`);
  }
  return normalized;
}

function providerType(value: string): StorageControlProviderType {
  switch (value) {
    case 'minio':
    case 'r2':
    case 's3-compatible':
      return value;
    default:
      throw new StorageControlPlanError('invalid-providerType');
  }
}

function vaultRole(value: string): StorageControlVaultRole {
  switch (value) {
    case 'canonical':
    case 'hot':
    case 'derivative':
      return value;
    default:
      throw new StorageControlPlanError('invalid-role');
  }
}

function retentionPolicy(value: string): StorageControlRetentionPolicy {
  switch (value) {
    case 'permanent':
    case 'hot-cache-short':
    case 'custom':
      return value;
    default:
      throw new StorageControlPlanError('invalid-retentionPolicy');
  }
}

function assertNever(value: never): never {
  throw new StorageControlPlanError(`unhandled-${value}`);
}

function optionalDeleteAfterDays(record: Readonly<Record<string, unknown>>): number | undefined {
  const value = record.deleteAfterDays;
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > 36500) {
    throw new StorageControlPlanError('invalid-deleteAfterDays');
  }
  return normalized;
}

function assetClass(value: string): StorageControlAssetClass {
  switch (value) {
    case 'raw-image':
    case 'raw-video':
    case 'image-derivative':
    case 'document':
      return value;
    default:
      throw new StorageControlPlanError('invalid-assetClass');
  }
}

function imageFormat(value: string): StorageControlImageFormat {
  switch (value) {
    case 'webp':
    case 'avif':
    case 'jpeg':
    case 'png':
      return value;
    default:
      throw new StorageControlPlanError('invalid-format');
  }
}

function parseVault(value: unknown): StorageControlVaultPlan {
  if (!isRecord(value)) throw new StorageControlPlanError('invalid-vault');
  const policy = retentionPolicy(requiredLabel(value, 'retentionPolicy'));
  const deleteAfterDays = optionalDeleteAfterDays(value);
  const vault = {
    vaultId: requiredString(value, 'vaultId', IDENTIFIER_PATTERN),
    driveLabel: requiredLabel(value, 'driveLabel'),
    providerType: providerType(requiredLabel(value, 'providerType')),
    bucketLabel: requiredString(value, 'bucketLabel', BUCKET_LABEL_PATTERN),
    secretReferenceId: requiredString(value, 'secretReferenceId', IDENTIFIER_PATTERN),
    retentionPolicy: policy,
    role: vaultRole(requiredLabel(value, 'role')),
  };
  switch (policy) {
    case 'permanent':
      if (deleteAfterDays !== undefined) throw new StorageControlPlanError('invalid-deleteAfterDays');
      return Object.freeze(vault);
    case 'hot-cache-short':
    case 'custom':
      if (deleteAfterDays === undefined) throw new StorageControlPlanError('invalid-deleteAfterDays');
      return Object.freeze({ ...vault, deleteAfterDays });
    default:
      return assertNever(policy);
  }
}

function parseRoute(value: unknown): StorageControlRoutePlan {
  if (!isRecord(value)) throw new StorageControlPlanError('invalid-route');
  const route: StorageControlRoutePlan = {
    assetClass: assetClass(requiredLabel(value, 'assetClass')),
    primaryVaultId: requiredString(value, 'primaryVaultId', IDENTIFIER_PATTERN),
  };
  const replicaVaultId = value.replicaVaultId;
  const replica =
    typeof replicaVaultId === 'string' && replicaVaultId.trim() !== ''
      ? requiredString(value, 'replicaVaultId', IDENTIFIER_PATTERN)
      : undefined;
  const derivativeVaultId = value.derivativeVaultId;
  const derivative =
    typeof derivativeVaultId === 'string' && derivativeVaultId.trim() !== ''
      ? requiredString(value, 'derivativeVaultId', IDENTIFIER_PATTERN)
      : undefined;
  return Object.freeze({
    ...route,
    ...(replica === undefined ? {} : { replicaVaultId: replica }),
    ...(derivative === undefined ? {} : { derivativeVaultId: derivative }),
  });
}

function parseWidths(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw new StorageControlPlanError('invalid-widths');
  }
  const widths = value.map((entry) => {
    if (!Number.isSafeInteger(entry) || entry < 16 || entry > 8192) {
      throw new StorageControlPlanError('invalid-widths');
    }
    return entry;
  });
  return Object.freeze([...new Set(widths)].sort((left, right) => left - right));
}

function parseImageDerivative(value: unknown): StorageControlImageDerivativePlan {
  if (!isRecord(value)) throw new StorageControlPlanError('invalid-image-derivative');
  return Object.freeze({
    derivativeId: requiredString(value, 'derivativeId', IDENTIFIER_PATTERN),
    sourceVaultId: requiredString(value, 'sourceVaultId', IDENTIFIER_PATTERN),
    targetVaultId: requiredString(value, 'targetVaultId', IDENTIFIER_PATTERN),
    widths: parseWidths(value.widths),
    format: imageFormat(requiredLabel(value, 'format')),
  });
}

function assertVaultExists(vaultIds: ReadonlySet<string>, vaultId: string): void {
  if (!vaultIds.has(vaultId)) throw new StorageControlPlanError('unknown-vault');
}

export function buildStorageControlPlan(input: unknown): StorageControlPlan {
  if (!isRecord(input)) throw new StorageControlPlanError('invalid-plan');
  if (!Array.isArray(input.vaults) || !Array.isArray(input.routes)) {
    throw new StorageControlPlanError('invalid-plan');
  }
  const vaults = Object.freeze(input.vaults.map(parseVault));
  const vaultIds = new Set(vaults.map((vault) => vault.vaultId));
  if (vaultIds.size !== vaults.length) throw new StorageControlPlanError('duplicate-vault');

  const routes = Object.freeze(input.routes.map(parseRoute));
  for (const route of routes) {
    assertVaultExists(vaultIds, route.primaryVaultId);
    if (route.replicaVaultId !== undefined) assertVaultExists(vaultIds, route.replicaVaultId);
    if (route.derivativeVaultId !== undefined) assertVaultExists(vaultIds, route.derivativeVaultId);
  }

  const imageDerivatives = Array.isArray(input.imageDerivatives)
    ? Object.freeze(input.imageDerivatives.map(parseImageDerivative))
    : Object.freeze([]);
  for (const derivative of imageDerivatives) {
    assertVaultExists(vaultIds, derivative.sourceVaultId);
    assertVaultExists(vaultIds, derivative.targetVaultId);
  }

  return Object.freeze({
    clientId: requiredString(input, 'clientId', IDENTIFIER_PATTERN),
    tokenPurpose: requiredString(input, 'tokenPurpose', IDENTIFIER_PATTERN),
    tokenStorage: 'digest-only',
    vaults,
    routes,
    imageDerivatives,
  });
}

export function storageControlPlanErrorCode(error: unknown): string {
  if (error instanceof StorageControlPlanError) return error.code;
  return 'internal-error';
}
