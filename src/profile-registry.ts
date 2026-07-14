import type {
  ControlPlaneDataSet,
  OperationClass,
  ProviderRole,
  RequiredCapability,
  ResolveStorageProfileInput,
  ResolvedStorageProfileAssignment,
  StorageProfileProviderBinding,
  StorageProfileRegistry,
} from './domain.js';
import { InMemoryStorageCapabilityRegistry } from './capability-registry.js';
import { fail } from './errors.js';
import { createSafeFingerprint, createSafeFingerprintPayload } from './fingerprint.js';
import { InMemoryStoragePrefixAuthorizer } from './prefix-authorizer.js';

function requiredRoles(
  operationClass: OperationClass,
  bindings: StorageProfileProviderBinding[],
): ProviderRole[] {
  if (operationClass === 'private-document') {
    return ['canonical'];
  }
  if (operationClass === 'capability-probe') {
    const required = bindings.filter((binding) => binding.required).map((binding) => binding.providerRole);
    return [...new Set<ProviderRole>(['canonical', ...required])];
  }
  return ['hot', 'canonical'];
}

function assertConfiguration(
  input: ResolveStorageProfileInput,
  hot: StorageProfileProviderBinding | null,
  canonical: StorageProfileProviderBinding,
  prefix: string,
): void {
  const expected = input.expectedConfiguration;
  if (!expected) {
    return;
  }
  const conflicts =
    (expected.hotProviderId !== undefined && expected.hotProviderId !== (hot?.providerId ?? null)) ||
    (expected.hotBucket !== undefined && expected.hotBucket !== (hot?.bucketLabel ?? null)) ||
    (expected.canonicalProviderId !== undefined &&
      expected.canonicalProviderId !== canonical.providerId) ||
    (expected.canonicalBucket !== undefined && expected.canonicalBucket !== canonical.bucketLabel) ||
    (expected.normalizedPrefixPattern !== undefined &&
      expected.normalizedPrefixPattern !== prefix);
  if (conflicts) {
    fail('configuration-conflict');
  }
}

export class InMemoryStorageProfileRegistry implements StorageProfileRegistry {
  readonly #data: ControlPlaneDataSet;
  readonly #capabilities: InMemoryStorageCapabilityRegistry;
  readonly #prefixes: InMemoryStoragePrefixAuthorizer;

  constructor(data: ControlPlaneDataSet, clock: () => Date = () => new Date()) {
    this.#data = data;
    this.#capabilities = new InMemoryStorageCapabilityRegistry(data.capabilityResults, clock);
    this.#prefixes = new InMemoryStoragePrefixAuthorizer(data.prefixClasses);
  }

  get capabilityRegistry(): InMemoryStorageCapabilityRegistry {
    return this.#capabilities;
  }

  async resolve(input: ResolveStorageProfileInput): Promise<ResolvedStorageProfileAssignment> {
    const managedApp = this.#data.managedApps.find(
      (record) => record.appId === input.appId && record.environment === input.environment,
    );
    if (!managedApp) {
      fail('managed-app-not-found');
    }
    if (managedApp.status !== 'active') {
      fail('managed-app-disabled');
    }

    const profilesById = this.#data.profiles.filter((profile) => profile.profileId === input.profileId);
    if (profilesById.length === 0) {
      fail('profile-not-found');
    }
    const scopedProfiles = profilesById.filter(
      (profile) => profile.appId === input.appId && profile.environment === input.environment,
    );
    if (scopedProfiles.length === 0) {
      fail('profile-app-mismatch');
    }
    const activeProfiles = scopedProfiles.filter((profile) => profile.status === 'active');
    if (activeProfiles.length === 0) {
      fail('profile-not-active');
    }
    if (activeProfiles.length > 1) {
      fail('profile-version-ambiguous');
    }
    const profile = activeProfiles[0];
    if (!profile) {
      fail('profile-not-active');
    }

