import { GetObjectCommand, HeadObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { CallerIdentity, SafeDiagnostic } from './runtime-contract.js';
import type {
  ProviderCredentialResolver,
  ResolvedS3CredentialBinding,
} from './runtime-s3-provider.js';

export type ObjectReadMethod = 'HEAD' | 'GET';
export type ObjectReadDeliveryState = 'hot' | 'canonical-fallback' | 'replica' | 'primary';
export type ObjectReadGrantDisposition = 'inline' | 'attachment';

export interface ResolvedProviderReadTarget {
  providerRole: 'hot' | 'canonical' | 'primary' | 'replica';
  providerId: string;
  bucketLabel: string;
  internalLocator: string;
  credentialSecretReferenceId: string;
}

export interface ObjectReadProviderCopySnapshot {
  storageObjectCopyId: string;
  providerRole: 'hot' | 'canonical';
  state: 'pending' | 'verified' | 'failed' | 'missing' | 'delete_pending' | 'deleted';
  observedChecksumSha256?: string;
  observedByteLength?: number;
  latestVerifiedAt?: string;
  target: Readonly<ResolvedProviderReadTarget>;
}



export interface ConfiguredObjectReadProviderCopySnapshot {
  storageObjectCopyId: string;
  role: 'primary' | 'replica';
  order: number;
  state: 'pending' | 'verified' | 'failed' | 'missing' | 'delete_pending' | 'deleted';
  observedChecksumSha256?: string;
  observedByteLength?: number;
  latestVerifiedAt?: string;
  target: Readonly<ResolvedProviderReadTarget>;
}

export type ObjectReadCopySnapshot =
  | ObjectReadProviderCopySnapshot
  | ConfiguredObjectReadProviderCopySnapshot;

export interface ObjectReadDeliverySnapshot {
  storageObjectId: string;
  callerAppId: string;
  registryState: 'reserved' | 'active' | 'degraded' | 'delete_pending' | 'deleted';
  objectProtectionStage: string;
  verifiedChecksumSha256?: string;
  verifiedByteLength?: number;
  verifiedContentType: string;
  copies: Readonly<{
    hot: Readonly<ObjectReadProviderCopySnapshot>;
    canonical: Readonly<ObjectReadProviderCopySnapshot>;
  }>;
  configuredCopies?: readonly Readonly<ConfiguredObjectReadProviderCopySnapshot>[];
}

export interface ReadGrantDeliveryAuthorization {
  objectReadGrantId: string;
  storageObjectId: string;
  purpose: string;
  allowedMethods: readonly ObjectReadMethod[];
  allowRange: boolean;
  disposition: ObjectReadGrantDisposition;
  fileName?: string;
  expiresAt: string;
}

export interface ObjectReadDeliveryRegistry {
  getObjectReadDeliverySnapshot(input: {
    storageObjectId: string;
    callerAppId: string;
    callerServiceId?: string;
  }): Promise<Readonly<ObjectReadDeliverySnapshot> | null>;
  beginObjectReadAttempt(input: {
    storageObjectCopyId: string;
    storageObjectId: string;
    operationReference: string;
    expectedChecksumSha256: string;
    expectedByteLength: number;
  }): Promise<Readonly<{ providerAttemptId: string }>>;
  finishObjectReadAttempt(input: {
    providerAttemptId: string;
    nextState: 'succeeded' | 'failed';
    observedByteLength?: number;
    diagnostic?: Readonly<SafeDiagnostic>;
  }): Promise<void>;
  appendObjectReadEvent(input: {
    eventId: string;
    dedupeKey: string;
    eventType: string;
    occurredAt: Date;
    callerAppId: string;
    callerServiceId?: string;
    storageObjectId: string;
    appCorrelationReference: string;
    payload: Readonly<Record<string, unknown>>;
    diagnostic?: Readonly<SafeDiagnostic>;
  }): Promise<void>;
}

export interface ProviderReadHeadResult {
  byteLength: number;
}

export interface ProviderReadStreamResult {
  byteLength: number;
  body: Readable;
  close(): void;
}

export interface ProviderObjectReader {
  head(input: {
    target: Readonly<ResolvedProviderReadTarget>;
  }): Promise<Readonly<ProviderReadHeadResult>>;
  get(input: {
    target: Readonly<ResolvedProviderReadTarget>;
    range?: string;
  }): Promise<Readonly<ProviderReadStreamResult>>;
}

interface S3ClientLike {
  send(command: unknown): Promise<Record<string, unknown>>;
  destroy?: () => void;
}

export interface S3CompatibleProviderObjectReaderOptions {
  credentialResolver: ProviderCredentialResolver;
  createClient?: (config: S3ClientConfig) => S3ClientLike;
}

export class ProviderReadExecutionError extends Error {
  readonly category = 'dependency-unavailable' as const;
  readonly status = 503;
  readonly retryable: boolean;
  readonly fallbackEligible: boolean;
  readonly code: string;

  constructor(code: string, retryable = true, fallbackEligible = true) {
    super(code);
    this.name = 'ProviderReadExecutionError';
    this.code = code;
    this.retryable = retryable;
    this.fallbackEligible = fallbackEligible;
  }

  toSafeDiagnostic(): Readonly<SafeDiagnostic> {
    return Object.freeze({
      category: this.category,
      code: /^[a-z0-9][a-z0-9-]{0,95}$/.test(this.code)
        ? this.code
        : 'provider-read-failed',
      retryable: this.retryable,
    });
  }
}

export class ObjectReadDeliveryError extends Error {
  readonly category: SafeDiagnostic['category'];
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly headers?: Readonly<Record<string, string>>;

  constructor(
    category: SafeDiagnostic['category'],
    code: string,
    status: number,
    retryable = false,
    headers?: Readonly<Record<string, string>>,
  ) {
    super(code);
    this.name = 'ObjectReadDeliveryError';
    this.category = category;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (headers !== undefined) this.headers = headers;
  }
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_LOCATOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/=-]{0,1023}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MIME_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;

function clientConfig(binding: Readonly<ResolvedS3CredentialBinding>): S3ClientConfig {
  return {
    endpoint: binding.endpoint,
    region: binding.region,
    forcePathStyle: binding.forcePathStyle,
    credentials: {
      accessKeyId: binding.accessKeyId,
      secretAccessKey: binding.secretAccessKey,
      ...(binding.sessionToken === undefined ? {} : { sessionToken: binding.sessionToken }),
    },
  };
}

function validTarget(target: Readonly<ResolvedProviderReadTarget>): boolean {
  return (
    (target.providerRole === 'hot' || target.providerRole === 'canonical' ||
      target.providerRole === 'primary' || target.providerRole === 'replica') &&
    SAFE_ID_PATTERN.test(target.providerId) &&
    SAFE_ID_PATTERN.test(target.bucketLabel) &&
    SAFE_LOCATOR_PATTERN.test(target.internalLocator) &&
    !target.internalLocator.startsWith('/') &&
    !target.internalLocator.includes('..') &&
    !target.internalLocator.includes('\\') &&
    !target.internalLocator.includes('://') &&
    target.credentialSecretReferenceId.length > 0 &&
    target.credentialSecretReferenceId.length <= 256
  );
}

function httpStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const metadata = (error as Record<string, unknown>).$metadata;
  if (metadata === null || typeof metadata !== 'object') return undefined;
  const status = (metadata as Record<string, unknown>).httpStatusCode;
  return typeof status === 'number' ? status : undefined;
}

