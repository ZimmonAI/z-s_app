import {
  CLIENT_STORAGE_ENVIRONMENTS,
  INTEGRATION_TOKEN_SCOPES,
  type ClientStorageEnvironment,
  type ConfigurationDraftDocument,
  type ConfigurationImagePresetInput,
  type ConfigurationRouteInput,
  type ConfigurationRouteTargetInput,
  type ConfigurationVaultInput,
  type CreateConfigurationDraftInput,
  type IntegrationTokenScope,
  type ProviderConnectionInput,
} from './client-storage-configuration.js';
import { ControlPlaneUiError } from './control-plane-ui-request.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== 'string') throw new ControlPlaneUiError(400, code);
  return value;
}

function numberValue(value: unknown, code: string): number {
  if (typeof value !== 'number') throw new ControlPlaneUiError(400, code);
  return value;
}

function arrayValue(value: unknown, code: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new ControlPlaneUiError(400, code);
  return value;
}

export function clientStorageEnvironment(value: unknown): ClientStorageEnvironment {
  if (
    typeof value !== 'string' ||
    !(CLIENT_STORAGE_ENVIRONMENTS as readonly string[]).includes(value)
  ) {
    throw new ControlPlaneUiError(400, 'invalid-client-storage-environment');
  }
  return value as ClientStorageEnvironment;
}

export function clientStorageEnvironmentFromUrl(url: URL): ClientStorageEnvironment {
  return clientStorageEnvironment(url.searchParams.get('environment') ?? 'dev');
}

function providerConnection(value: unknown): ProviderConnectionInput {
  if (!isRecord(value)) throw new ControlPlaneUiError(400, 'invalid-provider-connection');
  const providerType = stringValue(value.providerType, 'invalid-provider-type');
  if (!['minio', 'r2', 's3-compatible'].includes(providerType)) {
    throw new ControlPlaneUiError(400, 'invalid-provider-type');
  }
  const safeMetadata = value.safeMetadata;
  if (safeMetadata !== undefined && !isRecord(safeMetadata)) {
    throw new ControlPlaneUiError(400, 'invalid-safe-metadata');
  }
  return Object.freeze({
    connectionId: stringValue(value.connectionId, 'invalid-provider-connection-id'),
    displayLabel: stringValue(value.displayLabel, 'invalid-provider-connection-label'),
    providerType: providerType as ProviderConnectionInput['providerType'],
    secretReferenceId: stringValue(value.secretReferenceId, 'invalid-secret-reference-id'),
    ...(safeMetadata === undefined ? {} : { safeMetadata }),
  });
}

function configurationVault(value: unknown): ConfigurationVaultInput {
  if (!isRecord(value) || !isRecord(value.retention)) {
    throw new ControlPlaneUiError(400, 'invalid-configuration-vault');
  }
  const purpose = stringValue(value.purpose, 'invalid-vault-purpose');
  if (!['originals', 'hot-copy', 'derivatives', 'archive', 'custom'].includes(purpose)) {
    throw new ControlPlaneUiError(400, 'invalid-vault-purpose');
  }
  const mode = stringValue(value.retention.mode, 'invalid-retention-mode');
  const retention = mode === 'permanent'
    ? Object.freeze({ mode: 'permanent' as const })
    : mode === 'delete-after-days'
      ? Object.freeze({
        mode: 'delete-after-days' as const,
        deleteAfterDays: numberValue(
          value.retention.deleteAfterDays,
          'invalid-delete-after-days',
        ),
      })
      : undefined;
  if (retention === undefined) throw new ControlPlaneUiError(400, 'invalid-retention-mode');
  return Object.freeze({
    vaultId: stringValue(value.vaultId, 'invalid-vault-id'),
    providerConnectionId: stringValue(
      value.providerConnectionId,
      'invalid-provider-connection-id',
    ),
    displayLabel: stringValue(value.displayLabel, 'invalid-vault-label'),
    purpose: purpose as ConfigurationVaultInput['purpose'],
    bucketLabel: stringValue(value.bucketLabel, 'invalid-bucket-label'),
    prefixTemplate: stringValue(value.prefixTemplate, 'invalid-prefix-template'),
    retention,
  });
}

function routeTarget(value: unknown): ConfigurationRouteTargetInput {
  if (!isRecord(value)) throw new ControlPlaneUiError(400, 'invalid-route-target');
  const role = stringValue(value.role, 'invalid-route-target-role');
  if (role !== 'primary' && role !== 'replica') {
    throw new ControlPlaneUiError(400, 'invalid-route-target-role');
  }
  return Object.freeze({
    role,
    vaultId: stringValue(value.vaultId, 'invalid-vault-id'),
  });
}

