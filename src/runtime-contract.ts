import type { Environment, ProviderCapabilityPolicy } from './domain.js';
import type { IntegrityVerificationResult } from './integrity.js';

export type { ProviderCapabilityPolicy } from './domain.js';
export type { IntegrityVerificationResult } from './integrity.js';

export const SERVICE_ID = 'z-s' as const;
export const PACKAGE_VERSION = '0.2.0' as const;
export const CONTRACT_VERSION = '1.0' as const;
export const SUPPORTED_CONTRACT_VERSIONS = [CONTRACT_VERSION] as const;

export type ContractVersion = (typeof SUPPORTED_CONTRACT_VERSIONS)[number];
export type CallerAppId = 'video-maker_app' | 'z-x_app' | (string & {});

export interface CallerIdentity {
  appId: CallerAppId;
  serviceId?: string;
}

export interface StorageProfileRequest {
  profileId: string;
  profileVersion: number;
  environment: Environment;
}

export interface SafeResolvedStorageProfile {
  profileId: string;
  profileVersion: number;
  environment: Environment;
  ready: boolean;
  safeFingerprint: string;
  capabilityPolicy: ProviderCapabilityPolicy;
  capabilities: {
    objectWriteIntent: boolean;
    objectReadGrant: boolean;
    objectDeleteRequest: boolean;
    objectRepairOperation: boolean;
  };
  protectionStages: readonly ObjectProtectionStage[];
}

export type ObjectProtectionStage =
  | 'write-intent-created'
  | 'upload-completion-recorded'
  | 'hot-copy-pending'
  | 'hot-copy-verified'
  | 'canonical-copy-pending'
  | 'canonical-copy-verified'
  | 'protected'
  | 'degraded'
  | 'delete-pending'
  | 'deleted'
  | (string & {});

export interface DuplicateProtectionSummary {
  key: string;
  replayed: boolean;
}

export interface ObjectWriteIntentRequest {
  storageProfile: StorageProfileRequest;
  mediaType: string;
  byteLength: number;
  checksumSha256: string;
  sourceReference: string;
  requestedProtectionStage?: ObjectProtectionStage;
}

export interface ObjectWriteIntentResult {
  writeIntentId: string;
  storageObjectId: string;
  state: 'accepted' | 'pending' | 'rejected';
  uploadCompletionToken: string;
  expiresAt: string;
  objectProtectionStage: ObjectProtectionStage;
  duplicateProtection: DuplicateProtectionSummary;
}

export interface ObjectUploadCompletionResult {
  storageObjectId: string;
  writeIntentId: string;
  state: 'recorded' | 'verified' | 'rejected';
  checksumSha256: string;
  byteLength: number;
  integrityVerification: IntegrityVerificationResult;
  objectProtectionStage: ObjectProtectionStage;
}

export interface StorageObjectResult {
  storageObjectId: string;
  mediaType: string;
  byteLength: number;
  checksumSha256: string;
  lifecycleState: 'active' | 'degraded' | 'delete-pending' | 'deleted';
  objectProtectionStage: ObjectProtectionStage;
  canonicalObjectCopy: 'pending' | 'verified' | 'missing' | 'deleted';
  hotR2ObjCopy: 'pending' | 'verified' | 'missing' | 'deleted';
  createdAt: string;
  updatedAt: string;
}

export interface ObjectReadGrantRequest {
  storageObjectId: string;
  purpose: string;
  requestedTtlSeconds: number;
}

export interface ObjectReadGrantResult {
  storageObjectId: string;
  readGrantId: string;
  state: 'granted' | 'denied' | 'not-ready';
  expiresAt?: string;
  deliveryToken?: string;
  diagnostic?: SafeDiagnostic;
}

export interface ObjectDeliveryResult {
  storageObjectId: string;
  readGrantId: string;
  state: 'delivered' | 'expired' | 'denied' | 'failed';
  deliveredAt?: string;
  diagnostic?: SafeDiagnostic;
}

export interface ObjectDeleteRequest {
  storageObjectId: string;
  reason: string;
  requestedByReference: string;
}

export interface ObjectDeleteResult {
  storageObjectId: string;
  deleteRequestId: string;
  state: 'accepted' | 'in-progress' | 'deleted' | 'rejected';
  objectProtectionStage: ObjectProtectionStage;
  diagnostic?: SafeDiagnostic;
}

export interface ObjectRepairOperationRequest {
  storageObjectId: string;
  requestedStage: ObjectProtectionStage;
  reason: string;
}

export interface ObjectRepairOperationResult {
  storageObjectId: string;
  repairOperationId: string;
  state: 'accepted' | 'in-progress' | 'completed' | 'failed';
  objectProtectionStage: ObjectProtectionStage;
  diagnostic?: SafeDiagnostic;
}

export interface ReconciliationIssueRequest {
  storageObjectId?: string;
  category: string;
  summaryCode: string;
}