function providerFailure(error: unknown): ProviderReadExecutionError {
  if (error instanceof ProviderReadExecutionError) return error;
  if (httpStatus(error) === 404) {
    return new ProviderReadExecutionError('provider-read-missing', true, true);
  }
  return new ProviderReadExecutionError('provider-read-failed', true, true);
}

function requireObservedLength(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ProviderReadExecutionError('provider-read-metadata-invalid', false, true);
  }
  return value;
}

function requireReadable(value: unknown): Readable {
  if (value instanceof Readable) return value;
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { on?: unknown }).on === 'function' &&
    typeof (value as { destroy?: unknown }).destroy === 'function' &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  ) {
    return value as Readable;
  }
  throw new ProviderReadExecutionError('provider-read-body-invalid', false, true);
}

export class S3CompatibleProviderObjectReader implements ProviderObjectReader {
  readonly #resolver: ProviderCredentialResolver;
  readonly #createClient: (config: S3ClientConfig) => S3ClientLike;

  constructor(options: S3CompatibleProviderObjectReaderOptions) {
    this.#resolver = options.credentialResolver;
    this.#createClient = options.createClient ?? ((config) => new S3Client(config));
  }

  async head(input: {
    target: Readonly<ResolvedProviderReadTarget>;
  }): Promise<Readonly<ProviderReadHeadResult>> {
    if (!validTarget(input.target)) {
      throw new ProviderReadExecutionError('provider-read-target-invalid', false, false);
    }
    let client: S3ClientLike | undefined;
    try {
      const binding = await this.#resolver.resolve(input.target.credentialSecretReferenceId);
      client = this.#createClient(clientConfig(binding));
      const response = await client.send(
        new HeadObjectCommand({
          Bucket: input.target.bucketLabel,
          Key: input.target.internalLocator,
        }),
      );
      return Object.freeze({ byteLength: requireObservedLength(response.ContentLength) });
    } catch (error) {
      throw providerFailure(error);
    } finally {
      client?.destroy?.();
    }
  }

