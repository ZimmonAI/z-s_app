import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { SafeDiagnostic } from './runtime-contract.js';
import type { ProviderObjectReader } from './runtime-read-delivery.js';
import {
  ProviderExecutionError,
  type ProviderObjectWriter,
} from './runtime-s3-provider.js';
import {
  IMAGE_DERIVATIVE_LIMITS,
  ImageDerivativeError,
  type BoundedImageDerivativeProcessor,
  type ImageDerivativeOutputReservation,
  type ImageDerivativeStatusSnapshot,
  type ImageDerivativeStore,
} from './image-derivative-contract.js';
import { BoundedPngImageDerivativeProcessor } from './image-derivative-png.js';

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

async function collectBoundedStream(
  stream: Readable,
  maximumByteLength: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === 'number'
      ? Uint8Array.of(chunk)
      : chunk instanceof Uint8Array
        ? chunk
        : Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > maximumByteLength) {
      stream.destroy();
      throw new ImageDerivativeError(
        'invalid-request',
        'image-source-byte-limit-exceeded',
        413,
        false,
      );
    }
    chunks.push(bytes);
  }
  return concatBytes(chunks);
}

function safeDiagnostic(error: unknown): Readonly<SafeDiagnostic> {
  if (error instanceof ImageDerivativeError) return error.toSafeDiagnostic();
  if (error instanceof ProviderExecutionError) return error.toSafeDiagnostic();
  return Object.freeze({
    category: 'internal',
    code: 'image-derivative-processing-failed',
    retryable: false,
  });
}

export interface ImageDerivativeWorkerOptions {
  readonly store: ImageDerivativeStore;
  readonly providerReader: ProviderObjectReader;
  readonly providerWriter: ProviderObjectWriter;
  readonly processor?: BoundedImageDerivativeProcessor;
  readonly now?: () => Date;
}

export class ImageDerivativeWorker {
  readonly #store: ImageDerivativeStore;
  readonly #reader: ProviderObjectReader;
  readonly #writer: ProviderObjectWriter;
  readonly #processor: BoundedImageDerivativeProcessor;
  readonly #now: () => Date;

  constructor(options: ImageDerivativeWorkerOptions) {
    this.#store = options.store;
    this.#reader = options.providerReader;
    this.#writer = options.providerWriter;
    this.#processor = options.processor ?? new BoundedPngImageDerivativeProcessor();
    this.#now = options.now ?? (() => new Date());
  }

  async runOnce(workerId: string): Promise<Readonly<ImageDerivativeStatusSnapshot> | null> {
    const job = await this.#store.claimNext(workerId, this.#now());
    if (job === null) return null;
    let reservation: Readonly<ImageDerivativeOutputReservation> | undefined;
    let sourceDelivery: Awaited<ReturnType<ProviderObjectReader['get']>> | undefined;
    try {
      const source = await this.#store.readSource(job);
      let sourceBytes: Uint8Array | undefined;
      let lastReadError: unknown;
      for (const copy of source.copies) {
        try {
          sourceDelivery = await this.#reader.get({ target: copy.target });
          if (sourceDelivery.byteLength !== source.byteLength) {
            throw new ImageDerivativeError(
              'dependency-unavailable',
              'image-source-size-mismatch',
              503,
              true,
            );
          }
          sourceBytes = await collectBoundedStream(
            sourceDelivery.body,
            IMAGE_DERIVATIVE_LIMITS.maximumSourceByteLength,
          );
          sourceDelivery.close();
          sourceDelivery = undefined;
          const checksum = createHash('sha256').update(sourceBytes).digest('hex');
          if (checksum !== source.checksumSha256) {
            throw new ImageDerivativeError(
              'dependency-unavailable',
              'image-source-checksum-mismatch',
              503,
              true,
            );
          }
          break;
        } catch (error) {
          sourceDelivery?.close();
          sourceDelivery = undefined;
          sourceBytes = undefined;
          lastReadError = error;
        }
      }
      if (sourceBytes === undefined) {
        throw lastReadError instanceof Error
          ? lastReadError
          : new ImageDerivativeError(
              'dependency-unavailable',
              'image-source-unavailable',
              503,
              true,
            );
      }
      const output = await this.#processor.process({
        bytes: sourceBytes,
        declaredContentType: source.contentType,
        width: job.width,
        outputFormat: job.outputFormat,
        quality: job.quality,
        fit: job.fit,
      });
      const checksumSha256 = createHash('sha256').update(output.bytes).digest('hex');
      reservation = await this.#store.reserveOutput({
        job,
        checksumSha256,
        byteLength: output.bytes.byteLength,
        contentType: output.contentType,
        now: this.#now(),
      });
      if (!reservation.alreadyVerified) {
        if (reservation.reusedPendingReservation) {
          await this.#writer.cleanup({ target: reservation.target });
        }
        const receipt = await this.#writer.write({
          target: reservation.target,
          source: Readable.from([output.bytes]),
          checksumSha256,
          byteLength: output.bytes.byteLength,
        });
        if (
          receipt.observed.checksumSha256 !== checksumSha256 ||
          receipt.observed.byteLength !== output.bytes.byteLength
        ) {
          throw new ImageDerivativeError(
            'dependency-unavailable',
            'image-output-verification-mismatch',
            503,
            false,
          );
        }
      }
      return this.#store.completeOutput({
        job,
        reservation,
        checksumSha256,
        byteLength: output.bytes.byteLength,
        now: this.#now(),
      });
    } catch (error) {
      sourceDelivery?.close();
      if (reservation !== undefined && !reservation.alreadyVerified) {
        try {
          await this.#writer.cleanup({ target: reservation.target });
        } catch {
          // The durable safe failure remains authoritative.
        }
      }
      const diagnostic = safeDiagnostic(error);
      const retryable = diagnostic.retryable && job.attemptCount < IMAGE_DERIVATIVE_LIMITS.maximumAttempts;
      return this.#store.failJob({
        job,
        diagnostic,
        retryable,
        clearReservedOutput: reservation !== undefined,
        now: this.#now(),
      });
    }
  }
}

export function createImageDerivativeId(): string {
  return randomUUID();
}
