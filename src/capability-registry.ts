import type {
  Capability,
  CapabilityReadinessInput,
  ProviderCapabilityPolicy,
  RecordCapabilityResultInput,
  StorageCapabilityRegistry,
  StorageCapabilityResult,
} from './domain.js';
import { fail } from './errors.js';

const STRICT_REQUIRED_CAPABILITIES: Capability[] = ['put', 'head', 'get', 'delete', 'checksum'];

function resultIdentity(result: StorageCapabilityResult): string {
  return [
    result.capabilityRunId,
    result.profileId,
    result.profileVersion,
    result.providerId,
    result.bucketLabel,
    result.prefixClassId,
    result.capability,
  ].join('|');
}

export class InMemoryStorageCapabilityRegistry implements StorageCapabilityRegistry {
  readonly #results: StorageCapabilityResult[];
  readonly #clock: () => Date;

  constructor(results: StorageCapabilityResult[], clock: () => Date = () => new Date()) {
    this.#results = results;
    this.#clock = clock;
  }

  async recordResult(input: RecordCapabilityResultInput): Promise<void> {
    const index = this.#results.findIndex((record) => resultIdentity(record) === resultIdentity(input));
    if (index >= 0) {
      this.#results[index] = { ...input };
      return;
    }
    this.#results.push({ ...input });
  }

  #currentResult(input: {
    profileId: string;
    profileVersion: number;
    providerId: string;
    bucketLabel: string;
    prefixClassId: string;
    capability: Capability;
  }): StorageCapabilityResult {
    const matches = this.#results
      .filter(
        (result) =>
          result.profileId === input.profileId &&
          result.profileVersion === input.profileVersion &&
          result.providerId === input.providerId &&
          result.bucketLabel === input.bucketLabel &&
          result.prefixClassId === input.prefixClassId &&
          result.capability === input.capability,
      )
      .sort((left, right) => Date.parse(right.verifiedAt) - Date.parse(left.verifiedAt));

    const result = matches[0];
    if (!result) {
      fail('capability-not-verified');
    }
    if (result.expiresAt !== null && Date.parse(result.expiresAt) <= this.#clock().getTime()) {
      fail('capability-expired');
    }
    return result;
  }

  async assertReady(input: CapabilityReadinessInput): Promise<ProviderCapabilityPolicy> {
    let hasUnsupportedSize = false;
    const rangeStates: Array<'passed' | 'not-supported' | 'missing'> = [];

    for (const binding of input.bindings) {
      for (const capability of STRICT_REQUIRED_CAPABILITIES) {
        const result = this.#currentResult({
          profileId: input.profileId,
          profileVersion: input.profileVersion,
          providerId: binding.providerId,
          bucketLabel: binding.bucketLabel,
          prefixClassId: input.prefixClassId,
          capability,
        });
        if (result.result !== 'passed') {
          fail('capability-failed');
        }
      }

      const sizeResult = this.#currentResult({
        profileId: input.profileId,
        profileVersion: input.profileVersion,
        providerId: binding.providerId,
        bucketLabel: binding.bucketLabel,
        prefixClassId: input.prefixClassId,
        capability: 'size',
      });
      if (sizeResult.result === 'failed') {
        fail('capability-failed');
      }
      if (sizeResult.result === 'not-supported') {
        hasUnsupportedSize = true;
      }

      const rangeMatches = this.#results
        .filter(
          (result) =>
            result.profileId === input.profileId &&
            result.profileVersion === input.profileVersion &&
            result.providerId === binding.providerId &&
            result.bucketLabel === binding.bucketLabel &&
            result.prefixClassId === input.prefixClassId &&
            result.capability === 'range',
        )
        .sort((left, right) => Date.parse(right.verifiedAt) - Date.parse(left.verifiedAt));
      const rangeResult = rangeMatches[0];
      if (!rangeResult) {
        rangeStates.push('missing');
      } else if (
        rangeResult.expiresAt !== null &&
        Date.parse(rangeResult.expiresAt) <= this.#clock().getTime()
      ) {
        rangeStates.push('missing');
      } else if (rangeResult.result === 'failed') {
        fail('capability-failed');
      } else {
        rangeStates.push(rangeResult.result);
      }
    }

    const rangeRead = rangeStates.every((state) => state === 'passed')
      ? 'required'
      : rangeStates.every((state) => state === 'not-supported')
        ? 'not-applicable'
        : 'optional';

    return {
      checksumVerification: 'required',
      sizeVerification: 'required-when-supported',
      headContentLength: hasUnsupportedSize ? 'optional-with-checksum' : 'required',
      rangeRead,
    };
  }
}
