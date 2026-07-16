import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ObjectUploadCompletionOperationResult,
  SafeDiagnostic,
  SafeProviderCopyResult,
  StorageObjectResultState,
  VerifiedMediaMetadata,
} from './runtime-contract.js';
import {
  ObjectIngestRuntimeError,
  type ObjectIngestAdapter,
  type ObjectIngestInput,
  type ObjectIngestReceipt,
} from './runtime-ingest.js';
import {
  MediaVerificationError,
  type MediaVerificationAdapter,
} from './runtime-media-verification.js';
import {
  ProviderExecutionError,
  type ProviderObjectWriter,
  type ProviderWriteReceipt,
  type ResolvedProviderWriteTarget,
} from './runtime-s3-provider.js';
import type {
  ProviderCopyExecutionContext,
  ProviderRole,
} from './runtime-storage-registry-types.js';

export interface ProviderWriteTargetResolver {
  resolve(input: {
    providerRole: ProviderRole;
    providerBindingId: string;
    internalLocator: string;
  }): Promise<Readonly<ResolvedProviderWriteTarget>> | Readonly<ResolvedProviderWriteTarget>;
}

export interface DualProviderAttemptReservation {
  objectWriteIntentId: string;
  storageObjectId: string;
  expectedIntentRowVersion: number;
  expectedObjectRowVersion: number;
  attempts: Readonly<Record<ProviderRole, Readonly<{
    providerAttemptId: string;
    storageObjectCopyId: string;
    expectedCopyRowVersion: number;
  }>>>;
}

export interface DualProviderWriteOutcome {
  state: 'verified' | 'failed';
  retryable: boolean;
  observedChecksumSha256?: string;
  observedByteLength?: number;
  diagnostic?: Readonly<SafeDiagnostic>;
}

export interface DualProviderWriteRegistry {
  beginDualProviderWrite(input: {
    objectWriteIntentId: string;
    storageObjectId: string;
    expectedIntentRowVersion: number;
    expectedObjectRowVersion: number;
    expectedChecksumSha256: string;
    expectedByteLength: number;
    copies: Readonly<Record<ProviderRole, Readonly<ProviderCopyExecutionContext>>>;
  }): Promise<Readonly<DualProviderAttemptReservation>>;
  completeDualProviderWrite(input: {
    reservation: Readonly<DualProviderAttemptReservation>;
    checksumSha256: string;
    byteLength: number;
    verifiedMedia: Readonly<VerifiedMediaMetadata>;
    outcomes: Readonly<Record<ProviderRole, Readonly<DualProviderWriteOutcome>>>;
  }): Promise<Readonly<ObjectUploadCompletionOperationResult>>;
  abortDualProviderWrite(input: {
    reservation: Readonly<DualProviderAttemptReservation>;
    diagnostic: Readonly<SafeDiagnostic>;
  }): Promise<void>;
  reserveTargetedProviderRetry(input: {
    storageObjectId: string;
    providerRole: ProviderRole;
    expectedFailedCopyVersion: number;
  }): Promise<Readonly<TargetedProviderRetryReservation>>;
  completeTargetedProviderRetry(input: {
    reservation: Readonly<TargetedProviderRetryReservation>;
    outcome: Readonly<DualProviderWriteOutcome>;
  }): Promise<Readonly<DualProviderStorageTruth>>;
}

export interface TargetedProviderRetryReservation {
  storageObjectId: string;
  providerRole: ProviderRole;
  providerBindingId: string;
  internalLocator: string;
  providerAttemptId: string;
  storageObjectCopyId: string;
  expectedPendingCopyVersion: number;
  expectedObjectRowVersion: number;
  checksumSha256: string;
  byteLength: number;
}

export interface DualProviderStorageTruth {
  storageObjectId: string;
  storageState: StorageObjectResultState;
  objectProtectionStage: string;
  copies: Readonly<Record<ProviderRole, Readonly<SafeProviderCopyResult>>>;
}

export interface VerifiedProviderWriteSource {
  open(): Promise<Readable> | Readable;
}

