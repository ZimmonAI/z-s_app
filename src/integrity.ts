import type { ProviderCapabilityPolicy } from './domain.js';
import { objectKeyMatchesPattern } from './prefix-authorizer.js';

export type IntegrityErrorCode =
  | 'integrity-provider-mismatch'
  | 'integrity-bucket-mismatch'
  | 'integrity-prefix-mismatch'
  | 'integrity-checksum-required'
  | 'integrity-checksum-mismatch'
  | 'integrity-size-unavailable'
  | 'integrity-size-mismatch';

export class IntegrityVerificationError extends Error {
  readonly code: IntegrityErrorCode;

  constructor(code: IntegrityErrorCode) {
    super(code);
    this.name = 'IntegrityVerificationError';
    this.code = code;
  }
}

export interface VerifyProviderWriteInput {
  expectedProviderId: string;
  expectedBucketLabel: string;
  normalizedPrefixPattern: string;
  objectKey: string;
  expectedChecksum: string | null;
  expectedSizeBytes: number | null;
  observedProviderId: string;
  observedBucketLabel: string;
  observedChecksum: string | null;
  observedSizeBytes: number | null;
  capabilityPolicy: ProviderCapabilityPolicy;
}

export interface IntegrityVerificationResult {
  verified: true;
  checksumVerified: true;
  sizeVerified: boolean;
  sizeVerificationDisposition: 'matched' | 'not-supplied' | 'unsupported-with-checksum';
}

function integrityFail(code: IntegrityErrorCode): never {
  throw new IntegrityVerificationError(code);
}

export function verifyProviderWrite(
  input: VerifyProviderWriteInput,
): IntegrityVerificationResult {
  if (input.expectedProviderId !== input.observedProviderId) {
    integrityFail('integrity-provider-mismatch');
  }
  if (input.expectedBucketLabel !== input.observedBucketLabel) {
    integrityFail('integrity-bucket-mismatch');
  }
  if (!objectKeyMatchesPattern(input.objectKey, input.normalizedPrefixPattern)) {
    integrityFail('integrity-prefix-mismatch');
  }
  if (input.expectedChecksum === null || input.observedChecksum === null) {
    integrityFail('integrity-checksum-required');
  }
  if (input.expectedChecksum !== input.observedChecksum) {
    integrityFail('integrity-checksum-mismatch');
  }

  if (input.expectedSizeBytes === null) {
    return {
      verified: true,
      checksumVerified: true,
      sizeVerified: false,
      sizeVerificationDisposition: 'not-supplied',
    };
  }

  if (input.observedSizeBytes === null) {
    if (input.capabilityPolicy.headContentLength !== 'optional-with-checksum') {
      integrityFail('integrity-size-unavailable');
    }
    return {
      verified: true,
      checksumVerified: true,
      sizeVerified: false,
      sizeVerificationDisposition: 'unsupported-with-checksum',
    };
  }

  if (input.expectedSizeBytes !== input.observedSizeBytes) {
    integrityFail('integrity-size-mismatch');
  }

  return {
    verified: true,
    checksumVerified: true,
    sizeVerified: true,
    sizeVerificationDisposition: 'matched',
  };
}
