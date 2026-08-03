import type { SafeDiagnostic } from './runtime-contract.js';
import type { ResolvedProviderReadTarget } from './runtime-read-delivery.js';
import type { ResolvedProviderWriteTarget } from './runtime-s3-provider.js';

export const IMAGE_DERIVATIVE_STATES = [
  'queued',
  'processing',
  'succeeded',
  'failed',
] as const;
export type ImageDerivativeState = (typeof IMAGE_DERIVATIVE_STATES)[number];
export type ImageDerivativeOutputFormat = 'webp' | 'avif' | 'jpeg' | 'png';
export type ImageDerivativeFit = 'inside' | 'cover' | 'contain' | 'fill';

export const IMAGE_DERIVATIVE_LIMITS = Object.freeze({
  acceptedInputMimeTypes: Object.freeze(['image/png'] as const),
  maximumSourceByteLength: 32 * 1024 * 1024,
  maximumDecodedPixels: 40_000_000,
  minimumWidth: 16,
  maximumWidth: 16_384,
  maximumWidthsPerPreset: 8,
  minimumQuality: 1,
  maximumQuality: 100,
  maximumOutputByteLength: 32 * 1024 * 1024,
  maximumWorkingMemoryByteLength: 256 * 1024 * 1024,
  maximumConcurrency: 2,
  maximumAttempts: 3,
  retryDelayMs: 30_000,
  leaseDurationMs: 2 * 60_000,
  maximumStatusRows: 50,
});

export class ImageDerivativeError extends Error {
  readonly category: SafeDiagnostic['category'];
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    category: SafeDiagnostic['category'],
    code: string,
    status = 500,
    retryable = false,
  ) {
    super(code);
    this.name = 'ImageDerivativeError';
    this.category = category;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }

  toSafeDiagnostic(): Readonly<SafeDiagnostic> {
    return Object.freeze({
      category: this.category,
      code: this.code,
      retryable: this.retryable,
    });
  }
}

export interface ImageDerivativeStatusSnapshot {
  readonly jobId: string;
  readonly sourceStorageObjectId: string;
  readonly outputStorageObjectId?: string;
  readonly presetId: string;
  readonly width: number;
  readonly outputFormat: ImageDerivativeOutputFormat;
  readonly state: ImageDerivativeState;
  readonly attemptCount: number;
  readonly safeDiagnosticCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt?: string;
}

export interface ImageDerivativeJobSnapshot extends ImageDerivativeStatusSnapshot {
  readonly storageControlClientId: string;
  readonly environment: 'dev' | 'staging' | 'prod';
  readonly configurationVersionId: string;
  readonly configurationFingerprint: string;
  readonly configurationRouteId: string;
  readonly imagePresetId: string;
  readonly targetVaultId: string;
  readonly quality: number;
  readonly fit: ImageDerivativeFit;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
}

export interface ImageDerivativeSourceSnapshot {
  readonly storageObjectId: string;
  readonly checksumSha256: string;
  readonly byteLength: number;
  readonly contentType: string;
  readonly copies: readonly Readonly<{
    storageObjectCopyId: string;
    target: Readonly<ResolvedProviderReadTarget>;
  }>[];
}

export interface ImageDerivativeOutputReservation {
  readonly storageObjectId: string;
  readonly storageObjectCopyId: string;
  readonly target: Readonly<ResolvedProviderWriteTarget>;
  readonly reusedPendingReservation: boolean;
  readonly alreadyVerified: boolean;
}

export interface ImageDerivativeStore {
  readonly configured: boolean;
  enqueueVerifiedSource(storageObjectId: string, now?: Date): Promise<number>;
  listStatus(
    clientId: string,
    environment: 'dev' | 'staging' | 'prod',
    limit?: number,
  ): Promise<readonly Readonly<ImageDerivativeStatusSnapshot>[]>;
  claimNext(workerId: string, now?: Date): Promise<Readonly<ImageDerivativeJobSnapshot> | null>;
  readSource(job: Readonly<ImageDerivativeJobSnapshot>): Promise<Readonly<ImageDerivativeSourceSnapshot>>;
  reserveOutput(input: {
    job: Readonly<ImageDerivativeJobSnapshot>;
    checksumSha256: string;
    byteLength: number;
    contentType: string;
    now?: Date;
  }): Promise<Readonly<ImageDerivativeOutputReservation>>;
  completeOutput(input: {
    job: Readonly<ImageDerivativeJobSnapshot>;
    reservation: Readonly<ImageDerivativeOutputReservation>;
    checksumSha256: string;
    byteLength: number;
    now?: Date;
  }): Promise<Readonly<ImageDerivativeStatusSnapshot>>;
  failJob(input: {
    job: Readonly<ImageDerivativeJobSnapshot>;
    diagnostic: Readonly<SafeDiagnostic>;
    retryable: boolean;
    clearReservedOutput: boolean;
    now?: Date;
  }): Promise<Readonly<ImageDerivativeStatusSnapshot>>;
}

export function createUnavailableImageDerivativeStore(): ImageDerivativeStore {
  const unavailable = async (): Promise<never> => {
    throw new ImageDerivativeError(
      'dependency-unavailable',
      'image-derivative-store-unavailable',
      503,
      true,
    );
  };
  return Object.freeze({
    configured: false,
    enqueueVerifiedSource: unavailable,
    listStatus: unavailable,
    claimNext: unavailable,
    readSource: unavailable,
    reserveOutput: unavailable,
    completeOutput: unavailable,
    failJob: unavailable,
  });
}

export interface BoundedImageDerivativeInput {
  readonly bytes: Uint8Array;
  readonly declaredContentType: string;
  readonly width: number;
  readonly outputFormat: ImageDerivativeOutputFormat;
  readonly quality: number;
  readonly fit: ImageDerivativeFit;
}

export interface BoundedImageDerivativeOutput {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
}

export interface BoundedImageDerivativeProcessor {
  process(
    input: Readonly<BoundedImageDerivativeInput>,
  ): Promise<Readonly<BoundedImageDerivativeOutput>> | Readonly<BoundedImageDerivativeOutput>;
}