  async get(input: {
    target: Readonly<ResolvedProviderReadTarget>;
    range?: string;
  }): Promise<Readonly<ProviderReadStreamResult>> {
    if (!validTarget(input.target)) {
      throw new ProviderReadExecutionError('provider-read-target-invalid', false, false);
    }
    let client: S3ClientLike | undefined;
    try {
      const binding = await this.#resolver.resolve(input.target.credentialSecretReferenceId);
      client = this.#createClient(clientConfig(binding));
      const response = await client.send(
        new GetObjectCommand({
          Bucket: input.target.bucketLabel,
          Key: input.target.internalLocator,
          ...(input.range === undefined ? {} : { Range: input.range }),
        }),
      );
      const body = requireReadable(response.Body);
      const byteLength = requireObservedLength(response.ContentLength);
      const activeClient = client;
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        activeClient.destroy?.();
      };
      client = undefined;
      return Object.freeze({ byteLength, body, close });
    } catch (error) {
      client?.destroy?.();
      throw providerFailure(error);
    }
  }
}

interface ParsedRange {
  start: number;
  end: number;
  byteLength: number;
  providerRange: string;
  contentRange: string;
}

function rangeError(code: string, total: number): ObjectReadDeliveryError {
  return new ObjectReadDeliveryError(
    'invalid-request',
    code,
    416,
    false,
    Object.freeze({
      'accept-ranges': 'bytes',
      'content-range': `bytes */${total}`,
    }),
  );
}

