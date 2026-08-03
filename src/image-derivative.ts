import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { ClientStorageEnvironment } from './client-storage-configuration.js';

export const IMAGE_DERIVATIVE_LIMITS = Object.freeze({
  acceptedInputMimeTypes: Object.freeze(['image/png'] as const),
  maximumSourceBytes: 32 * 1024 * 1024,
  maximumDecodedPixels: 64 * 1024 * 1024,
  minimumWidth: 16,
  maximumWidth: 16_384,
  maximumWidthsPerPreset: 8,
  minimumQuality: 1,
  maximumQuality: 100,
  maximumOutputBytes: 16 * 1024 * 1024,
  maximumConcurrentJobs: 2,
  maximumAttempts: 3,
  retryDelayMs: 60_000,
  leaseDurationMs: 5 * 60_000,
  statusResultLimit: 50,
});

export type ImageDerivativeJobState = 'queued' | 'processing' | 'succeeded' | 'failed';
export type ImageDerivativeOutputFormat = 'webp' | 'avif' | 'jpeg' | 'png';
export type ImageDerivativeFit = 'inside' | 'cover' | 'contain' | 'fill';
export type ImageDerivativeDiagnosticCategory =
  | 'invalid-request'
  | 'duplicate-conflict'
  | 'not-ready'
  | 'dependency-unavailable'
  | 'internal';

export interface ImageDerivativeJob {
  readonly id: string;
  readonly sourceStorageObjectId: string;
  readonly storageControlClientId: string;
  readonly environment: ClientStorageEnvironment;
  readonly configurationVersionId: string;
  readonly configurationFingerprint: string;
  readonly configurationRouteId: string;
  readonly configurationImagePresetId: string;
  readonly presetId: string;
  readonly targetConfigurationVaultId: string;
  readonly requestedWidth: number;
  readonly outputFormat: ImageDerivativeOutputFormat;
  readonly quality: number;
  readonly fit: ImageDerivativeFit;
  readonly state: ImageDerivativeJobState;
  readonly attemptCount: number;
  readonly maximumAttempts: number;
  readonly leaseToken: string;
}

export interface ImageDerivativeStatus {
  readonly jobId: string;
  readonly sourceStorageObjectId: string;
  readonly outputStorageObjectId?: string;
  readonly presetId: string;
  readonly width: number;
  readonly format: ImageDerivativeOutputFormat;
  readonly state: ImageDerivativeJobState;
  readonly attemptCount: number;
  readonly safeDiagnosticCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt?: string;
}

export interface ImageDerivativeSource {
  readonly mediaType: string;
  readonly byteLength: number;
  readonly checksumSha256: string;
  readonly body: Readable;
  close(): void;
}

export interface ProcessedImageDerivative {
  readonly mediaType: 'image/png';
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly checksumSha256: string;
  readonly body: Uint8Array;
}

export interface VerifiedImageDerivativeOutput {
  readonly storageObjectId: string;
  readonly byteLength: number;
  readonly checksumSha256: string;
}

export interface ImageDerivativeClaimInput {
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly maximumAttempts: number;
  readonly now?: Date;
}

export interface ImageDerivativeFailureInput {
  readonly job: Readonly<ImageDerivativeJob>;
  readonly category: ImageDerivativeDiagnosticCategory;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryDelayMs: number;
  readonly now?: Date;
}

export interface ImageDerivativeStore {
  readonly configured: boolean;
  enqueueVerifiedSource(storageObjectId: string, now?: Date): Promise<number>;
  listStatus(
    clientId: string,
    environment: ClientStorageEnvironment,
    limit: number,
  ): Promise<readonly Readonly<ImageDerivativeStatus>[]>;
  claimNext(input: Readonly<ImageDerivativeClaimInput>): Promise<Readonly<ImageDerivativeJob> | null>;
  complete(
    job: Readonly<ImageDerivativeJob>,
    output: Readonly<VerifiedImageDerivativeOutput>,
    now?: Date,
  ): Promise<void>;
  fail(input: Readonly<ImageDerivativeFailureInput>): Promise<void>;
}

