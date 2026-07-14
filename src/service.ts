import type {
  ResolveStorageProfileInput,
  ResolvedStorageProfileAssignment,
  StorageProfileRegistry,
} from './domain.js';

export class StorageControlPlaneService {
  readonly #profiles: StorageProfileRegistry;

  constructor(profiles: StorageProfileRegistry) {
    this.#profiles = profiles;
  }

  async resolveStorageProfileAssignment(
    input: ResolveStorageProfileInput,
  ): Promise<ResolvedStorageProfileAssignment> {
    return this.#profiles.resolve(input);
  }
}