export function parseSingleByteRange(value: string, total: number): Readonly<ParsedRange> {
  if (!Number.isSafeInteger(total) || total <= 0) {
    throw new ObjectReadDeliveryError('internal', 'invalid-verified-byte-length', 500);
  }
  if (value.length > 128 || value.includes(',')) {
    throw rangeError(value.includes(',') ? 'multiple-ranges-not-supported' : 'invalid-range', total);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (match === null) throw rangeError('invalid-range', total);
  const left = match[1] ?? '';
  const right = match[2] ?? '';
  if (left === '' && right === '') throw rangeError('invalid-range', total);

  let start: number;
  let end: number;
  if (left === '') {
    const suffix = Number(right);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw rangeError('invalid-range', total);
    start = Math.max(total - suffix, 0);
    end = total - 1;
  } else {
    start = Number(left);
    if (!Number.isSafeInteger(start) || start < 0 || start >= total) {
      throw rangeError('range-not-satisfiable', total);
    }
    if (right === '') {
      end = total - 1;
    } else {
      end = Number(right);
      if (!Number.isSafeInteger(end) || end < start) throw rangeError('invalid-range', total);
      end = Math.min(end, total - 1);
    }
  }
  const byteLength = end - start + 1;
  return Object.freeze({
    start,
    end,
    byteLength,
    providerRange: `bytes=${start}-${end}`,
    contentRange: `bytes ${start}-${end}/${total}`,
  });
}

function safeDiagnostic(error: unknown): Readonly<SafeDiagnostic> {
  if (error instanceof ProviderReadExecutionError) return error.toSafeDiagnostic();
  if (error instanceof ObjectReadDeliveryError) {
    return Object.freeze({
      category: error.category,
      code: error.code,
      retryable: error.retryable,
    });
  }
  return Object.freeze({
    category: 'dependency-unavailable',
    code: 'provider-read-failed',
    retryable: true,
  });
}

function usableCopy(
  copy: Readonly<ObjectReadCopySnapshot>,
  checksum: string,
  byteLength: number,
): 'usable' | 'fallback' | 'conflict' {
  if (copy.state !== 'verified') return 'fallback';
  if (
    copy.observedChecksumSha256 !== checksum ||
    copy.observedByteLength !== byteLength
  ) {
    return 'conflict';
  }
  if (copy.latestVerifiedAt === undefined) return 'fallback';
  return 'usable';
}

function commonHeaders(input: {
  checksum: string;
  contentType: string;
  byteLength: number;
  disposition: ObjectReadGrantDisposition;
  fileName?: string;
  deliveryState: ObjectReadDeliveryState;
  range?: Readonly<ParsedRange>;
}): Record<string, string> {
  const disposition =
    input.fileName === undefined
      ? input.disposition
      : `${input.disposition}; filename="${input.fileName.replaceAll('"', '')}"`;
  return {
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store, max-age=0',
    'content-disposition': disposition,
    'content-length': String(input.range?.byteLength ?? input.byteLength),
    'content-type': input.contentType,
    etag: `"${input.checksum}"`,
    'x-zs-delivery-state': input.deliveryState,
    ...(input.range === undefined ? {} : { 'content-range': input.range.contentRange }),
  };
}

async function finalizeAttempt(
  registry: ObjectReadDeliveryRegistry,
  input: {
    providerAttemptId: string;
    nextState: 'succeeded' | 'failed';
    observedByteLength?: number;
    diagnostic?: Readonly<SafeDiagnostic>;
  },
): Promise<void> {
  try {
    await registry.finishObjectReadAttempt(input);
  } catch {
    throw new ObjectReadDeliveryError(
      'dependency-unavailable',
      'read-attempt-recording-failed',
      503,
      true,
    );
  }
}

function toSafeWebStream(input: {
  source: Readable;
  close(): void;
  signal: AbortSignal;
  onSuccess(): Promise<void>;
  onFailure(diagnostic: Readonly<SafeDiagnostic>): Promise<void>;
}): ReadableStream<Uint8Array> {
  const iterator = input.source[Symbol.asyncIterator]();
  let finalized = false;

  const complete = async (): Promise<void> => {
    if (finalized) return;
    finalized = true;
    input.close();
    await input.onSuccess();
  };
  const fail = async (diagnostic: Readonly<SafeDiagnostic>): Promise<void> => {
    if (finalized) return;
    finalized = true;
    input.source.destroy();
    input.close();
    await input.onFailure(diagnostic);
  };
  const abort = (): void => {
    void fail(Object.freeze({
      category: 'dependency-unavailable',
      code: 'object-read-cancelled',
      retryable: true,
    }));
  };
  input.signal.addEventListener('abort', abort, { once: true });

  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      if (input.signal.aborted) {
        await fail(Object.freeze({
          category: 'dependency-unavailable',
          code: 'object-read-cancelled',
          retryable: true,
        }));
        controller.error(new Error('object-read-cancelled'));
        return;
      }
      try {
        const entry = await iterator.next();
        if (entry.done) {
          input.signal.removeEventListener('abort', abort);
          await complete();
          controller.close();
          return;
        }
        const chunk = entry.value;
        controller.enqueue(
          chunk instanceof Uint8Array ? chunk : new Uint8Array(Buffer.from(chunk as unknown as string)),
        );
      } catch {
        input.signal.removeEventListener('abort', abort);
        await fail(Object.freeze({
          category: 'dependency-unavailable',
          code: 'object-read-stream-failed',
          retryable: true,
        }));
        controller.error(new Error('object-read-stream-failed'));
      }
    },
    async cancel(): Promise<void> {
      input.signal.removeEventListener('abort', abort);
      await iterator.return?.();
      await fail(Object.freeze({
        category: 'dependency-unavailable',
        code: 'object-read-cancelled',
        retryable: true,
      }));
    },
  });
}