export interface DualProviderObjectIngestAdapterOptions {
  registry: DualProviderWriteRegistry;
  writer: ProviderObjectWriter;
  mediaVerifier: MediaVerificationAdapter;
  resolveTarget: ProviderWriteTargetResolver;
  temporaryRoot?: string;
  createTemporaryId?: () => string;
}

interface ActiveExecution {
  reservation: Readonly<DualProviderAttemptReservation>;
  directory?: string;
  targets: Partial<Record<ProviderRole, Readonly<ResolvedProviderWriteTarget>>>;
  verifiedRoles: Set<ProviderRole>;
}

const ROLES = ['hot', 'canonical'] as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function providerFailure(error: unknown): Readonly<DualProviderWriteOutcome> {
  const execution =
    error instanceof ProviderExecutionError
      ? error
      : new ProviderExecutionError('dependency-unavailable', 'provider-write-failed', true);
  return Object.freeze({
    state: 'failed',
    retryable: execution.retryable,
    diagnostic: execution.toSafeDiagnostic(),
  });
}

function verifiedOutcome(receipt: Readonly<ProviderWriteReceipt>): Readonly<DualProviderWriteOutcome> {
  const outcome: DualProviderWriteOutcome = {
    state: 'verified',
    retryable: false,
  };
  if (receipt.observed.checksumSha256 !== null) {
    outcome.observedChecksumSha256 = receipt.observed.checksumSha256;
  }
  if (receipt.observed.byteLength !== null) {
    outcome.observedByteLength = receipt.observed.byteLength;
  }
  return Object.freeze(outcome);
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (result.bytesWritten <= 0) {
      throw new ObjectIngestRuntimeError('internal', 'temporary-file-write-failed', 500, {
        failObjectWriteIntent: true,
      });
    }
    offset += result.bytesWritten;
  }
}

