import { createHash } from 'node:crypto';
import {
  CAPABILITY_POLICY_VERSION,
  type ResolvedStorageProfileAssignment,
  type SafeProviderAssignment,
} from './domain.js';

export interface SafeFingerprintPayload {
  app_id: string;
  environment: string;
  profile_id: string;
  profile_version: number;
  hot_provider_id: string | null;
  hot_bucket: string | null;
  canonical_provider_id: string;
  canonical_bucket: string;
  prefix_class_id: string;
  capability_policy_version: string;
}

export function createSafeFingerprintPayload(input: {
  appId: string;
  environment: string;
  profileId: string;
  profileVersion: number;
  hotProvider: SafeProviderAssignment | null;
  canonicalProvider: SafeProviderAssignment;
  prefixClassId: string;
}): SafeFingerprintPayload {
  return {
    app_id: input.appId,
    environment: input.environment,
    profile_id: input.profileId,
    profile_version: input.profileVersion,
    hot_provider_id: input.hotProvider?.providerId ?? null,
    hot_bucket: input.hotProvider?.bucketLabel ?? null,
    canonical_provider_id: input.canonicalProvider.providerId,
    canonical_bucket: input.canonicalProvider.bucketLabel,
    prefix_class_id: input.prefixClassId,
    capability_policy_version: CAPABILITY_POLICY_VERSION,
  };
}

export function createSafeFingerprint(
  payload: SafeFingerprintPayload,
): ResolvedStorageProfileAssignment['safeFingerprint'] {
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return `zs-profile-v1:${digest}`;
}