export interface ObjectReadDeliveryResult {
  status: 200 | 206;
  headers: Readonly<Record<string, string>>;
  body: ReadableStream<Uint8Array> | null;
  deliveryState: ObjectReadDeliveryState;
}

export interface ObjectReadDeliveryService {
  deliver(input: {
    grant: Readonly<ReadGrantDeliveryAuthorization>;
    caller: Readonly<CallerIdentity>;
    method: ObjectReadMethod;
    rangeHeader?: string;
    appCorrelationReference: string;
    requestId: string;
    signal: AbortSignal;
  }): Promise<Readonly<ObjectReadDeliveryResult>>;
}

export interface ObjectReadDeliveryCoordinatorOptions {
  registry: ObjectReadDeliveryRegistry;
  providerReader: ProviderObjectReader;
  now?: () => Date;
  createId?: () => string;
}

export class ObjectReadDeliveryCoordinator implements ObjectReadDeliveryService {
  readonly #registry: ObjectReadDeliveryRegistry;
  readonly #providerReader: ProviderObjectReader;
  readonly #now: () => Date;
  readonly #createId: () => string;

  constructor(options: ObjectReadDeliveryCoordinatorOptions) {
    this.#registry = options.registry;
    this.#providerReader = options.providerReader;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  async deliver(input: {
    grant: Readonly<ReadGrantDeliveryAuthorization>;
    caller: Readonly<CallerIdentity>;
    method: ObjectReadMethod;
    rangeHeader?: string;
    appCorrelationReference: string;
    requestId: string;
    signal: AbortSignal;
  }): Promise<Readonly<ObjectReadDeliveryResult>> {
    if (new Date(input.grant.expiresAt).getTime() <= this.#now().getTime()) {
      throw new ObjectReadDeliveryError('unauthenticated', 'object-read-grant-expired', 401);
    }
    if (!input.grant.allowedMethods.includes(input.method)) {
      throw new ObjectReadDeliveryError('unauthorized', 'object-read-method-not-allowed', 403);
    }
    if (input.rangeHeader !== undefined && !input.grant.allowRange) {
      throw new ObjectReadDeliveryError('unauthorized', 'object-read-range-not-allowed', 403);
    }
    const snapshot = await this.#registry.getObjectReadDeliverySnapshot({
      storageObjectId: input.grant.storageObjectId,
      callerAppId: input.caller.appId,
      ...(input.caller.serviceId === undefined ? {} : { callerServiceId: input.caller.serviceId }),
    });
    if (snapshot === null || snapshot.callerAppId !== input.caller.appId) {
      throw new ObjectReadDeliveryError('not-ready', 'storage-object-not-found', 404);
    }
    if (snapshot.registryState === 'reserved') {
      throw new ObjectReadDeliveryError('not-ready', 'storage-object-not-ready', 409, true);
    }
    if (snapshot.registryState === 'delete_pending' || snapshot.registryState === 'deleted') {
      throw new ObjectReadDeliveryError('not-ready', 'storage-object-unavailable', 410);
    }
    const checksum = snapshot.verifiedChecksumSha256;
    const total = snapshot.verifiedByteLength;
    if (
      checksum === undefined ||
      !SHA256_PATTERN.test(checksum) ||
      total === undefined ||
      !Number.isSafeInteger(total) ||
      total <= 0 ||
      !MIME_PATTERN.test(snapshot.verifiedContentType)
    ) {
      throw new ObjectReadDeliveryError('not-ready', 'storage-object-unverified', 409);
    }
    const range =
      input.rangeHeader === undefined ? undefined : parseSingleByteRange(input.rangeHeader, total);
    const expectedLength = range?.byteLength ?? total;

    if (snapshot.configuredCopies !== undefined) {
      const orderedCopies = [...snapshot.configuredCopies].sort((left, right) => {
        const leftGroup = left.role === 'replica' ? 0 : 1;
        const rightGroup = right.role === 'replica' ? 0 : 1;
        return leftGroup - rightGroup || left.order - right.order ||
          left.storageObjectCopyId.localeCompare(right.storageObjectCopyId);
      });
      for (const copy of orderedCopies) {
        const disposition = usableCopy(copy, checksum, total);
        if (disposition === 'conflict') {
          throw new ObjectReadDeliveryError('not-ready', 'storage-object-copy-state-conflict', 409);
        }
        if (disposition !== 'usable') continue;
        try {
          return await this.#attempt({
            input,
            snapshot,
            copy,
            checksum,
            total,
            expectedLength,
            ...(range === undefined ? {} : { range }),
            deliveryState: copy.role,
          });
        } catch (error) {
          if (!(error instanceof ProviderReadExecutionError) || !error.fallbackEligible) throw error;
        }
      }
      throw new ObjectReadDeliveryError(
        'dependency-unavailable',
        'object-content-unavailable',
        503,
        true,
      );
    }

    const legacyCopies = snapshot.copies;
    if (legacyCopies === undefined) {
      throw new ObjectReadDeliveryError(
        'dependency-unavailable',
        'object-content-unavailable',
        503,
        true,
      );
    }
    const hotDisposition = usableCopy(legacyCopies.hot, checksum, total);
    if (hotDisposition === 'conflict') {
      throw new ObjectReadDeliveryError('not-ready', 'storage-object-copy-state-conflict', 409);
    }

    if (hotDisposition === 'usable') {
      try {
        return await this.#attempt({
          input,
          snapshot,
          copy: legacyCopies.hot,
          checksum,
          total,
          expectedLength,
          ...(range === undefined ? {} : { range }),
          deliveryState: 'hot',
        });
      } catch (error) {
        if (!(error instanceof ProviderReadExecutionError) || !error.fallbackEligible) throw error;
      }
    }

    const canonicalDisposition = usableCopy(legacyCopies.canonical, checksum, total);
    if (canonicalDisposition === 'conflict') {
      throw new ObjectReadDeliveryError('not-ready', 'storage-object-copy-state-conflict', 409);
    }
    if (canonicalDisposition !== 'usable') {
      throw new ObjectReadDeliveryError(
        'dependency-unavailable',
        'object-content-unavailable',
        503,
        true,
      );
    }
    try {
      return await this.#attempt({
        input,
        snapshot,
        copy: legacyCopies.canonical,
        checksum,
        total,
        expectedLength,
        ...(range === undefined ? {} : { range }),
        deliveryState: 'canonical-fallback',
      });
    } catch (error) {
      if (error instanceof ProviderReadExecutionError) {
        throw new ObjectReadDeliveryError(
          'dependency-unavailable',
          'object-content-unavailable',
          503,
          error.retryable,
        );
      }
      throw error;
    }
  }

  async #attempt(input: {
    input: {
      grant: Readonly<ReadGrantDeliveryAuthorization>;
      caller: Readonly<CallerIdentity>;
      method: ObjectReadMethod;
      rangeHeader?: string;
      appCorrelationReference: string;
      requestId: string;
      signal: AbortSignal;
    };
    snapshot: Readonly<ObjectReadDeliverySnapshot>;
    copy: Readonly<ObjectReadCopySnapshot>;
    checksum: string;
    total: number;
    expectedLength: number;
    range?: Readonly<ParsedRange>;
    deliveryState: ObjectReadDeliveryState;
  }): Promise<Readonly<ObjectReadDeliveryResult>> {
    const reservation = await this.#registry.beginObjectReadAttempt({
      storageObjectCopyId: input.copy.storageObjectCopyId,
      storageObjectId: input.snapshot.storageObjectId,
      operationReference: `object-read:${input.input.requestId}`,
      expectedChecksumSha256: input.checksum,
      expectedByteLength: input.expectedLength,
    });

    try {
      if (input.input.method === 'HEAD') {
        const observed = await this.#providerReader.head({ target: input.copy.target });
        if (observed.byteLength !== input.total) {
          throw new ProviderReadExecutionError('provider-read-length-mismatch', false, true);
        }
        await finalizeAttempt(this.#registry, {
          providerAttemptId: reservation.providerAttemptId,
          nextState: 'succeeded',
          observedByteLength: observed.byteLength,
        });
        await this.#appendSuccessEvent(input);
        return Object.freeze({
          status: input.range === undefined ? 200 : 206,
          headers: Object.freeze(commonHeaders({
            checksum: input.checksum,
            contentType: input.snapshot.verifiedContentType,
            byteLength: input.total,
            disposition: input.input.grant.disposition,
            ...(input.input.grant.fileName === undefined
              ? {}
              : { fileName: input.input.grant.fileName }),
            deliveryState: input.deliveryState,
            ...(input.range === undefined ? {} : { range: input.range }),
          })),
          body: null,
          deliveryState: input.deliveryState,
        });
      }

      const read = await this.#providerReader.get({
        target: input.copy.target,
        ...(input.range === undefined ? {} : { range: input.range.providerRange }),
      });
      if (read.byteLength !== input.expectedLength) {
        read.body.destroy();
        read.close();
        throw new ProviderReadExecutionError('provider-read-length-mismatch', false, true);
      }
      const body = toSafeWebStream({
        source: read.body,
        close: read.close,
        signal: input.input.signal,
        onSuccess: async () => {
          await finalizeAttempt(this.#registry, {
            providerAttemptId: reservation.providerAttemptId,
            nextState: 'succeeded',
            observedByteLength: read.byteLength,
          });
          await this.#appendSuccessEvent(input);
        },
        onFailure: async (diagnostic) => {
          await finalizeAttempt(this.#registry, {
            providerAttemptId: reservation.providerAttemptId,
            nextState: 'failed',
            diagnostic,
          });
        },
      });
      return Object.freeze({
        status: input.range === undefined ? 200 : 206,
        headers: Object.freeze(commonHeaders({
          checksum: input.checksum,
          contentType: input.snapshot.verifiedContentType,
          byteLength: input.total,
          disposition: input.input.grant.disposition,
          ...(input.input.grant.fileName === undefined
            ? {}
            : { fileName: input.input.grant.fileName }),
          deliveryState: input.deliveryState,
          ...(input.range === undefined ? {} : { range: input.range }),
        })),
        body,
        deliveryState: input.deliveryState,
      });
    } catch (error) {
      await finalizeAttempt(this.#registry, {
        providerAttemptId: reservation.providerAttemptId,
        nextState: 'failed',
        diagnostic: safeDiagnostic(error),
      });
      if (error instanceof ProviderReadExecutionError || error instanceof ObjectReadDeliveryError) {
        throw error;
      }
      throw new ProviderReadExecutionError('provider-read-failed', true, true);
    }
  }

  async #appendSuccessEvent(input: {
    input: {
      grant: Readonly<ReadGrantDeliveryAuthorization>;
      caller: Readonly<CallerIdentity>;
      method: ObjectReadMethod;
      rangeHeader?: string;
      appCorrelationReference: string;
      requestId: string;
      signal: AbortSignal;
    };
    snapshot: Readonly<ObjectReadDeliverySnapshot>;
    deliveryState: ObjectReadDeliveryState;
    range?: Readonly<ParsedRange>;
  }): Promise<void> {
    await this.#registry.appendObjectReadEvent({
      eventId: this.#createId(),
      dedupeKey: `object-read-delivered:${input.input.requestId}`,
      eventType: 'object-read-delivered',
      occurredAt: this.#now(),
      callerAppId: input.input.caller.appId,
      ...(input.input.caller.serviceId === undefined
        ? {}
        : { callerServiceId: input.input.caller.serviceId }),
      storageObjectId: input.snapshot.storageObjectId,
      appCorrelationReference: input.input.appCorrelationReference,
      payload: Object.freeze({
        objectReadGrantId: input.input.grant.objectReadGrantId,
        method: input.input.method,
        rangeApplied: input.range !== undefined,
        deliveryState: input.deliveryState,
      }),
    });
  }
}