async function stageBody(input: Readonly<ObjectIngestInput>, directory: string): Promise<Readonly<{
  filePath: string;
  checksumSha256: string;
  byteLength: number;
}>> {
  const filePath = path.join(directory, 'payload');
  const handle = await open(filePath, 'wx', 0o600);
  const hash = createHash('sha256');
  let byteLength = 0;
  try {
    for await (const chunk of input.body) {
      if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) continue;
      byteLength += chunk.byteLength;
      if (byteLength > input.declaredByteLength) {
        throw new ObjectIngestRuntimeError('invalid-request', 'content-length-exceeded', 413, {
          failObjectWriteIntent: true,
        });
      }
      hash.update(chunk);
      await writeAll(handle, chunk);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  const checksumSha256 = hash.digest('hex');
  if (byteLength !== input.declaredByteLength) {
    throw new ObjectIngestRuntimeError('invalid-request', 'content-length-mismatch', 400, {
      failObjectWriteIntent: true,
    });
  }
  if (checksumSha256 !== input.declaredChecksumSha256) {
    throw new ObjectIngestRuntimeError('invalid-request', 'computed-checksum-mismatch', 400, {
      failObjectWriteIntent: true,
    });
  }
  return Object.freeze({ filePath, checksumSha256, byteLength });
}

function safeAbortDiagnostic(error: unknown): Readonly<SafeDiagnostic> {
  if (error instanceof ObjectIngestRuntimeError) {
    return Object.freeze({
      category: error.category,
      code: error.code,
      retryable: error.retryable,
    });
  }
  if (error instanceof MediaVerificationError) {
    return Object.freeze({
      category: error.category,
      code: error.code,
      retryable: error.retryable,
    });
  }
  if (error instanceof ProviderExecutionError) return error.toSafeDiagnostic();
  return Object.freeze({
    category: 'internal',
    code: 'dual-provider-execution-failed',
    retryable: false,
  });
}

function runtimeError(error: unknown): ObjectIngestRuntimeError {
  if (error instanceof ObjectIngestRuntimeError) return error;
  if (error instanceof MediaVerificationError) {
    return new ObjectIngestRuntimeError(error.category, error.code, error.status, {
      retryable: error.retryable,
      failObjectWriteIntent: true,
    });
  }
  if (error instanceof ProviderExecutionError) {
    return new ObjectIngestRuntimeError(error.category, error.code, 503, {
      retryable: error.retryable,
      failObjectWriteIntent: true,
    });
  }
  return new ObjectIngestRuntimeError('internal', 'dual-provider-execution-failed', 500, {
    failObjectWriteIntent: true,
  });
}

function validateTarget(
  expected: Readonly<ProviderCopyExecutionContext>,
  target: Readonly<ResolvedProviderWriteTarget>,
): void {
  if (
    target.providerRole !== expected.providerRole ||
    target.internalLocator !== expected.internalLocator
  ) {
    throw new ProviderExecutionError('internal', 'provider-target-authority-mismatch', false);
  }
}

export class DualProviderObjectIngestAdapter implements ObjectIngestAdapter {
  readonly #registry: DualProviderWriteRegistry;
  readonly #writer: ProviderObjectWriter;
  readonly #mediaVerifier: MediaVerificationAdapter;
  readonly #resolveTarget: ProviderWriteTargetResolver;
  readonly #temporaryRoot: string;
  readonly #createTemporaryId: () => string;
  readonly #active = new Map<string, ActiveExecution>();

  constructor(options: DualProviderObjectIngestAdapterOptions) {
    this.#registry = options.registry;
    this.#writer = options.writer;
    this.#mediaVerifier = options.mediaVerifier;
    this.#resolveTarget = options.resolveTarget;
    this.#temporaryRoot = options.temporaryRoot ?? tmpdir();
    this.#createTemporaryId = options.createTemporaryId ?? randomUUID;
  }

  async ingest(input: Readonly<ObjectIngestInput>): Promise<Readonly<ObjectIngestReceipt>> {
    if (
      !SHA256_PATTERN.test(input.declaredChecksumSha256) ||
      input.providerCopies === undefined ||
      !Number.isSafeInteger(input.intentRowVersion) ||
      !Number.isSafeInteger(input.objectRowVersion)
    ) {
      throw new ObjectIngestRuntimeError('invalid-request', 'dual-provider-input-invalid', 400, {
        failObjectWriteIntent: true,
      });
    }
    const intentRowVersion = input.intentRowVersion;
    const objectRowVersion = input.objectRowVersion;
    const providerCopies = input.providerCopies;
    if (intentRowVersion === undefined || objectRowVersion === undefined || providerCopies === undefined) {
      throw new ObjectIngestRuntimeError('invalid-request', 'dual-provider-input-invalid', 400, {
        failObjectWriteIntent: true,
      });
    }
    const reservation = await this.#registry.beginDualProviderWrite({
      objectWriteIntentId: input.objectWriteIntentId,
      storageObjectId: input.storageObjectId,
      expectedIntentRowVersion: intentRowVersion,
      expectedObjectRowVersion: objectRowVersion,
      expectedChecksumSha256: input.declaredChecksumSha256,
      expectedByteLength: input.declaredByteLength,
      copies: providerCopies,
    });
    const active: ActiveExecution = {
      reservation,
      targets: {},
      verifiedRoles: new Set(),
    };
    this.#active.set(input.objectWriteIntentId, active);

    try {
      const directory = await mkdtemp(
        path.join(this.#temporaryRoot, `z-s-2b06-${this.#createTemporaryId()}-`),
      );
      active.directory = directory;
      const staged = await stageBody(input, directory);
      const verifiedMedia = await this.#mediaVerifier.verify({
        declaredMediaType: input.mediaType,
        source: Object.freeze({ filePath: staged.filePath }),
        maximumByteLength: input.declaredByteLength,
      });

      for (const role of ROLES) {
        const copy = providerCopies[role];
        const target = await this.#resolveTarget.resolve({
          providerRole: role,
          providerBindingId: copy.providerBindingId,
          internalLocator: copy.internalLocator,
        });
        validateTarget(copy, target);
        active.targets[role] = target;
      }

      const writes = ROLES.map(async (role): Promise<Readonly<DualProviderWriteOutcome>> => {
        const target = active.targets[role];
        if (target === undefined) {
          return providerFailure(
            new ProviderExecutionError('internal', 'provider-target-missing', false),
          );
        }
        try {
          const receipt = await this.#writer.write({
            target,
            source: createReadStream(staged.filePath),
            checksumSha256: staged.checksumSha256,
            byteLength: staged.byteLength,
          });
          active.verifiedRoles.add(role);
          return verifiedOutcome(receipt);
        } catch (error) {
          if (error instanceof ProviderExecutionError && error.cleanupRequired) {
            await this.#writer.cleanup({ target });
          }
          return providerFailure(error);
        }
      });
      const settled = await Promise.allSettled(writes);
      const outcomes = Object.freeze({
        hot:
          settled[0]?.status === 'fulfilled'
            ? settled[0].value
            : providerFailure(settled[0]?.reason),
        canonical:
          settled[1]?.status === 'fulfilled'
            ? settled[1].value
            : providerFailure(settled[1]?.reason),
      });
      const completionResult = await this.#registry.completeDualProviderWrite({
        reservation,
        checksumSha256: staged.checksumSha256,
        byteLength: staged.byteLength,
        verifiedMedia,
        outcomes,
      });
      this.#active.delete(input.objectWriteIntentId);
      return Object.freeze({
        state: 'accepted',
        checksumSha256: staged.checksumSha256,
        byteLength: staged.byteLength,
        completionResult,
      });
    } catch (error) {
      try {
        await this.#registry.abortDualProviderWrite({
          reservation,
          diagnostic: safeAbortDiagnostic(error),
        });
      } catch {
        // The original safe error remains authoritative.
      }
      throw runtimeError(error);
    } finally {
      if (active.directory !== undefined) {
        await rm(active.directory, { recursive: true, force: true });
        delete active.directory;
      }
    }
  }

  hasPartialState(input: { objectWriteIntentId: string }): boolean {
    return this.#active.has(input.objectWriteIntentId);
  }

  async cleanup(input: { objectWriteIntentId: string }): Promise<void> {
    const active = this.#active.get(input.objectWriteIntentId);
    if (active === undefined) return;
    for (const role of ROLES) {
      const target = active.targets[role];
      if (target !== undefined && !active.verifiedRoles.has(role)) {
        await this.#writer.cleanup({ target });
      }
    }
    if (active.directory !== undefined) {
      await rm(active.directory, { recursive: true, force: true });
    }
    this.#active.delete(input.objectWriteIntentId);
  }
}

