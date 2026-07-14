import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IntegrityVerificationError,
  verifyProviderWrite,
  type ProviderCapabilityPolicy,
} from '../src/index.js';

const r2Policy: ProviderCapabilityPolicy = {
  checksumVerification: 'required',
  sizeVerification: 'required-when-supported',
  headContentLength: 'optional-with-checksum',
  rangeRead: 'optional',
};

const strictPolicy: ProviderCapabilityPolicy = {
  checksumVerification: 'required',
  sizeVerification: 'required-when-supported',
  headContentLength: 'required',
  rangeRead: 'required',
};

const base = {
  expectedProviderId: 'r2_video_maker_dev_01',
  expectedBucketLabel: 'video-maker-hot',
  normalizedPrefixPattern: 'video-maker/user-resources/*',
  objectKey: 'video-maker/user-resources/generated-file.bin',
  expectedChecksum: 'sha256:abc',
  expectedSizeBytes: 12,
  observedProviderId: 'r2_video_maker_dev_01',
  observedBucketLabel: 'video-maker-hot',
  observedChecksum: 'sha256:abc',
  observedSizeBytes: 12,
};

test('R2 policy permits absent HEAD size only with matching checksum evidence', () => {
  const result = verifyProviderWrite({
    ...base,
    observedSizeBytes: null,
    capabilityPolicy: r2Policy,
  });
  assert.deepEqual(result, {
    verified: true,
    checksumVerified: true,
    sizeVerified: false,
    sizeVerificationDisposition: 'unsupported-with-checksum',
  });
});

test('strict size policy rejects absent size', () => {
  assert.throws(
    () =>
      verifyProviderWrite({
        ...base,
        observedSizeBytes: null,
        capabilityPolicy: strictPolicy,
      }),
    (error: unknown) => {
      assert.ok(error instanceof IntegrityVerificationError);
      assert.equal(error.code, 'integrity-size-unavailable');
      return true;
    },
  );
});

test('checksum mismatch remains a hard integrity failure', () => {
  assert.throws(
    () =>
      verifyProviderWrite({
        ...base,
        observedChecksum: 'sha256:different',
        observedSizeBytes: null,
        capabilityPolicy: r2Policy,
      }),
    (error: unknown) => {
      assert.ok(error instanceof IntegrityVerificationError);
      assert.equal(error.code, 'integrity-checksum-mismatch');
      return true;
    },
  );
});

test('conflicting size remains a hard integrity failure', () => {
  assert.throws(
    () =>
      verifyProviderWrite({
        ...base,
        observedSizeBytes: 13,
        capabilityPolicy: r2Policy,
      }),
    (error: unknown) => {
      assert.ok(error instanceof IntegrityVerificationError);
      assert.equal(error.code, 'integrity-size-mismatch');
      return true;
    },
  );
});

test('provider, bucket, and prefix conflicts fail independently', () => {
  const cases = [
    [{ observedProviderId: 'other-provider' }, 'integrity-provider-mismatch'],
    [{ observedBucketLabel: 'other-bucket' }, 'integrity-bucket-mismatch'],
    [{ objectKey: 'video-maker/other/file.bin' }, 'integrity-prefix-mismatch'],
  ] as const;
  for (const [override, code] of cases) {
    assert.throws(
      () => verifyProviderWrite({ ...base, ...override, capabilityPolicy: r2Policy }),
      (error: unknown) => {
        assert.ok(error instanceof IntegrityVerificationError);
        assert.equal(error.code, code);
        return true;
      },
    );
  }
});
