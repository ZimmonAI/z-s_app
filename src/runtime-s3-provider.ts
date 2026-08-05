import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import type { ProviderCapabilityPolicy } from './domain.js';
import {
  IntegrityVerificationError,
  verifyProviderWrite,
  type IntegrityVerificationResult,
} from './integrity.js';
import type { SafeDiagnostic, SafeDiagnosticCategory } from './runtime-contract.js';

export type ProviderWriteRole = 'hot' | 'canonical' | 'primary' | 'replica';

export interface ProviderCredentialScope {
  clientId: string;
  environment: 'dev' | 'staging' | 'prod';
}

export interface ResolvedProviderWriteTarget {
  providerRole: ProviderWriteRole;
  providerId: string;
  bucketLabel: string;
  internalLocator: string;
  normalizedPrefixPattern: string;
  capabilityPolicy: Readonly<ProviderCapabilityPolicy>;
  credentialSecretReferenceId: string;
  credentialScope?: Readonly<ProviderCredentialScope>;
}

export interface ResolvedS3CredentialBinding {
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface ProviderCredentialResolver {
  resolve(
    secretReferenceId: string,
    scope?: Readonly<ProviderCredentialScope>,
  ): Promise<Readonly<ResolvedS3CredentialBinding>> | Readonly<ResolvedS3CredentialBinding>;
}

export interface ProviderObservedMetadata {
  checksumSha256: string | null;
  byteLength: number | null;
}

export interface ProviderWriteReceipt {
  providerRole: ProviderWriteRole;
  observed: Readonly<ProviderObservedMetadata>;
  integrityVerification: Readonly<IntegrityVerificationResult>;
}

export interface ProviderCleanupResult {
  deleted: boolean;
  diagnostic?: Readonly<SafeDiagnostic>;
}

export interface ProviderWriteInput {
  target: Readonly<ResolvedProviderWriteTarget>;
  source: Readable;
  checksumSha256: string;
  byteLength: number;
}

export interface ProviderObjectWriter {
  write(input: Readonly<ProviderWriteInput>): Promise<Readonly<ProviderWriteReceipt>>;
  cleanup(input: {
    target: Readonly<ResolvedProviderWriteTarget>;
  }): Promise<Readonly<ProviderCleanupResult>>;
}

export class ProviderExecutionError extends Error {
  readonly category: SafeDiagnosticCategory;
  readonly code: string;
  readonly retryable: boolean;
  readonly cleanupRequired: boolean;

  constructor(
    category: SafeDiagnosticCategory,
    code: string,
    retryable: boolean,
    options: { cleanupRequired?: boolean } = {},
  ) {
    super(code);
    this.name = 'ProviderExecutionError';
    this.category = category;
    this.code = code;
    this.retryable = retryable;
    this.cleanupRequired = options.cleanupRequired ?? false;
  }

  toSafeDiagnostic(): Readonly<SafeDiagnostic> {
    return Object.freeze({
      category: this.category,
      code: this.code,
      retryable: this.retryable,
    });
  }
}

interface S3ClientLike {
  send(command: unknown): Promise<Record<string, unknown>>;
  destroy?: () => void;
}

export interface S3CompatibleProviderObjectWriterOptions {
  credentialResolver: ProviderCredentialResolver;
  createClient?: (config: S3ClientConfig) => S3ClientLike;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_LOCATOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/=-]{0,1023}$/;
const APPROVED_CHECKSUM_METADATA_KEY = 'z-s-sha256';

function invalidTarget(target: Readonly<ResolvedProviderWriteTarget>): boolean {
  return (
    !SAFE_ID_PATTERN.test(target.providerId) ||
    !SAFE_ID_PATTERN.test(target.bucketLabel) ||
    !SAFE_LOCATOR_PATTERN.test(target.internalLocator) ||
    target.internalLocator.includes('..') ||
    target.internalLocator.includes('://') ||
    target.internalLocator.startsWith('/') ||
    target.normalizedPrefixPattern.length < 2 ||
    !target.normalizedPrefixPattern.endsWith('*') ||
    target.credentialSecretReferenceId.length === 0
  );
}

function safeFailure(
  code: string,
  retryable = true,
  cleanupRequired = false,
): ProviderExecutionError {
  return new ProviderExecutionError('dependency-unavailable', code, retryable, { cleanupRequired });
}

function httpStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const metadata = (error as Record<string, unknown>).$metadata;
  if (metadata === null || typeof metadata !== 'object') return undefined;
  const value = (metadata as Record<string, unknown>).httpStatusCode;
  return typeof value === 'number' ? value : undefined;
}

function translateProviderError(error: unknown, phase: 'write' | 'verify' | 'cleanup'): ProviderExecutionError {
  if (error instanceof ProviderExecutionError) return error;
  if (error instanceof IntegrityVerificationError) {
    return new ProviderExecutionError('dependency-unavailable', error.code, false, {
      cleanupRequired: true,
    });
  }
  const cleanupRequired =
    phase === 'verify' || (phase === 'write' && httpStatus(error) !== 412);
  return safeFailure(`provider-${phase}-failed`, phase !== 'verify', cleanupRequired);
}