    const profileBindings = this.#data.bindings.filter(
      (binding) =>
        binding.profileId === profile.profileId && binding.profileVersion === profile.version,
    );
    const roles = requiredRoles(input.operationClass, profileBindings);
    const selectedBindings: StorageProfileProviderBinding[] = [];
    for (const role of roles) {
      const matches = profileBindings.filter((binding) => binding.providerRole === role);
      if (matches.length === 0) {
        fail('provider-binding-missing');
      }
      if (matches.length > 1) {
        fail('provider-binding-ambiguous');
      }
      selectedBindings.push(matches[0] as StorageProfileProviderBinding);
    }

    const canonical = selectedBindings.find((binding) => binding.providerRole === 'canonical');
    if (!canonical) {
      fail('provider-binding-missing');
    }
    const hot = selectedBindings.find((binding) => binding.providerRole === 'hot') ?? null;

    for (const binding of selectedBindings) {
      const provider = this.#data.providers.find(
        (candidate) => candidate.providerId === binding.providerId,
      );
      if (!provider) {
        fail('provider-not-found');
      }
      if (provider.status !== 'active') {
        fail('provider-disabled');
      }
    }

    const prefixClass = this.#prefixes.findActivePrefixClass({
      profileId: profile.profileId,
      profileVersion: profile.version,
      operationClass: input.operationClass,
    });

    if (input.objectKey !== undefined) {
      await this.#prefixes.assertObjectKeyAllowed({
        profileId: profile.profileId,
        profileVersion: profile.version,
        operationClass: input.operationClass,
        objectKey: input.objectKey,
      });
    }

    assertConfiguration(input, hot, canonical, prefixClass.normalizedPrefixPattern);

    const capabilityPolicy = await this.#capabilities.assertReady({
      profileId: profile.profileId,
      profileVersion: profile.version,
      prefixClassId: prefixClass.prefixClassId,
      bindings: selectedBindings,
    });

    const hotProvider = hot
      ? { providerId: hot.providerId, bucketLabel: hot.bucketLabel }
      : null;
    const canonicalProvider = {
      providerId: canonical.providerId,
      bucketLabel: canonical.bucketLabel,
    };
    const fingerprintPayload = createSafeFingerprintPayload({
      appId: profile.appId,
      environment: profile.environment,
      profileId: profile.profileId,
      profileVersion: profile.version,
      hotProvider,
      canonicalProvider,
      prefixClassId: prefixClass.prefixClassId,
    });

    return {
      appId: profile.appId,
      environment: profile.environment,
      profileId: profile.profileId,
      profileVersion: profile.version,
      hotProvider,
      canonicalProvider,
      prefixClassId: prefixClass.prefixClassId,
      normalizedPrefixPattern: prefixClass.normalizedPrefixPattern,
      capabilityPolicy,
      safeFingerprint: createSafeFingerprint(fingerprintPayload),
    };
  }

  async getActiveProfileVersion(profileId: string): Promise<number | null> {
    const active = this.#data.profiles.filter(
      (profile) => profile.profileId === profileId && profile.status === 'active',
    );
    return active.length === 1 ? (active[0]?.version ?? null) : null;
  }

  async listRequiredCapabilities(
    profileId: string,
    operationClass: OperationClass,
  ): Promise<RequiredCapability[]> {
    const active = this.#data.profiles.filter(
      (profile) => profile.profileId === profileId && profile.status === 'active',
    );
    if (active.length !== 1) {
      return [];
    }
    const profile = active[0];
    if (!profile) {
      return [];
    }
    const bindings = this.#data.bindings.filter(
      (binding) =>
        binding.profileId === profile.profileId && binding.profileVersion === profile.version,
    );
    const roles = requiredRoles(operationClass, bindings);
    return roles.flatMap((providerRole) => [
      { providerRole, capability: 'put' as const, acceptance: 'passed' as const },
      { providerRole, capability: 'head' as const, acceptance: 'passed' as const },
      { providerRole, capability: 'get' as const, acceptance: 'passed' as const },
      { providerRole, capability: 'delete' as const, acceptance: 'passed' as const },
      { providerRole, capability: 'checksum' as const, acceptance: 'passed' as const },
      {
        providerRole,
        capability: 'size' as const,
        acceptance: 'passed-or-not-supported' as const,
      },
    ]);
  }
}