export interface ImageDerivativeSourceReader {
  read(job: Readonly<ImageDerivativeJob>): Promise<Readonly<ImageDerivativeSource>>;
}

export interface BoundedImageProcessor {
  process(
    job: Readonly<ImageDerivativeJob>,
    source: Readonly<ImageDerivativeSource>,
  ): Promise<Readonly<ProcessedImageDerivative>>;
}

export interface ImageDerivativeOutputWriter {
  write(
    job: Readonly<ImageDerivativeJob>,
    output: Readonly<ProcessedImageDerivative>,
  ): Promise<Readonly<VerifiedImageDerivativeOutput>>;
  cleanup(job: Readonly<ImageDerivativeJob>): Promise<void>;
}

export class ImageDerivativeError extends Error {
  readonly category: ImageDerivativeDiagnosticCategory;
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    category: ImageDerivativeDiagnosticCategory,
    code: string,
    retryable = false,
  ) {
    super(code);
    this.name = 'ImageDerivativeError';
    this.category = category;
    this.code = code;
    this.retryable = retryable;
  }
}

const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,95}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function safeCode(value: string): string {
  return SAFE_CODE_PATTERN.test(value) ? value : 'image-derivative-internal-error';
}

function normalizeError(error: unknown): ImageDerivativeError {
  if (error instanceof ImageDerivativeError) return error;
  if (error !== null && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    if (
      typeof value.code === 'string' &&
      typeof value.category === 'string' &&
      typeof value.retryable === 'boolean'
    ) {
      const categories: readonly ImageDerivativeDiagnosticCategory[] = [
        'invalid-request',
        'duplicate-conflict',
        'not-ready',
        'dependency-unavailable',
        'internal',
      ];
      if (categories.includes(value.category as ImageDerivativeDiagnosticCategory)) {
        return new ImageDerivativeError(
          value.category as ImageDerivativeDiagnosticCategory,
          safeCode(value.code),
          value.retryable,
        );
      }
    }
  }
  return new ImageDerivativeError('internal', 'image-derivative-internal-error', false);
}

function assertSource(job: Readonly<ImageDerivativeJob>, source: Readonly<ImageDerivativeSource>): void {
  if (!IMAGE_DERIVATIVE_LIMITS.acceptedInputMimeTypes.includes(
    source.mediaType as (typeof IMAGE_DERIVATIVE_LIMITS.acceptedInputMimeTypes)[number],
  )) {
    throw new ImageDerivativeError('invalid-request', 'image-derivative-input-mime-unsupported');
  }
  if (
    !Number.isSafeInteger(source.byteLength) ||
    source.byteLength <= 0 ||
    source.byteLength > IMAGE_DERIVATIVE_LIMITS.maximumSourceBytes
  ) {
    throw new ImageDerivativeError('invalid-request', 'image-derivative-source-byte-limit');
  }
  if (!SHA256_PATTERN.test(source.checksumSha256)) {
    throw new ImageDerivativeError('invalid-request', 'image-derivative-source-checksum-invalid');
  }
  if (
    !Number.isSafeInteger(job.requestedWidth) ||
    job.requestedWidth < IMAGE_DERIVATIVE_LIMITS.minimumWidth ||
    job.requestedWidth > IMAGE_DERIVATIVE_LIMITS.maximumWidth
  ) {
    throw new ImageDerivativeError('invalid-request', 'image-derivative-width-invalid');
  }
  if (
    !Number.isSafeInteger(job.quality) ||
    job.quality < IMAGE_DERIVATIVE_LIMITS.minimumQuality ||
    job.quality > IMAGE_DERIVATIVE_LIMITS.maximumQuality
  ) {
    throw new ImageDerivativeError('invalid-request', 'image-derivative-quality-invalid');
  }
}

