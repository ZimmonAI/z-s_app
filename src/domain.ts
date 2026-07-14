export type Environment = 'dev' | 'stg' | 'prod';
export type ActiveStatus = 'active' | 'disabled';
export type ProfileStatus = 'draft' | 'active' | 'disabled';
export type ProviderType = 'minio' | 'r2' | 's3-compatible';
export type ProviderRole = 'hot' | 'canonical';
export type OperationClass =
  | 'user-upload'
  | 'generated-asset'
  | 'private-document'
  | 'capability-probe';
export type Capability = 'put' | 'head' | 'get' | 'delete' | 'checksum' | 'size' | 'range';
export type CapabilityResultState = 'passed' | 'failed' | 'not-supported';

export const CAPABILITY_POLICY_VERSION = '1' as const;

export interface ManagedAppEnvironment {
  appId: string;
  environment: Environment;
  status: ActiveStatus;
}

export interface StorageProviderRecord {
  providerId: string;
  providerType: ProviderType;
  status: ActiveStatus;
  secretReferenceId: string;
}

export interface StorageProfileRecord {
  profileId: string;
  appId: string;
  environment: Environment;
  version: number;
  status: ProfileStatus;
}

export interface StorageProfileProviderBinding {
  profileId: string;
  profileVersion: number;
  providerRole: ProviderRole;
  providerId: string;
  bucketLabel: string;
  required: boolean;
}

export interface StoragePrefixClass {
  prefixClassId: string;
  profileId: string;
  profileVersion: number;
  operationClass: OperationClass;
  normalizedPrefixPattern: string;
  status: ActiveStatus;
}

export interface StorageCapabilityResult {
  capabilityRunId: string;
  profileId: string;
  profileVersion: number;
  providerId: string;
  bucketLabel: string;
  prefixClassId: string;
  capability: Capability;
  result: CapabilityResultState;
  verifiedAt: string;
  expiresAt: string | null;
  safeEvidenceRef?: string | null;
}

export interface ProviderCapabilityPolicy {
  checksumVerification: 'required';
  sizeVerification: 'required-when-supported';
  headContentLength: 'required' | 'optional-with-checksum';
  rangeRead: 'required' | 'optional' | 'not-applicable';
}

export interface SafeProviderAssignment {
  providerId: string;
  bucketLabel: string;
}

export interface ResolvedStorageProfileAssignment {
  appId: string;
  environment: Environment;
  profileId: string;
  profileVersion: number;
  hotProvider: SafeProviderAssignment | null;
  canonicalProvider: SafeProviderAssignment;
  prefixClassId: string;
  normalizedPrefixPattern: string;
  capabilityPolicy: ProviderCapabilityPolicy;
  safeFingerprint: string;
}

export interface ProviderConfigurationExpectation {
  hotProviderId?: string | null;
  hotBucket?: string | null;
  canonicalProviderId?: string;
  canonicalBucket?: string;
  normalizedPrefixPattern?: string;
}

export interface ResolveStorageProfileInput {
  appId: string;
  environment: Environment;
  profileId: string;
  operationClass: OperationClass;
  objectKey?: string;
  expectedConfiguration?: ProviderConfigurationExpectation;
}

export interface RequiredCapability {
  providerRole: ProviderRole;
  capability: Capability;
  acceptance: 'passed' | 'passed-or-not-supported';
}

export interface CapabilityReadinessInput {
  profileId: string;
  profileVersion: number;
  prefixClassId: string;
  bindings: StorageProfileProviderBinding[];
}

export interface RecordCapabilityResultInput extends StorageCapabilityResult {}

export interface StorageProfileRegistry {
  resolve(input: ResolveStorageProfileInput): Promise<ResolvedStorageProfileAssignment>;
  getActiveProfileVersion(profileId: string): Promise<number | null>;
  listRequiredCapabilities(profileId: string, operationClass: OperationClass): Promise<RequiredCapability[]>;
}

export interface StorageCapabilityRegistry {
  recordResult(input: RecordCapabilityResultInput): Promise<void>;
  assertReady(input: CapabilityReadinessInput): Promise<ProviderCapabilityPolicy>;
}

export interface StoragePrefixAuthorizer {
  assertObjectKeyAllowed(input: {
    profileId: string;
    profileVersion: number;
    operationClass: OperationClass;
    objectKey: string;
  }): Promise<void>;
}

export interface ControlPlaneDataSet {
  managedApps: ManagedAppEnvironment[];
  providers: StorageProviderRecord[];
  profiles: StorageProfileRecord[];
  bindings: StorageProfileProviderBinding[];
  prefixClasses: StoragePrefixClass[];
  capabilityResults: StorageCapabilityResult[];
}

export interface ServerSideProviderCredentialBinding {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

export interface StorageSecretResolver {
  resolve(referenceId: string): Promise<ServerSideProviderCredentialBinding>;
}
