import type { SafeDiagnostic } from './runtime-contract.js';

export type ProviderRole = 'hot' | 'canonical';
export type ConfiguredTargetRole = 'primary' | 'replica';
export type ConfiguredProviderType = 'minio' | 'r2' | 's3-compatible';

export interface ConfiguredProviderTarget {
  configurationRouteTargetId: string;
  configurationVaultId: string;
  providerConnectionId: string;
  role: ConfiguredTargetRole;
  order: number;
  providerType: ConfiguredProviderType;
  bucketLabel: string;
  prefixTemplate: string;
  secretReferenceId: string;
  internalLocator: string;
}
export type ObjectWriteIntentState =
  | 'accepted'
  | 'uploading'
  | 'completed'
  | 'expired'
  | 'cancelled'
  | 'failed';
export type StorageObjectState = 'reserved' | 'active' | 'degraded' | 'delete_pending' | 'deleted';
export type StorageObjectCopyState =
  | 'pending'
  | 'verified'
  | 'failed'
  | 'missing'
  | 'delete_pending'
  | 'deleted';
export type ProviderAttemptOperation = 'write' | 'verify' | 'read' | 'delete' | 'repair';
export type ProviderAttemptState = 'pending' | 'in_progress' | 'succeeded' | 'failed';
export type ReconciliationIssueState = 'open' | 'acknowledged' | 'resolved';

export interface PostgresQueryResult<Row extends Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

export interface PostgresQueryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>>;
}

export interface PostgresClientLike extends PostgresQueryable {
  release(): void;
}

export interface PostgresPoolLike {
  connect(): Promise<PostgresClientLike>;
}

export interface DurableDuplicateResultReference {
  resultKind: string;
  resultReferenceId: string;
  storageObjectId?: string;
}

export interface DurableDuplicateResultCodec {
  encode(value: unknown, client: PostgresQueryable): Promise<DurableDuplicateResultReference>;
  decode(reference: DurableDuplicateResultReference, client: PostgresQueryable): Promise<unknown>;
}

