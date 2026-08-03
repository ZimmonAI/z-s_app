import { randomBytes, randomUUID } from 'node:crypto';
import type { SafeDiagnostic } from './runtime-contract.js';
import type { PostgresPoolLike, PostgresQueryable } from './runtime-storage-registry-types.js';
import type {
  ImageDerivativeJobSnapshot,
  ImageDerivativeOutputReservation,
  ImageDerivativeSourceSnapshot,
  ImageDerivativeStatusSnapshot,
  ImageDerivativeStore,
} from './image-derivative.js';
import {
  claimNext,
  enqueueVerifiedSource,
  listStatus,
  readSource,
} from './image-derivative-postgres-queue.js';
import {
  completeOutput,
  failJob,
  reserveOutput,
} from './image-derivative-postgres-output.js';
import type { PostgresImageDerivativeContext } from './image-derivative-postgres-types.js';

export interface PostgresImageDerivativeStoreOptions {
  readonly pool: PostgresPoolLike;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly createLeaseToken?: () => string;
}

export class PostgresImageDerivativeStore implements ImageDerivativeStore {
  readonly configured = true;
  readonly #context: PostgresImageDerivativeContext;

  constructor(options: PostgresImageDerivativeStoreOptions) {
    this.#context = Object.freeze({
      pool: options.pool,
      queryable: options.pool as PostgresPoolLike & PostgresQueryable,
      now: options.now ?? (() => new Date()),
      createId: options.createId ?? randomUUID,
      createLeaseToken: options.createLeaseToken ?? (() => randomBytes(32).toString('hex')),
    });
  }

  enqueueVerifiedSource(storageObjectId: string, now?: Date): Promise<number> {
    return enqueueVerifiedSource(this.#context, storageObjectId, now ?? this.#context.now());
  }

  listStatus(
    clientId: string,
    environment: 'dev' | 'staging' | 'prod',
    limit?: number,
  ): Promise<readonly Readonly<ImageDerivativeStatusSnapshot>[]> {
    return listStatus(this.#context, clientId, environment, limit);
  }

  claimNext(workerId: string, now?: Date): Promise<Readonly<ImageDerivativeJobSnapshot> | null> {
    return claimNext(this.#context, workerId, now ?? this.#context.now());
  }

  readSource(job: Readonly<ImageDerivativeJobSnapshot>): Promise<Readonly<ImageDerivativeSourceSnapshot>> {
    return readSource(this.#context, job);
  }

  reserveOutput(input: {
    job: Readonly<ImageDerivativeJobSnapshot>;
    checksumSha256: string;
    byteLength: number;
    contentType: string;
    now?: Date;
  }): Promise<Readonly<ImageDerivativeOutputReservation>> {
    return reserveOutput(this.#context, input);
  }

  completeOutput(input: {
    job: Readonly<ImageDerivativeJobSnapshot>;
    reservation: Readonly<ImageDerivativeOutputReservation>;
    checksumSha256: string;
    byteLength: number;
    now?: Date;
  }): Promise<Readonly<ImageDerivativeStatusSnapshot>> {
    return completeOutput(this.#context, input);
  }

  failJob(input: {
    job: Readonly<ImageDerivativeJobSnapshot>;
    diagnostic: Readonly<SafeDiagnostic>;
    retryable: boolean;
    clearReservedOutput: boolean;
    now?: Date;
  }): Promise<Readonly<ImageDerivativeStatusSnapshot>> {
    return failJob(this.#context, input);
  }
}
