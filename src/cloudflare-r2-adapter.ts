import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import {
  StorageProviderAdapterError,
  type StorageProviderAdapter,
  type StorageProviderManifest,
  type StorageProviderTestInput,
  type StorageProviderTestResult,
} from './storage-provider-adapter.js';
import type { ResolvedS3CredentialBinding } from './runtime-s3-provider.js';

interface S3ClientLike {
  send(command: unknown): Promise<Record<string, unknown>>;
  destroy?: () => void;
}

export interface CloudflareR2AdapterOptions {
  readonly createClient?: (config: S3ClientConfig) => S3ClientLike;
  readonly now?: () => Date;
  readonly nonce?: () => string;
}

const SAFE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,159}$/;
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i;
const ACCESS_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

const MANIFEST: StorageProviderManifest = Object.freeze({
  providerType: 'cloudflare-r2',
  displayName: 'Cloudflare R2',
  protocolFamily: 's3-compatible-object-storage',
  adapterStatus: 'accepted',
  setupFields: Object.freeze([
    { name: 'accountId', label: 'Account ID', secret: true, required: true, maximumLength: 64 },
    { name: 'accessKeyId', label: 'Access key ID', secret: true, required: true, maximumLength: 128 },
    { name: 'secretAccessKey', label: 'Secret access key', secret: true, required: true, maximumLength: 256 },
    { name: 'bucket', label: 'Bounded test bucket', secret: true, required: true, maximumLength: 63 },
  ]),
  capabilities: Object.freeze({
    objectWrite: true,
    objectRead: true,
    objectHead: true,
    rangeRead: true,
    objectDelete: true,
    copyVerification: true,
    replicaTarget: true,
    derivativeOutputTarget: true,
    retentionDeleteTarget: true,
  }),
  requiredOperations: Object.freeze([
    'object.write',
    'object.read',
    'object.head',
    'object.range-read',
    'object.delete',
  ]),
  forbiddenOutputs: Object.freeze([
    'rawCredential',
    'secretReference',
    'providerPrivateEndpoint',
    'bucket',
    'objectKey',
    'signedUrl',
  ]),
});

function required(
  value: Readonly<Record<string, string>>,
  name: string,
  maximumLength: number,
): string {
  const result = value[name]?.trim();
  if (result === undefined || result.length < 1 || result.length > maximumLength) {
    throw new StorageProviderAdapterError(400, `invalid-r2-${name}`);
  }
  return result;
}

function httpStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const metadata = (error as Record<string, unknown>).$metadata;
  if (metadata === null || typeof metadata !== 'object') return undefined;
  const status = (metadata as Record<string, unknown>).httpStatusCode;
  return typeof status === 'number' ? status : undefined;
}

export class CloudflareR2Adapter implements StorageProviderAdapter {
  readonly #createClient: (config: S3ClientConfig) => S3ClientLike;
  readonly #now: () => Date;
  readonly #nonce: () => string;

  constructor(options: Readonly<CloudflareR2AdapterOptions> = {}) {
    this.#createClient = options.createClient ?? ((config) => new S3Client(config));
    this.#now = options.now ?? (() => new Date());
    this.#nonce = options.nonce ?? randomUUID;
  }

  getProviderManifest(): Readonly<StorageProviderManifest> {
    return MANIFEST;
  }

  validateSafeSetupMetadata(
    safeMetadata: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    const accountLabel = safeMetadata.accountLabel;
    if (
      accountLabel !== undefined &&
      (typeof accountLabel !== 'string' || !SAFE_LABEL_PATTERN.test(accountLabel))
    ) {
      throw new StorageProviderAdapterError(400, 'invalid-r2-account-label');
    }
    const region = safeMetadata.region;
    if (region !== undefined && region !== 'auto') {
      throw new StorageProviderAdapterError(400, 'invalid-r2-region');
    }
    return Object.freeze({
      ...(accountLabel === undefined ? {} : { accountLabel }),
      region: 'auto',
    });
  }

  validateSecretInput(
    secretInput: Readonly<Record<string, string>>,
  ): Readonly<Record<string, string>> {
    const accountId = required(secretInput, 'accountId', 64);
    const accessKeyId = required(secretInput, 'accessKeyId', 128);
    const secretAccessKey = required(secretInput, 'secretAccessKey', 256);
    const bucket = required(secretInput, 'bucket', 63);
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new StorageProviderAdapterError(400, 'invalid-r2-account-id');
    }
    if (!ACCESS_KEY_PATTERN.test(accessKeyId)) {
      throw new StorageProviderAdapterError(400, 'invalid-r2-access-key-id');
    }
    if (!BUCKET_PATTERN.test(bucket)) {
      throw new StorageProviderAdapterError(400, 'invalid-r2-test-bucket');
    }
    return Object.freeze({ accountId, accessKeyId, secretAccessKey, bucket });
  }

  resolveRuntimeBinding(
    credentials: Readonly<Record<string, string>>,
  ): Readonly<ResolvedS3CredentialBinding> {
    const validated = this.validateSecretInput(credentials);
    return Object.freeze({
      endpoint: `https://${validated.accountId}.r2.cloudflarestorage.com`,
      region: 'auto',
      forcePathStyle: false,
      accessKeyId: validated.accessKeyId ?? '',
      secretAccessKey: validated.secretAccessKey ?? '',
    });
  }

  normalizeProviderError(error: unknown): string {
    const status = httpStatus(error);
    if (status === 401 || status === 403) return 'r2-authentication-failed';
    if (status === 404) return 'r2-test-target-unavailable';
    if (status === 408 || status === 429 || (status !== undefined && status >= 500)) {
      return 'r2-provider-temporarily-unavailable';
    }
    return 'r2-connection-test-failed';
  }

  async testConnection(
    input: Readonly<StorageProviderTestInput>,
  ): Promise<Readonly<StorageProviderTestResult>> {
    const credentials = this.validateSecretInput(input.credentials);
    const prefix = input.testScope.prefix?.trim() ?? 'z-s-connection-test';
    if (!PREFIX_PATTERN.test(prefix) || prefix.includes('..') || prefix.startsWith('/')) {
      throw new StorageProviderAdapterError(400, 'invalid-r2-test-prefix');
    }
    const bucket = credentials.bucket ?? '';
    const key = `${prefix.replace(/\/$/, '')}/probe-${this.#nonce()}`;
    const binding = this.resolveRuntimeBinding(credentials);
    const client = this.#createClient({
      endpoint: binding.endpoint,
      region: binding.region,
      forcePathStyle: binding.forcePathStyle,
      credentials: {
        accessKeyId: binding.accessKeyId,
        secretAccessKey: binding.secretAccessKey,
      },
    });
    let connected = false;
    let diagnosticCode: string | null = null;
    try {
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: Uint8Array.of(0),
        ContentLength: 1,
        IfNoneMatch: '*',
        Metadata: { 'z-s-connection-test': '1' },
      }));
      const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      connected = result.ContentLength === 1;
      if (!connected) diagnosticCode = 'r2-connection-test-verification-failed';
    } catch (error) {
      diagnosticCode = this.normalizeProviderError(error);
    } finally {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch {
        diagnosticCode ??= 'r2-connection-test-cleanup-failed';
        connected = false;
      }
      client.destroy?.();
    }
    return Object.freeze({
      connected,
      capabilities: MANIFEST.capabilities,
      diagnosticCode,
      testedAt: this.#now().toISOString(),
    });
  }
}