function clientConfig(binding: Readonly<ResolvedS3CredentialBinding>): S3ClientConfig {
  const credentials: S3ClientConfig['credentials'] = {
    accessKeyId: binding.accessKeyId,
    secretAccessKey: binding.secretAccessKey,
    ...(binding.sessionToken === undefined ? {} : { sessionToken: binding.sessionToken }),
  };
  return {
    endpoint: binding.endpoint,
    region: binding.region,
    forcePathStyle: binding.forcePathStyle,
    credentials,
  };
}

function observedChecksum(value: unknown): string | null {
  return typeof value === 'string' && SHA256_PATTERN.test(value) ? value : null;
}

function observedLength(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export class S3CompatibleProviderObjectWriter implements ProviderObjectWriter {
  readonly #resolver: ProviderCredentialResolver;
  readonly #createClient: (config: S3ClientConfig) => S3ClientLike;

  constructor(options: S3CompatibleProviderObjectWriterOptions) {
    this.#resolver = options.credentialResolver;
    this.#createClient = options.createClient ?? ((config) => new S3Client(config));
  }

  async write(input: Readonly<ProviderWriteInput>): Promise<Readonly<ProviderWriteReceipt>> {
    if (
      invalidTarget(input.target) ||
      !SHA256_PATTERN.test(input.checksumSha256) ||
      !Number.isSafeInteger(input.byteLength) ||
      input.byteLength <= 0
    ) {
      throw new ProviderExecutionError('invalid-request', 'provider-write-input-invalid', false);
    }

    const binding = await this.#resolver.resolve(
      input.target.credentialSecretReferenceId,
      input.target.credentialScope,
    );
    const client = this.#createClient(clientConfig(binding));
    try {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: input.target.bucketLabel,
            Key: input.target.internalLocator,
            Body: input.source,
            ContentLength: input.byteLength,
            Metadata: { [APPROVED_CHECKSUM_METADATA_KEY]: input.checksumSha256 },
            IfNoneMatch: '*',
          }),
        );
      } catch (error) {
        throw translateProviderError(error, 'write');
      }

      let head: Record<string, unknown>;
      try {
        head = await client.send(
          new HeadObjectCommand({
            Bucket: input.target.bucketLabel,
            Key: input.target.internalLocator,
          }),
        );
      } catch (error) {
        throw translateProviderError(error, 'verify');
      }
      const metadata = head.Metadata;
      const checksum = observedChecksum(
        metadata !== null && typeof metadata === 'object'
          ? (metadata as Record<string, unknown>)[APPROVED_CHECKSUM_METADATA_KEY]
          : null,
      );
      const byteLength = observedLength(head.ContentLength);
      let integrityVerification: IntegrityVerificationResult;
      try {
        integrityVerification = verifyProviderWrite({
          expectedProviderId: input.target.providerId,
          expectedBucketLabel: input.target.bucketLabel,
          normalizedPrefixPattern: input.target.normalizedPrefixPattern,
          objectKey: input.target.internalLocator,
          expectedChecksum: input.checksumSha256,
          expectedSizeBytes: input.byteLength,
          observedProviderId: input.target.providerId,
          observedBucketLabel: input.target.bucketLabel,
          observedChecksum: checksum,
          observedSizeBytes: byteLength,
          capabilityPolicy: input.target.capabilityPolicy,
        });
      } catch (error) {
        throw translateProviderError(error, 'verify');
      }
      return Object.freeze({
        providerRole: input.target.providerRole,
        observed: Object.freeze({ checksumSha256: checksum, byteLength }),
        integrityVerification: Object.freeze(integrityVerification),
      });
    } finally {
      client.destroy?.();
    }
  }

  async cleanup(input: {
    target: Readonly<ResolvedProviderWriteTarget>;
  }): Promise<Readonly<ProviderCleanupResult>> {
    if (invalidTarget(input.target)) {
      return Object.freeze({
        deleted: false,
        diagnostic: Object.freeze({
          category: 'invalid-request',
          code: 'provider-cleanup-target-invalid',
          retryable: false,
        }),
      });
    }
    let binding: Readonly<ResolvedS3CredentialBinding>;
    try {
      binding = await this.#resolver.resolve(
        input.target.credentialSecretReferenceId,
        input.target.credentialScope,
      );
    } catch {
      return Object.freeze({
        deleted: false,
        diagnostic: safeFailure('provider-cleanup-failed').toSafeDiagnostic(),
      });
    }
    const client = this.#createClient(clientConfig(binding));
    try {
      await client.send(
        new DeleteObjectCommand({
          Bucket: input.target.bucketLabel,
          Key: input.target.internalLocator,
        }),
      );
      return Object.freeze({ deleted: true });
    } catch (error) {
      return Object.freeze({
        deleted: false,
        diagnostic: translateProviderError(error, 'cleanup').toSafeDiagnostic(),
      });
    } finally {
      client.destroy?.();
    }
  }
}