export interface TargetedProviderRetryCoordinatorOptions {
  registry: DualProviderWriteRegistry;
  writer: ProviderObjectWriter;
  resolveTarget: ProviderWriteTargetResolver;
}

export class TargetedProviderRetryCoordinator {
  readonly #registry: DualProviderWriteRegistry;
  readonly #writer: ProviderObjectWriter;
  readonly #resolveTarget: ProviderWriteTargetResolver;

  constructor(options: TargetedProviderRetryCoordinatorOptions) {
    this.#registry = options.registry;
    this.#writer = options.writer;
    this.#resolveTarget = options.resolveTarget;
  }

  async retry(input: {
    storageObjectId: string;
    providerRole: ProviderRole;
    expectedFailedCopyVersion: number;
    verifiedSource: VerifiedProviderWriteSource;
  }): Promise<Readonly<DualProviderStorageTruth>> {
    const reservation = await this.#registry.reserveTargetedProviderRetry({
      storageObjectId: input.storageObjectId,
      providerRole: input.providerRole,
      expectedFailedCopyVersion: input.expectedFailedCopyVersion,
    });
    const target = await this.#resolveTarget.resolve({
      providerRole: reservation.providerRole,
      providerBindingId: reservation.providerBindingId,
      internalLocator: reservation.internalLocator,
    });
    if (
      target.providerRole !== reservation.providerRole ||
      target.internalLocator !== reservation.internalLocator
    ) {
      throw new ProviderExecutionError('internal', 'provider-target-authority-mismatch', false);
    }
    let outcome: Readonly<DualProviderWriteOutcome>;
    try {
      const source = await input.verifiedSource.open();
      const receipt = await this.#writer.write({
        target,
        source,
        checksumSha256: reservation.checksumSha256,
        byteLength: reservation.byteLength,
      });
      outcome = verifiedOutcome(receipt);
    } catch (error) {
      if (error instanceof ProviderExecutionError && error.cleanupRequired) {
        await this.#writer.cleanup({ target });
      }
      outcome = providerFailure(error);
    }
    return this.#registry.completeTargetedProviderRetry({ reservation, outcome });
  }
}