export interface ReconciliationIssueResult {
  reconciliationIssueId: string;
  state: 'open' | 'acknowledged' | 'resolved';
  storageObjectId?: string;
  diagnostic?: SafeDiagnostic;
}

export interface ProviderAttemptSummary {
  providerAttemptId: string;
  providerRole: 'hot' | 'canonical' | (string & {});
  operation: 'write' | 'read' | 'delete' | 'repair';
  state: 'pending' | 'succeeded' | 'failed';
  integrityVerification?: IntegrityVerificationResult;
  diagnostic?: SafeDiagnostic;
}

export interface StorageEvent<TPayload = unknown> {
  eventId: string;
  eventType: string;
  contractVersion: ContractVersion;
  occurredAt: string;
  caller: CallerIdentity;
  appCorrelationReference: string;
  storageObjectId?: string;
  payload: TPayload;
}

export const SAFE_DIAGNOSTIC_CATEGORIES = [
  'invalid-request',
  'unauthenticated',
  'unauthorized',
  'incompatible-version',
  'duplicate-conflict',
  'not-ready',
  'dependency-unavailable',
  'internal',
] as const;

export type SafeDiagnosticCategory = (typeof SAFE_DIAGNOSTIC_CATEGORIES)[number];

export interface SafeDiagnostic {
  category: SafeDiagnosticCategory;
  code: string;
  retryable: boolean;
  appCorrelationReference?: string;
}

export interface CompatibilityPolicy {
  serviceId: typeof SERVICE_ID;
  packageVersion: typeof PACKAGE_VERSION;
  currentContractVersion: typeof CONTRACT_VERSION;
  supportedContractVersions: typeof SUPPORTED_CONTRACT_VERSIONS;
  rule: string;
  schemaPolicy: string;
}

export const compatibilityPolicy: Readonly<CompatibilityPolicy> = Object.freeze({
  serviceId: SERVICE_ID,
  packageVersion: PACKAGE_VERSION,
  currentContractVersion: CONTRACT_VERSION,
  supportedContractVersions: SUPPORTED_CONTRACT_VERSIONS,
  rule: 'Callers must send an explicitly supported major.minor contract version. Unsupported versions are rejected before operation execution.',
  schemaPolicy: 'Additions may be backward compatible within 1.x. Removals, renames or semantic changes require a new major contract version.',
});

export interface DependencyReadiness {
  status: 'ready' | 'not-ready';
  code?: string;
}

export interface RuntimeRequestContext {
  caller: Readonly<CallerIdentity>;
  contractVersion: ContractVersion;
  appCorrelationReference: string;
  duplicateProtectionKey: string;
  requestId: string;
}

export interface DuplicateProtectionStore {
  execute<T>(input: {
    scope: string;
    key: string;
    fingerprint: string;
    operation: () => Promise<T>;
  }): Promise<Readonly<{ replayed: boolean; value: T }>>;
  clear?: () => void;
}

export interface StorageRuntimeOptions {
  authenticate: (bearerToken: string) => Promise<CallerIdentity | null> | CallerIdentity | null;
  authorizeCaller: (caller: Readonly<CallerIdentity>) => Promise<boolean> | boolean;
  resolveStorageProfile: (
    request: Readonly<StorageProfileRequest>,
    context: Readonly<Pick<RuntimeRequestContext, 'caller' | 'appCorrelationReference'>>,
  ) => Promise<SafeResolvedStorageProfile> | SafeResolvedStorageProfile;
  createObjectWriteIntent: (input: {
    request: Readonly<ObjectWriteIntentRequest>;
    resolvedProfile: Readonly<SafeResolvedStorageProfile>;
    context: Readonly<RuntimeRequestContext>;
  }) =>
    | Promise<Omit<ObjectWriteIntentResult, 'duplicateProtection'>>
    | Omit<ObjectWriteIntentResult, 'duplicateProtection'>;
  controlPlaneReadiness: () =>
    | Promise<DependencyReadiness | boolean | 'ready'>
    | DependencyReadiness
    | boolean
    | 'ready';
  dataPlaneReadiness: () =>
    | Promise<DependencyReadiness | boolean | 'ready'>
    | DependencyReadiness
    | boolean
    | 'ready';
  duplicateProtectionStore?: DuplicateProtectionStore;
  now?: () => Date;
  createId?: () => string;
}

export interface StorageHealth {
  serviceId: typeof SERVICE_ID;
  packageVersion: typeof PACKAGE_VERSION;
  contractVersion: typeof CONTRACT_VERSION;
  process: 'healthy';
  checkedAt: string;
}

export interface StorageReadiness {
  serviceId: typeof SERVICE_ID;
  process: 'healthy';
  controlPlane: DependencyReadiness;
  dataPlane: DependencyReadiness;
  status: 'ready' | 'not-ready';
  checkedAt: string;
}

export interface HttpStorageRuntime {
  handle(request: Request): Promise<Response>;
  health(): Promise<Readonly<StorageHealth>>;
  readiness(): Promise<Readonly<StorageReadiness>>;
}
