import { Readable } from 'node:stream';
import {
  ImageDerivativeError,
  type ImageDerivativeJob,
  type ImageDerivativeOutputWriter,
  type ImageDerivativeSource,
  type ImageDerivativeSourceReader,
  type ProcessedImageDerivative,
  type VerifiedImageDerivativeOutput,
} from './image-derivative.js';
import {
  PostgresImageDerivativeStore,
  type ImageDerivativeOutputReservation,
} from './image-derivative-postgres.js';
import type { ProviderObjectReader } from './runtime-read-delivery.js';
import {
  ProviderExecutionError,
  type ProviderObjectWriter,
} from './runtime-s3-provider.js';

export class ConfiguredImageDerivativeSourceReader implements ImageDerivativeSourceReader {
  readonly #store: PostgresImageDerivativeStore;
  readonly #reader: ProviderObjectReader;

  constructor(input: Readonly<{
    store: PostgresImageDerivativeStore;
    reader: ProviderObjectReader;
  }>) {
    this.#store = input.store;
    this.#reader = input.reader;
  }

  async read(job: Readonly<ImageDerivativeJob>): Promise<Readonly<ImageDerivativeSource>> {
    const authority = await this.#store.sourceAuthority(job);
    let stream: Awaited<ReturnType<ProviderObjectReader['get']>>;
    try {
      stream = await this.#reader.get({ target: authority.target });
    } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error) {
        const value = error as { code?: unknown; retryable?: unknown };
        if (typeof value.code === 'string') {
          throw new ImageDerivativeError(
            'dependency-unavailable',
            value.code,
            value.retryable !== false,
          );
        }
      }
      throw new ImageDerivativeError(
        'dependency-unavailable',
        'image-derivative-source-read-failed',
        true,
      );
    }
    if (stream.byteLength !== authority.byteLength) {
      stream.close();
      throw new ImageDerivativeError(
        'dependency-unavailable',
        'image-derivative-source-length-mismatch',
        false,
      );
    }
    return Object.freeze({
      mediaType: authority.mediaType,
      byteLength: authority.byteLength,
      checksumSha256: authority.checksumSha256,
      body: stream.body,
      close: () => stream.close(),
    });
  }
}

function providerError(error: unknown): ImageDerivativeError {
  if (error instanceof ProviderExecutionError) {
    const category =
      error.category === 'invalid-request' ||
      error.category === 'duplicate-conflict' ||
      error.category === 'not-ready' ||
      error.category === 'dependency-unavailable' ||
      error.category === 'internal'
        ? error.category
        : 'dependency-unavailable';
    return new ImageDerivativeError(category, error.code, error.retryable);
  }
  return new ImageDerivativeError(
    'dependency-unavailable',
    'image-derivative-output-write-failed',
    true,
  );
}

export class ConfiguredImageDerivativeOutputWriter implements ImageDerivativeOutputWriter {
  readonly #store: PostgresImageDerivativeStore;
  readonly #writer: ProviderObjectWriter;

  constructor(input: Readonly<{
    store: PostgresImageDerivativeStore;
    writer: ProviderObjectWriter;
  }>) {
    this.#store = input.store;
    this.#writer = input.writer;
  }

  async write(
    job: Readonly<ImageDerivativeJob>,
    output: Readonly<ProcessedImageDerivative>,
  ): Promise<Readonly<VerifiedImageDerivativeOutput>> {
    const reservation = await this.#store.reserveOutput(job, output);
    if (reservation.alreadyVerified !== undefined) {
      if (
        reservation.alreadyVerified.byteLength !== output.byteLength ||
        reservation.alreadyVerified.checksumSha256 !== output.checksumSha256
      ) {
        throw new ImageDerivativeError(
          'duplicate-conflict',
          'image-derivative-existing-output-mismatch',
          false,
        );
      }
      return reservation.alreadyVerified;
    }
    try {
      const receipt = await this.#writer.write({
        target: reservation.target,
        source: Readable.from([output.body]),
        checksumSha256: output.checksumSha256,
        byteLength: output.byteLength,
      });
      if (
        receipt.integrityVerification.verified !== true ||
        receipt.observed.checksumSha256 !== output.checksumSha256 ||
        receipt.observed.byteLength !== output.byteLength
      ) {
        throw new ImageDerivativeError(
          'dependency-unavailable',
          'image-derivative-output-verification-mismatch',
          false,
        );
      }
      await this.#store.markOutputVerified(reservation, output);
      return Object.freeze({
        storageObjectId: reservation.storageObjectId,
        byteLength: output.byteLength,
        checksumSha256: output.checksumSha256,
      });
    } catch (error) {
      await this.#cleanupReservation(reservation);
      throw error instanceof ImageDerivativeError ? error : providerError(error);
    }
  }

  async cleanup(job: Readonly<ImageDerivativeJob>): Promise<void> {
    const reservation = await this.#store.outputReservation(job);
    if (reservation === null || reservation.alreadyVerified !== undefined) return;
    await this.#cleanupReservation(reservation);
  }

  async #cleanupReservation(reservation: Readonly<ImageDerivativeOutputReservation>): Promise<void> {
    try {
      await this.#writer.cleanup({ target: reservation.target });
    } catch {
      await this.#store.markOutputFailed(reservation);
      throw new ImageDerivativeError(
        'dependency-unavailable',
        'image-derivative-output-cleanup-failed',
        true,
      );
    }
    await this.#store.markOutputFailed(reservation);
  }
}