function assertProcessed(output: Readonly<ProcessedImageDerivative>): void {
  if (
    output.mediaType !== 'image/png' ||
    !Number.isSafeInteger(output.width) ||
    output.width < IMAGE_DERIVATIVE_LIMITS.minimumWidth ||
    output.width > IMAGE_DERIVATIVE_LIMITS.maximumWidth ||
    !Number.isSafeInteger(output.height) ||
    output.height < 1 ||
    output.width * output.height > IMAGE_DERIVATIVE_LIMITS.maximumDecodedPixels ||
    output.byteLength !== output.body.byteLength ||
    output.byteLength <= 0 ||
    output.byteLength > IMAGE_DERIVATIVE_LIMITS.maximumOutputBytes ||
    !SHA256_PATTERN.test(output.checksumSha256) ||
    createHash('sha256').update(output.body).digest('hex') !== output.checksumSha256
  ) {
    throw new ImageDerivativeError('internal', 'image-derivative-processor-output-invalid');
  }
}

export class ImageDerivativeApplicationService {
  readonly #store: ImageDerivativeStore;
  readonly #sourceReader: ImageDerivativeSourceReader;
  readonly #processor: BoundedImageProcessor;
  readonly #outputWriter: ImageDerivativeOutputWriter;

  constructor(input: Readonly<{
    store: ImageDerivativeStore;
    sourceReader: ImageDerivativeSourceReader;
    processor: BoundedImageProcessor;
    outputWriter: ImageDerivativeOutputWriter;
  }>) {
    this.#store = input.store;
    this.#sourceReader = input.sourceReader;
    this.#processor = input.processor;
    this.#outputWriter = input.outputWriter;
  }

  async processNext(workerId: string, now = new Date()): Promise<'processed' | 'idle'> {
    const job = await this.#store.claimNext({
      workerId,
      leaseDurationMs: IMAGE_DERIVATIVE_LIMITS.leaseDurationMs,
      maximumAttempts: IMAGE_DERIVATIVE_LIMITS.maximumAttempts,
      now,
    });
    if (job === null) return 'idle';

    let source: Readonly<ImageDerivativeSource> | undefined;
    try {
      source = await this.#sourceReader.read(job);
      assertSource(job, source);
      const processed = await this.#processor.process(job, source);
      assertProcessed(processed);
      const verified = await this.#outputWriter.write(job, processed);
      if (
        verified.byteLength !== processed.byteLength ||
        verified.checksumSha256 !== processed.checksumSha256
      ) {
        throw new ImageDerivativeError(
          'dependency-unavailable',
          'image-derivative-output-verification-mismatch',
          false,
        );
      }
      await this.#store.complete(job, verified, now);
      return 'processed';
    } catch (error) {
      const normalized = normalizeError(error);
      try {
        await this.#outputWriter.cleanup(job);
      } catch {
        await this.#store.fail({
          job,
          category: 'dependency-unavailable',
          code: 'image-derivative-output-cleanup-failed',
          retryable: true,
          retryDelayMs: IMAGE_DERIVATIVE_LIMITS.retryDelayMs,
          now,
        });
        return 'processed';
      }
      await this.#store.fail({
        job,
        category: normalized.category,
        code: safeCode(normalized.code),
        retryable: normalized.retryable,
        retryDelayMs: IMAGE_DERIVATIVE_LIMITS.retryDelayMs,
        now,
      });
      return 'processed';
    } finally {
      source?.close();
    }
  }
}

export function createUnavailableImageDerivativeStore(): ImageDerivativeStore {
  return Object.freeze({
    configured: false,
    async enqueueVerifiedSource(): Promise<number> {
      return 0;
    },
    async listStatus(): Promise<readonly Readonly<ImageDerivativeStatus>[]> {
      throw new ImageDerivativeError(
        'dependency-unavailable',
        'image-derivative-store-unavailable',
        true,
      );
    },
    async claimNext(): Promise<Readonly<ImageDerivativeJob> | null> {
      return null;
    },
    async complete(): Promise<void> {
      throw new ImageDerivativeError(
        'dependency-unavailable',
        'image-derivative-store-unavailable',
        true,
      );
    },
    async fail(): Promise<void> {},
  });
}
