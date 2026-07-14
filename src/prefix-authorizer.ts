import type {
  OperationClass,
  StoragePrefixAuthorizer,
  StoragePrefixClass,
} from './domain.js';
import { fail } from './errors.js';

function patternPrefix(pattern: string): string {
  if (!pattern.endsWith('*') || pattern.includes('\\') || pattern.startsWith('/')) {
    fail('prefix-class-not-found');
  }
  return pattern.slice(0, -1);
}

export function objectKeyMatchesPattern(objectKey: string, pattern: string): boolean {
  if (objectKey.length === 0 || objectKey.includes('\\') || objectKey.startsWith('/')) {
    return false;
  }
  const segments = objectKey.split('/');
  if (segments.includes('..') || segments.includes('.')) {
    return false;
  }
  const prefix = patternPrefix(pattern);
  return objectKey.startsWith(prefix) && objectKey.length > prefix.length;
}

export class InMemoryStoragePrefixAuthorizer implements StoragePrefixAuthorizer {
  readonly #prefixClasses: StoragePrefixClass[];

  constructor(prefixClasses: StoragePrefixClass[]) {
    this.#prefixClasses = prefixClasses;
  }

  findActivePrefixClass(input: {
    profileId: string;
    profileVersion: number;
    operationClass: OperationClass;
  }): StoragePrefixClass {
    const matches = this.#prefixClasses.filter(
      (record) =>
        record.profileId === input.profileId &&
        record.profileVersion === input.profileVersion &&
        record.operationClass === input.operationClass &&
        record.status === 'active',
    );

    if (matches.length === 0) {
      fail('prefix-class-not-found');
    }
    if (matches.length > 1) {
      fail('prefix-class-ambiguous');
    }
    return matches[0] as StoragePrefixClass;
  }

  async assertObjectKeyAllowed(input: {
    profileId: string;
    profileVersion: number;
    operationClass: OperationClass;
    objectKey: string;
  }): Promise<void> {
    const prefixClass = this.findActivePrefixClass(input);
    if (!objectKeyMatchesPattern(input.objectKey, prefixClass.normalizedPrefixPattern)) {
      fail('object-key-outside-prefix');
    }
  }
}
