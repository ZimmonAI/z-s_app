const VAULT_INDEXES = Object.freeze([0, 1, 2]);
const ROUTE_INDEXES = Object.freeze([0, 1, 2]);

interface StorageControlFormVaultInput {
  readonly vaultId: string;
  readonly driveLabel: string;
  readonly providerType: string;
  readonly bucketLabel: string;
  readonly secretReferenceId: string;
  readonly retentionPolicy: string;
  readonly deleteAfterDays?: number;
  readonly role: string;
}

interface StorageControlFormRouteInput {
  readonly assetClass: string;
  readonly primaryVaultId: string;
  readonly replicaVaultId?: string;
  readonly derivativeVaultId?: string;
}

interface StorageControlFormImageDerivativeInput {
  readonly derivativeId: string;
  readonly sourceVaultId: string;
  readonly targetVaultId: string;
  readonly widths: readonly number[];
  readonly format: string;
}

interface StorageControlFormPlanInput {
  readonly clientId: string;
  readonly tokenPurpose: string;
  readonly vaults: readonly StorageControlFormVaultInput[];
  readonly routes: readonly StorageControlFormRouteInput[];
  readonly imageDerivatives: readonly StorageControlFormImageDerivativeInput[];
}

class StorageControlFormError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'StorageControlFormError';
    this.code = code;
  }
}

function requiredField(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (value === null) throw new StorageControlFormError('invalid-plan');
  const normalized = value.trim();
  if (normalized.length < 1) throw new StorageControlFormError(`invalid-${name}`);
  return normalized;
}

function optionalField(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name);
  if (value === null) return undefined;
  const normalized = value.trim();
  return normalized.length < 1 ? undefined : normalized;
}

function optionalDays(params: URLSearchParams, name: string): number | undefined {
  const value = optionalField(params, name);
  if (value === undefined) return undefined;
  const days = Number(value);
  if (!Number.isSafeInteger(days)) throw new StorageControlFormError(`invalid-${name}`);
  return days;
}

function widths(params: URLSearchParams): readonly number[] {
  return requiredField(params, 'derivative0Widths')
    .split(/[,\s]+/)
    .filter((entry) => entry.length > 0)
    .map((entry) => Number(entry));
}

function vault(params: URLSearchParams, index: number): StorageControlFormVaultInput {
  const deleteAfterDays = optionalDays(params, `vault${index}DeleteAfterDays`);
  const input = {
    vaultId: requiredField(params, `vault${index}VaultId`),
    driveLabel: requiredField(params, `vault${index}DriveLabel`),
    providerType: requiredField(params, `vault${index}ProviderType`),
    bucketLabel: requiredField(params, `vault${index}BucketLabel`),
    secretReferenceId: requiredField(params, `vault${index}SecretReferenceId`),
    retentionPolicy: requiredField(params, `vault${index}RetentionPolicy`),
    role: requiredField(params, `vault${index}Role`),
  };
  return Object.freeze(deleteAfterDays === undefined ? input : { ...input, deleteAfterDays });
}

function route(params: URLSearchParams, index: number, imageDerivativeEnabled: boolean): StorageControlFormRouteInput {
  const replicaVaultId = optionalField(params, `route${index}ReplicaVaultId`);
  const derivativeVaultId = imageDerivativeEnabled
    ? optionalField(params, `route${index}DerivativeVaultId`)
    : undefined;
  return Object.freeze({
    assetClass: requiredField(params, `route${index}AssetClass`),
    primaryVaultId: requiredField(params, `route${index}PrimaryVaultId`),
    ...(replicaVaultId === undefined ? {} : { replicaVaultId }),
    ...(derivativeVaultId === undefined ? {} : { derivativeVaultId }),
  });
}

function imageDerivative(params: URLSearchParams): StorageControlFormImageDerivativeInput {
  return Object.freeze({
    derivativeId: requiredField(params, 'derivative0DerivativeId'),
    sourceVaultId: requiredField(params, 'derivative0SourceVaultId'),
    targetVaultId: requiredField(params, 'derivative0TargetVaultId'),
    widths: widths(params),
    format: requiredField(params, 'derivative0Format'),
  });
}

export function storageControlPlanInputFromForm(params: URLSearchParams): StorageControlFormPlanInput {
  const imageDerivativeEnabled = params.get('enableImageDerivative') === 'on';
  return Object.freeze({
    clientId: requiredField(params, 'clientId'),
    tokenPurpose: requiredField(params, 'tokenPurpose'),
    vaults: Object.freeze(VAULT_INDEXES.map((index) => vault(params, index))),
    routes: Object.freeze(ROUTE_INDEXES.map((index) => route(params, index, imageDerivativeEnabled))),
    imageDerivatives: imageDerivativeEnabled ? Object.freeze([imageDerivative(params)]) : Object.freeze([]),
  });
}

export function storageControlFormErrorCode(error: unknown): string {
  if (error instanceof StorageControlFormError) return error.code;
  return 'internal-error';
}