export class RuntimeStorageRegistryError extends Error {
  readonly category: SafeDiagnostic['category'];
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    category: SafeDiagnostic['category'],
    code: string,
    status: number,
    retryable = false,
  ) {
    super(code);
    this.name = 'RuntimeStorageRegistryError';
    this.category = category;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface IdempotencyRow extends Record<string, unknown> {
  request_fingerprint: string;
  state: 'in_progress' | 'succeeded' | 'failed';
  result_kind: string | null;
  result_reference_id: string | null;
  result_storage_object_id: string | null;
  expires_at: Date | string;
}

export interface WriteIntentRow extends Record<string, unknown> {
  object_write_intent_id: string;
  storage_object_id: string;
  state: ObjectWriteIntentState;
  expires_at: Date | string;
  terminal_at: Date | string | null;
  row_version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface WriteIntentExecutionRow extends WriteIntentRow {
  managed_app_id: string;
  caller_app_id: string;
  caller_service_id: string | null;
  storage_profile_id: string;
  storage_profile_version: number;
  storage_profile_fingerprint: string;
  storage_prefix_class_id: string;
  app_correlation_ref: string;
  source_reference: string;
  expected_content_type: string;
  expected_byte_length: string | number;
  expected_checksum_sha256: string;
  registry_state: StorageObjectState;
  object_protection_stage: string;
  object_row_version: number;
  hot_storage_object_copy_id: string;
  hot_provider_binding_id: string;
  hot_copy_state: StorageObjectCopyState;
  hot_copy_row_version: number;
  hot_internal_locator: string;
  canonical_storage_object_copy_id: string;
  canonical_provider_binding_id: string;
  canonical_copy_state: StorageObjectCopyState;
  canonical_copy_row_version: number;
  canonical_internal_locator: string;
}

export interface StorageObjectRow extends Record<string, unknown> {
  storage_object_id: string;
  configuration_route_id?: string | null;
  registry_state: StorageObjectState;
  object_protection_stage: string;
  expected_checksum_sha256: string;
  expected_byte_length: string | number;
  expected_content_type: string;
  verified_checksum_sha256: string | null;
  verified_byte_length: string | number | null;
  safe_technical_metadata: Record<string, unknown>;
  row_version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface StorageObjectCopyRow extends Record<string, unknown> {
  storage_object_copy_id: string;
  storage_object_id: string;
  provider_role: ProviderRole;
  copy_state: StorageObjectCopyState;
  observed_checksum_sha256: string | null;
  observed_byte_length: string | number | null;
  latest_verified_at: Date | string | null;
  row_version: number;
  updated_at: Date | string;
}

export interface ProviderAttemptRow extends Record<string, unknown> {
  storage_provider_attempt_id: string;
  storage_object_copy_id: string;
  storage_object_id: string;
  operation: ProviderAttemptOperation;
  operation_reference: string;
  attempt_number: number;
  state: ProviderAttemptState;
  retryable: boolean;
  next_retry_at: Date | string | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: Date | string | null;
  safe_diagnostic_category: string | null;
  safe_diagnostic_code: string | null;
}

export interface ReconciliationIssueRow extends Record<string, unknown> {
  storage_reconciliation_issue_id: string;
  issue_fingerprint: string;
  state: ReconciliationIssueState;
  claim_owner: string | null;
  claim_token: string | null;
  claim_expires_at: Date | string | null;
  row_version: number;
}

export interface CreateObjectWriteIntentBaseInput {
  callerServiceId?: string;
  appCorrelationReference: string;
  sourceReference: string;
  expectedContentType: string;
  expectedByteLength: number;
  expectedChecksumSha256: string;
  requestedObjectProtectionStage?: string;
  expiresAt: Date;
  safeTechnicalMetadata?: Readonly<Record<string, unknown>>;
}

/** Legacy profile authority retained only for compatibility with historical callers/tests. */
export interface CreateObjectWriteIntentInput extends CreateObjectWriteIntentBaseInput {
  managedAppId: string;
  storageProfileId: string;
  storageProfileFingerprint: string;
  storagePrefixClassId: string;
  hotProviderBindingId: string;
  canonicalProviderBindingId: string;
  internalLocators: Readonly<Record<ProviderRole, string>>;
}

export interface CreateConfiguredObjectWriteIntentInput extends CreateObjectWriteIntentBaseInput {
  storageObjectId: string;
  storageControlClientId: string;
  configurationVersionId: string;
  configurationFingerprint: string;
  configurationRouteId: string;
  targets: readonly Readonly<ConfiguredProviderTarget>[];
}

export interface ObjectWriteIntentSnapshot {
  objectWriteIntentId: string;
  storageObjectId: string;
  state: ObjectWriteIntentState;
  expiresAt: string;
  terminalAt?: string;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderCopyExecutionContext {
  storageObjectCopyId: string;
  providerBindingId: string;
  providerRole: ProviderRole;
  state: StorageObjectCopyState;
  rowVersion: number;
  internalLocator: string;
}

export interface ConfiguredProviderCopyExecutionContext extends ConfiguredProviderTarget {
  storageObjectCopyId: string;
  state: StorageObjectCopyState;
  rowVersion: number;
}

/** Legacy execution context retained as the compatibility contract. */
export interface ObjectWriteIntentExecutionContext {
  authorityKind?: 'legacy-profile';
  objectWriteIntentId: string;
  storageObjectId: string;
  managedAppId: string;
  callerAppId: string;
  callerServiceId?: string;
  storageProfileId: string;
  storageProfileVersion: number;
  storageProfileFingerprint: string;
  storagePrefixClassId: string;
  appCorrelationReference: string;
  sourceReference: string;
  expectedContentType: string;
  expectedByteLength: number;
  expectedChecksumSha256: string;
  state: ObjectWriteIntentState;
  expiresAt: string;
  rowVersion: number;
  objectRowVersion?: number;
  registryState: StorageObjectState;
  objectProtectionStage: string;
  internalLocators: Readonly<Record<ProviderRole, string>>;
  providerCopies?: Readonly<Record<ProviderRole, Readonly<ProviderCopyExecutionContext>>>;
}

export interface ConfiguredObjectWriteIntentExecutionContext {
  authorityKind: 'configuration';
  objectWriteIntentId: string;
  storageObjectId: string;
  storageControlClientId: string;
  callerAppId: string;
  callerServiceId?: string;
  configurationVersionId: string;
  configurationFingerprint: string;
  configurationRouteId: string;
  appCorrelationReference: string;
  sourceReference: string;
  expectedContentType: string;
  expectedByteLength: number;
  expectedChecksumSha256: string;
  state: ObjectWriteIntentState;
  expiresAt: string;
  rowVersion: number;
  objectRowVersion: number;
  registryState: StorageObjectState;
  objectProtectionStage: string;
  configuredCopies: readonly Readonly<ConfiguredProviderCopyExecutionContext>[];
  providerCopies?: Readonly<Record<ProviderRole, Readonly<ProviderCopyExecutionContext>>>;
  internalLocators: Readonly<Record<ProviderRole, string>>;
}

export type RuntimeObjectWriteIntentExecutionContext =
  | ObjectWriteIntentExecutionContext
  | ConfiguredObjectWriteIntentExecutionContext;

export interface StorageObjectCopySnapshot {
  storageObjectCopyId: string;
  providerRole: ProviderRole;
  state: StorageObjectCopyState;
  observedChecksumSha256?: string;
  observedByteLength?: number;
  latestVerifiedAt?: string;
  rowVersion: number;
  updatedAt: string;
}

export interface ConfiguredStorageObjectCopySnapshot {
  storageObjectCopyId: string;
  configurationRouteTargetId: string;
  role: ConfiguredTargetRole;
  order: number;
  state: StorageObjectCopyState;
  observedChecksumSha256?: string;
  observedByteLength?: number;
  latestVerifiedAt?: string;
  rowVersion: number;
  updatedAt: string;
}

export interface StorageObjectSnapshot {
  storageObjectId: string;
  registryState: StorageObjectState;
  objectProtectionStage: string;
  expectedChecksumSha256: string;
  expectedByteLength: number;
  expectedContentType: string;
  verifiedChecksumSha256?: string;
  verifiedByteLength?: number;
  safeTechnicalMetadata: Readonly<Record<string, unknown>>;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  copies: Readonly<Record<ProviderRole, StorageObjectCopySnapshot>>;
  configuredCopies?: readonly Readonly<ConfiguredStorageObjectCopySnapshot>[];
}

export interface ProviderAttemptInput {
  storageObjectCopyId: string;
  storageObjectId: string;
  operation: ProviderAttemptOperation;
  operationReference: string;
  attemptNumber: number;
  retryable?: boolean;
  nextRetryAt?: Date;
  expectedChecksumSha256?: string;
  expectedByteLength?: number;
}

export interface SafeStorageEventInput {
  eventId: string;
  dedupeKey: string;
  eventType: string;
  contractVersion: string;
  occurredAt: Date;
  managedAppId: string;
  callerServiceId?: string;
  storageObjectId?: string;
  appCorrelationReference: string;
  payload: Readonly<Record<string, unknown>>;
  diagnostic?: Readonly<SafeDiagnostic>;
}

export interface ReconciliationIssueInput {
  issueFingerprint: string;
  storageObjectId?: string;
  storageObjectCopyId?: string;
  storageProviderAttemptId?: string;
  providerRole?: ProviderRole;
  category: string;
  summaryCode: string;
  safeDetail?: Readonly<Record<string, unknown>>;
  nextRetryAt?: Date;
}

export interface RuntimeStorageRegistryOptions {
  pool: PostgresPoolLike;
  duplicateResultCodec: DurableDuplicateResultCodec;
  now?: () => Date;
  createId?: () => string;
  idempotencyReservationTtlMs?: number;
}
