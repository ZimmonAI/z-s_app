import type {
  Capability,
  ControlPlaneDataSet,
  StorageCapabilityResult,
  StorageProfileProviderBinding,
} from '../src/domain.js';

const VERIFIED_AT = '2026-07-14T00:00:00.000Z';
const EXPIRES_AT = '2026-07-15T00:00:00.000Z';

function capabilityRecords(input: {
  profileId: string;
  profileVersion: number;
  prefixClassId: string;
  binding: StorageProfileProviderBinding;
  size: 'passed' | 'not-supported';
  range: 'passed' | 'not-supported';
}): StorageCapabilityResult[] {
  const strict: Capability[] = ['put', 'head', 'get', 'delete', 'checksum'];
  return [
    ...strict.map((capability) => ({
      capabilityRunId: `run-${input.profileId}-${input.binding.providerRole}`,
      profileId: input.profileId,
      profileVersion: input.profileVersion,
      providerId: input.binding.providerId,
      bucketLabel: input.binding.bucketLabel,
      prefixClassId: input.prefixClassId,
      capability,
      result: 'passed' as const,
      verifiedAt: VERIFIED_AT,
      expiresAt: EXPIRES_AT,
      safeEvidenceRef: null,
    })),
    {
      capabilityRunId: `run-${input.profileId}-${input.binding.providerRole}`,
      profileId: input.profileId,
      profileVersion: input.profileVersion,
      providerId: input.binding.providerId,
      bucketLabel: input.binding.bucketLabel,
      prefixClassId: input.prefixClassId,
      capability: 'size',
      result: input.size,
      verifiedAt: VERIFIED_AT,
      expiresAt: EXPIRES_AT,
      safeEvidenceRef: null,
    },
    {
      capabilityRunId: `run-${input.profileId}-${input.binding.providerRole}`,
      profileId: input.profileId,
      profileVersion: input.profileVersion,
      providerId: input.binding.providerId,
      bucketLabel: input.binding.bucketLabel,
      prefixClassId: input.prefixClassId,
      capability: 'range',
      result: input.range,
      verifiedAt: VERIFIED_AT,
      expiresAt: EXPIRES_AT,
      safeEvidenceRef: null,
    },
  ];
}

export function createReadyDataSet(): ControlPlaneDataSet {
  const defaultHot: StorageProfileProviderBinding = {
    profileId: 'video-maker-dev-default',
    profileVersion: 1,
    providerRole: 'hot',
    providerId: 'r2_video_maker_dev_01',
    bucketLabel: 'video-maker-hot',
    required: true,
  };
  const defaultCanonical: StorageProfileProviderBinding = {
    profileId: 'video-maker-dev-default',
    profileVersion: 1,
    providerRole: 'canonical',
    providerId: 'minio_zimspace_local_pc_01',
    bucketLabel: 'zs-dev-app-video-maker-canon',
    required: true,
  };
  const privateCanonical: StorageProfileProviderBinding = {
    profileId: 'video-maker-dev-private',
    profileVersion: 1,
    providerRole: 'canonical',
    providerId: 'minio_zimspace_local_pc_01',
    bucketLabel: 'zs-dev-app-video-maker-private',
    required: true,
  };

  return {
    managedApps: [
      { appId: 'video-maker_app', environment: 'dev', status: 'active' },
      { appId: 'disabled_app', environment: 'dev', status: 'disabled' },
      { appId: 'other_app', environment: 'dev', status: 'active' },
    ],
    providers: [
      {
        providerId: 'r2_video_maker_dev_01',
        providerType: 'r2',
        status: 'active',
        secretReferenceId: 'credential-binding:r2_video_maker_dev_01',
      },
      {
        providerId: 'minio_zimspace_local_pc_01',
        providerType: 'minio',
        status: 'active',
        secretReferenceId: 'credential-binding:minio_zimspace_local_pc_01',
      },
      {
        providerId: 'disabled_provider',
        providerType: 's3-compatible',
        status: 'disabled',
        secretReferenceId: 'credential-binding:disabled_provider',
      },
    ],
    profiles: [
      {
        profileId: 'video-maker-dev-default',
        appId: 'video-maker_app',
        environment: 'dev',
        version: 1,
        status: 'active',
      },
      {
        profileId: 'video-maker-dev-private',
        appId: 'video-maker_app',
        environment: 'dev',
        version: 1,
        status: 'active',
      },
      {
        profileId: 'video-maker-dev-draft',
        appId: 'video-maker_app',
        environment: 'dev',
        version: 1,
        status: 'draft',
      },
      {
        profileId: 'video-maker-dev-disabled',
        appId: 'video-maker_app',
        environment: 'dev',
        version: 1,
        status: 'disabled',
      },
      {
        profileId: 'shared-name-profile',
        appId: 'other_app',
        environment: 'dev',
        version: 1,
        status: 'active',
      },
    ],
    bindings: [defaultHot, defaultCanonical, privateCanonical],
    prefixClasses: [
      {
        prefixClassId: 'video-maker-user-resource',
        profileId: 'video-maker-dev-default',
        profileVersion: 1,
        operationClass: 'user-upload',
        normalizedPrefixPattern: 'video-maker/user-resources/*',
        status: 'active',
      },
      {
        prefixClassId: 'video-maker-capability-probe',
        profileId: 'video-maker-dev-default',
        profileVersion: 1,
        operationClass: 'capability-probe',
        normalizedPrefixPattern: 'video-maker/user-resources/capability/*',
        status: 'active',
      },
      {
        prefixClassId: 'video-maker-private-document',
        profileId: 'video-maker-dev-private',
        profileVersion: 1,
        operationClass: 'private-document',
        normalizedPrefixPattern: 'video-maker/private/*',
        status: 'active',
      },
    ],
    capabilityResults: [
      ...capabilityRecords({
        profileId: 'video-maker-dev-default',
        profileVersion: 1,
        prefixClassId: 'video-maker-user-resource',
        binding: defaultHot,
        size: 'not-supported',
        range: 'not-supported',
      }),
      ...capabilityRecords({
        profileId: 'video-maker-dev-default',
        profileVersion: 1,
        prefixClassId: 'video-maker-user-resource',
        binding: defaultCanonical,
        size: 'passed',
        range: 'passed',
      }),
      ...capabilityRecords({
        profileId: 'video-maker-dev-private',
        profileVersion: 1,
        prefixClassId: 'video-maker-private-document',
        binding: privateCanonical,
        size: 'passed',
        range: 'passed',
      }),
    ],
  };
}

export function cloneDataSet(data: ControlPlaneDataSet): ControlPlaneDataSet {
  return structuredClone(data);
}

export const TEST_CLOCK = (): Date => new Date('2026-07-14T12:00:00.000Z');