function configurationRoute(value: unknown): ConfigurationRouteInput {
  if (!isRecord(value)) throw new ControlPlaneUiError(400, 'invalid-configuration-route');
  const assetClass = stringValue(value.assetClass, 'invalid-asset-class');
  if (!['image', 'video', 'document'].includes(assetClass)) {
    throw new ControlPlaneUiError(400, 'invalid-asset-class');
  }
  const imagePresetId = value.imagePresetId;
  if (imagePresetId !== undefined && typeof imagePresetId !== 'string') {
    throw new ControlPlaneUiError(400, 'invalid-image-preset-id');
  }
  return Object.freeze({
    routeId: stringValue(value.routeId, 'invalid-route-id'),
    assetClass: assetClass as ConfigurationRouteInput['assetClass'],
    targets: Object.freeze(
      arrayValue(value.targets, 'invalid-route-targets').map(routeTarget),
    ),
    ...(imagePresetId === undefined ? {} : { imagePresetId }),
  });
}

function imagePreset(value: unknown): ConfigurationImagePresetInput {
  if (!isRecord(value)) throw new ControlPlaneUiError(400, 'invalid-image-preset');
  const outputFormat = stringValue(value.outputFormat, 'invalid-image-output-format');
  if (!['webp', 'avif', 'jpeg', 'png'].includes(outputFormat)) {
    throw new ControlPlaneUiError(400, 'invalid-image-output-format');
  }
  const fit = stringValue(value.fit, 'invalid-image-fit');
  if (!['inside', 'cover', 'contain', 'fill'].includes(fit)) {
    throw new ControlPlaneUiError(400, 'invalid-image-fit');
  }
  return Object.freeze({
    presetId: stringValue(value.presetId, 'invalid-image-preset-id'),
    targetVaultId: stringValue(value.targetVaultId, 'invalid-vault-id'),
    widths: Object.freeze(
      arrayValue(value.widths, 'invalid-image-preset-widths').map((width) =>
        numberValue(width, 'invalid-image-preset-widths')),
    ),
    outputFormat: outputFormat as ConfigurationImagePresetInput['outputFormat'],
    quality: numberValue(value.quality, 'invalid-image-preset-quality'),
    fit: fit as ConfigurationImagePresetInput['fit'],
  });
}

export function configurationDocumentFromPayload(
  payload: unknown,
): Readonly<ConfigurationDraftDocument> {
  if (!isRecord(payload)) throw new ControlPlaneUiError(400, 'invalid-configuration-document');
  return Object.freeze({
    providerConnections: Object.freeze(
      arrayValue(payload.providerConnections, 'invalid-provider-connections')
        .map(providerConnection),
    ),
    vaults: Object.freeze(
      arrayValue(payload.vaults, 'invalid-configuration-vaults')
        .map(configurationVault),
    ),
    routes: Object.freeze(
      arrayValue(payload.routes, 'invalid-configuration-routes')
        .map(configurationRoute),
    ),
    imagePresets: Object.freeze(
      arrayValue(payload.imagePresets, 'invalid-image-presets')
        .map(imagePreset),
    ),
  });
}

export function createConfigurationDraftFromPayload(
  payload: unknown,
): Readonly<CreateConfigurationDraftInput> {
  if (!isRecord(payload)) throw new ControlPlaneUiError(400, 'invalid-configuration-document');
  return Object.freeze({
    environment: clientStorageEnvironment(payload.environment),
    ...configurationDocumentFromPayload(payload),
  });
}

export function integrationTokenInputFromPayload(payload: unknown): Readonly<{
  environment: ClientStorageEnvironment;
  tokenId: string;
  displayLabel: string;
  scopes: readonly IntegrationTokenScope[];
  expiresAt?: Date;
}> {
  if (!isRecord(payload)) throw new ControlPlaneUiError(400, 'invalid-integration-token');
  const scopes = arrayValue(payload.scopes, 'invalid-integration-token-scopes').map((scope) => {
    const normalized = stringValue(scope, 'invalid-integration-token-scopes');
    if (!(INTEGRATION_TOKEN_SCOPES as readonly string[]).includes(normalized)) {
      throw new ControlPlaneUiError(400, 'invalid-integration-token-scopes');
    }
    return normalized as IntegrationTokenScope;
  });
  const expiresAtValue = payload.expiresAt;
  let expiresAt: Date | undefined;
  if (expiresAtValue !== undefined && expiresAtValue !== null) {
    if (typeof expiresAtValue !== 'string') {
      throw new ControlPlaneUiError(400, 'invalid-integration-token-expiry');
    }
    expiresAt = new Date(expiresAtValue);
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new ControlPlaneUiError(400, 'invalid-integration-token-expiry');
    }
  }
  return Object.freeze({
    environment: clientStorageEnvironment(payload.environment),
    tokenId: stringValue(payload.tokenId, 'invalid-integration-token-id'),
    displayLabel: stringValue(payload.displayLabel, 'invalid-integration-token-label'),
    scopes: Object.freeze(scopes),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}
