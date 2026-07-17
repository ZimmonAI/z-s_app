import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import {
  CONTRACT_VERSION,
  PACKAGE_VERSION,
  SERVICE_ID,
  SUPPORTED_CONTRACT_VERSIONS,
  type CallerIdentity,
  type ContractVersion,
  type HttpStorageRuntime,
  type SafeDiagnostic,
  type SafeDiagnosticCategory,
  type StorageHealth,
  type StorageReadiness,
} from './runtime-contract.js';
import type {
  ProviderCredentialResolver,
  ResolvedS3CredentialBinding,
} from './runtime-s3-provider.js';
import {
  READ_GRANT_TOKEN_PURPOSE,
  ReadGrantError,
  createDeterministicReadGrantTokenService,
  normalizeReadGrantRequest,
  readGrantTokenDigest,
  type ObjectReadMethod,
  type ReadDeliverySnapshot,
  type ReadGrantRegistry,
  type ReadGrantRequest,
  type ReadGrantResult,
  type ReadGrantRevocationResult,
  type ReadGrantTokenClaims,
  type ReadGrantTokenService,
  type ReadProviderRole,
  type ResolvedReadTarget,
} from './runtime-read-grant.js';

export type ReadDeliveryState = 'hot' | 'canonical-fallback';

export interface ParsedByteRange {
  start: number;
  end: number;
  length: number;
  contentRange: string;
  providerRange: string;
}

export class ReadDeliveryError extends Error {
  readonly category: SafeDiagnosticCategory;
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly fallbackEligible: boolean;

  constructor(
    category: SafeDiagnosticCategory,
    code: string,
    status: number,
    options: {
      retryable?: boolean;
      responseHeaders?: Readonly<Record<string, string>>;
      fallbackEligible?: boolean;
    } = {},
  ) {
    super(code);
    this.name = 'ReadDeliveryError';
    this.category = category;
    this.code = code;
    this.status = status;
    this.retryable = options.retryable ?? false;
    this.responseHeaders = options.responseHeaders ?? Object.freeze({});
    this.fallbackEligible = options.fallbackEligible ?? false;
  }

  toSafeDiagnostic(): Readonly<SafeDiagnostic> {
    return Object.freeze({
      category: this.category,
      code: this.code,
      retryable: this.retryable,
    });
  }
}

export class ReadDeliveryStreamError extends Error {
  constructor() {
    super('read-delivery-stream-failed');
    this.name = 'ReadDeliveryStreamError';
  }
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_LOCATOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/=-]{0,1023}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_DIAGNOSTIC_CATEGORIES: readonly SafeDiagnosticCategory[] = [
  'invalid-request',
  'unauthenticated',
  'unauthorized',
  'incompatible-version',
  'duplicate-conflict',
  'not-ready',
  'dependency-unavailable',
  'internal',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function requiredString(value: unknown, code: string, max = 256): string {
  if (typeof value !== 'string') throw new ReadDeliveryError('invalid-request', code, 400);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max) {
    throw new ReadDeliveryError('invalid-request', code, 400);
  }
  return normalized;
}

function safeCorrelation(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function callerService(caller: Readonly<CallerIdentity>): string {
  return caller.serviceId ?? '';
}

function normalizeExternalError(error: unknown): ReadDeliveryError {
  if (error instanceof ReadDeliveryError) return error;
  if (error instanceof ReadGrantError) {
    return new ReadDeliveryError(error.category, error.code, error.status, {
      retryable: error.retryable,
    });
  }
  if (isRecord(error)) {
    const category = error.category;
    const code = error.code;
    const status = error.status;
    if (
      typeof category === 'string' &&
      SAFE_DIAGNOSTIC_CATEGORIES.includes(category as SafeDiagnosticCategory) &&
      typeof code === 'string' &&
      /^[a-z0-9][a-z0-9-]{0,95}$/.test(code) &&
      Number.isSafeInteger(status) &&
      (status as number) >= 400 &&
      (status as number) <= 599
    ) {
      return new ReadDeliveryError(category as SafeDiagnosticCategory, code, status as number, {
        retryable: error.retryable === true,
        fallbackEligible: error.fallbackEligible === true,
      });
    }
  }
  return new ReadDeliveryError('internal', 'internal-error', 500);
}

function json(body: unknown, status = 200, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export function parseSingleByteRange(
  rangeHeader: string | null,
  verifiedSize: number,
  rangeAllowed: boolean,
): Readonly<ParsedByteRange> | null {
  if (!Number.isSafeInteger(verifiedSize) || verifiedSize <= 0) {
    throw new ReadDeliveryError('internal', 'invalid-verified-size', 500);
  }
  if (rangeHeader === null) return null;
  if (!rangeAllowed) {
    throw new ReadDeliveryError('unauthorized', 'read-grant-range-not-allowed', 403);
  }
  const responseHeaders = Object.freeze({ 'content-range': `bytes */${verifiedSize}` });
  const normalized = rangeHeader.trim();
  if (!normalized.startsWith('bytes=') || normalized.includes(',')) {
    throw new ReadDeliveryError('invalid-request', 'invalid-byte-range', 416, { responseHeaders });
  }
  const spec = normalized.slice('bytes='.length);
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (match === null || (match[1] === '' && match[2] === '')) {
    throw new ReadDeliveryError('invalid-request', 'invalid-byte-range', 416, { responseHeaders });
  }

  let start: number;
  let end: number;
  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new ReadDeliveryError('invalid-request', 'invalid-byte-range', 416, { responseHeaders });
    }
    const effectiveLength = Math.min(suffixLength, verifiedSize);
    start = verifiedSize - effectiveLength;
    end = verifiedSize - 1;
  } else {
    start = Number(match[1]);
    if (!Number.isSafeInteger(start) || start < 0 || start >= verifiedSize) {
      throw new ReadDeliveryError('invalid-request', 'unsatisfiable-byte-range', 416, {
        responseHeaders,
      });
    }
    if (match[2] === '') {
      end = verifiedSize - 1;
    } else {
      end = Number(match[2]);
      if (!Number.isSafeInteger(end) || end < start) {
        throw new ReadDeliveryError('invalid-request', 'invalid-byte-range', 416, {
          responseHeaders,
        });
      }
      end = Math.min(end, verifiedSize - 1);
    }
  }
  const length = end - start + 1;
  return Object.freeze({
    start,
    end,
    length,
    contentRange: `bytes ${start}-${end}/${verifiedSize}`,
    providerRange: `bytes=${start}-${end}`,
  });
}

export interface ProviderReadHeadReceipt {
  byteLength: number;
}

export interface ProviderReadBodyReceipt {
  byteLength: number;
  body: ReadableStream<Uint8Array>;
  contentRange?: string;
}

export interface ProviderObjectReader {
  head(target: Readonly<ResolvedReadTarget>): Promise<Readonly<ProviderReadHeadReceipt>>;
  read(input: {
    target: Readonly<ResolvedReadTarget>;
    range?: Readonly<ParsedByteRange>;
    signal?: AbortSignal;
  }): Promise<Readonly<ProviderReadBodyReceipt>>;
}

interface S3ClientLike {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<Record<string, unknown>>;
  destroy?: () => void;
}

export interface S3CompatibleProviderObjectReaderOptions {
  credentialResolver: ProviderCredentialResolver;
  createClient?: (config: S3ClientConfig) => S3ClientLike;
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

function validTarget(target: Readonly<ResolvedReadTarget>): boolean {
  const prefix = target.normalizedPrefixPattern.endsWith('*')
    ? target.normalizedPrefixPattern.slice(0, -1)
    : '';
  return (
    (target.providerRole === 'hot' || target.providerRole === 'canonical') &&
    UUID_PATTERN.test(target.storageObjectCopyId) &&
    SAFE_ID_PATTERN.test(target.providerId) &&
    SAFE_ID_PATTERN.test(target.bucketLabel) &&
    SAFE_LOCATOR_PATTERN.test(target.internalLocator) &&
    target.internalLocator.startsWith(prefix) &&
    !target.internalLocator.startsWith('/') &&
    !target.internalLocator.includes('..') &&
    !target.internalLocator.includes('\\') &&
    !target.internalLocator.includes('://') &&
    target.credentialSecretReferenceId.length > 0
  );
}

function httpStatus(error: unknown): number | undefined {
  if (!isRecord(error) || !isRecord(error.$metadata)) return undefined;
  const value = error.$metadata.httpStatusCode;
  return typeof value === 'number' ? value : undefined;
}

function providerFailure(error: unknown, operation: 'head' | 'read'): ReadDeliveryError {
  if (error instanceof ReadDeliveryError) return error;
  const status = httpStatus(error);
  if (status === 404) {
    return new ReadDeliveryError('dependency-unavailable', 'provider-object-missing', 503, {
      retryable: true,
      fallbackEligible: true,
    });
  }
  return new ReadDeliveryError('dependency-unavailable', `provider-${operation}-failed`, 503, {
    retryable: true,
    fallbackEligible: true,
  });
}

function observedLength(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ReadDeliveryError('dependency-unavailable', 'provider-length-invalid', 503, {
      fallbackEligible: true,
    });
  }
  return value;
}

function bodyToWebStream(value: unknown): ReadableStream<Uint8Array> {
  if (value instanceof ReadableStream) return value as ReadableStream<Uint8Array>;
  if (isRecord(value) && typeof value.transformToWebStream === 'function') {
    const transformed = value.transformToWebStream();
    if (transformed instanceof ReadableStream) {
      return transformed as ReadableStream<Uint8Array>;
    }
  }
  if (value instanceof Readable) {
    return Readable.toWeb(value) as ReadableStream<Uint8Array>;
  }
  throw new ReadDeliveryError('dependency-unavailable', 'provider-body-invalid', 503, {
    fallbackEligible: true,
  });
}

function managedStream(
  source: ReadableStream<Uint8Array>,
  cleanup: () => void,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cleaned = false;
  const finish = (): void => {
    if (!cleaned) {
      cleaned = true;
      cleanup();
    }
  };
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      reader = source.getReader();
      const pump = async (): Promise<void> => {
        try {
          while (true) {
            const result = await reader?.read();
            if (result === undefined || result.done) {
              controller.close();
              finish();
              return;
            }
            controller.enqueue(result.value);
          }
        } catch {
          controller.error(new ReadDeliveryStreamError());
          finish();
        }
      };
      void pump();
    },
    async cancel(reason): Promise<void> {
      try {
        await reader?.cancel(reason);
      } finally {
        finish();
      }
    },
  });
}

export class S3CompatibleProviderObjectReader implements ProviderObjectReader {
  readonly #resolver: ProviderCredentialResolver;
  readonly #createClient: (config: S3ClientConfig) => S3ClientLike;

  constructor(options: S3CompatibleProviderObjectReaderOptions) {
    this.#resolver = options.credentialResolver;
    this.#createClient = options.createClient ?? ((config) => new S3Client(config));
  }

  async head(target: Readonly<ResolvedReadTarget>): Promise<Readonly<ProviderReadHeadReceipt>> {
    if (!validTarget(target)) {
      throw new ReadDeliveryError('invalid-request', 'provider-read-target-invalid', 400);
    }
    let binding: Readonly<ResolvedS3CredentialBinding>;
    try {
      binding = await this.#resolver.resolve(target.credentialSecretReferenceId);
    } catch (error) {
      throw providerFailure(error, 'head');
    }
    const client = this.#createClient(clientConfig(binding));
    try {
      const result = await client.send(
        new HeadObjectCommand({ Bucket: target.bucketLabel, Key: target.internalLocator }),
      );
      return Object.freeze({ byteLength: observedLength(result.ContentLength) });
    } catch (error) {
      throw providerFailure(error, 'head');
    } finally {
      client.destroy?.();
    }
  }

  async read(input: {
    target: Readonly<ResolvedReadTarget>;
    range?: Readonly<ParsedByteRange>;
    signal?: AbortSignal;
  }): Promise<Readonly<ProviderReadBodyReceipt>> {
    if (!validTarget(input.target)) {
      throw new ReadDeliveryError('invalid-request', 'provider-read-target-invalid', 400);
    }
    let binding: Readonly<ResolvedS3CredentialBinding>;
    try {
      binding = await this.#resolver.resolve(input.target.credentialSecretReferenceId);
    } catch (error) {
      throw providerFailure(error, 'read');
    }
    const client = this.#createClient(clientConfig(binding));
    try {
      const result = await client.send(
        new GetObjectCommand({
          Bucket: input.target.bucketLabel,
          Key: input.target.internalLocator,
          ...(input.range === undefined ? {} : { Range: input.range.providerRange }),
        }),
        input.signal === undefined ? undefined : { abortSignal: input.signal },
      );
      const byteLength = observedLength(result.ContentLength);
      const body = managedStream(bodyToWebStream(result.Body), () => client.destroy?.());
      const receipt: ProviderReadBodyReceipt = { byteLength, body };
      if (typeof result.ContentRange === 'string') receipt.contentRange = result.ContentRange;
      return Object.freeze(receipt);
    } catch (error) {
      client.destroy?.();
      throw providerFailure(error, 'read');
    }
  }
}

export interface ObjectReadDeliveryResult {
  status: 200 | 206;
  headers: Readonly<Record<string, string>>;
  body: ReadableStream<Uint8Array> | null;
  deliveryState: ReadDeliveryState;
}

function contentDisposition(snapshot: Readonly<ReadDeliverySnapshot>): string {
  const disposition = snapshot.grant.disposition;
  if (snapshot.grant.fileName === undefined) return disposition;
  return `${disposition}; filename*=UTF-8''${encodeURIComponent(snapshot.grant.fileName)}`;
}

function responseHeaders(
  snapshot: Readonly<ReadDeliverySnapshot>,
  range: Readonly<ParsedByteRange> | null,
  deliveryState: ReadDeliveryState,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {
    'content-type': snapshot.mediaType,
    'content-length': String(range?.length ?? snapshot.byteLength),
    'accept-ranges': 'bytes',
    etag: `"sha256-${snapshot.checksumSha256}"`,
    'content-disposition': contentDisposition(snapshot),
    'cache-control': 'private, max-age=60, no-transform',
    'x-zs-delivery-state': deliveryState,
  };
  if (range !== null) headers['content-range'] = range.contentRange;
  return Object.freeze(headers);
}

export interface ObjectReadDeliveryCoordinatorOptions {
  providerReader: ProviderObjectReader;
  registry?: ReadGrantRegistry;
}

export class ObjectReadDeliveryCoordinator {
  readonly #providerReader: ProviderObjectReader;
  readonly #registry?: ReadGrantRegistry;

  constructor(options: ObjectReadDeliveryCoordinatorOptions) {
    this.#providerReader = options.providerReader;
    this.#registry = options.registry;
  }

  async deliver(input: {
    snapshot: Readonly<ReadDeliverySnapshot>;
    method: ObjectReadMethod;
    rangeHeader: string | null;
    signal?: AbortSignal;
  }): Promise<Readonly<ObjectReadDeliveryResult>> {
    const range = parseSingleByteRange(
      input.rangeHeader,
      input.snapshot.byteLength,
      input.snapshot.grant.allowRange,
    );
    const roles: ReadProviderRole[] = [];
    if (input.snapshot.targets.hot !== undefined) roles.push('hot');
    if (input.snapshot.targets.canonical !== undefined) roles.push('canonical');
    let attemptNumber = 0;
    let lastFailure: ReadDeliveryError | undefined;

    for (const role of roles) {
      attemptNumber += 1;
      const target = input.snapshot.targets[role];
      if (target === undefined) continue;
      const deliveryState: ReadDeliveryState = role === 'hot' ? 'hot' : 'canonical-fallback';
      let providerAttemptId: string | undefined;
      try {
        providerAttemptId = await this.#registry?.beginReadAttempt({
          snapshot: input.snapshot,
          providerRole: role,
          attemptNumber,
        });
        if (input.method === 'HEAD') {
          const receipt = await this.#providerReader.head(target);
          if (receipt.byteLength !== input.snapshot.byteLength) {
            throw new ReadDeliveryError('dependency-unavailable', 'provider-read-state-stale', 503, {
              retryable: true,
              fallbackEligible: true,
            });
          }
          if (providerAttemptId !== undefined) {
            await this.#registry?.finishReadAttempt({
              providerAttemptId,
              succeeded: true,
              observedByteLength: receipt.byteLength,
            });
          }
          await this.#registry?.appendReadEvent({
            snapshot: input.snapshot,
            eventType: 'object-read-delivered',
            deliveryState,
            method: input.method,
            rangeRequested: range !== null,
          });
          return Object.freeze({
            status: range === null ? 200 : 206,
            headers: responseHeaders(input.snapshot, range, deliveryState),
            body: null,
            deliveryState,
          });
        }

        const receipt = await this.#providerReader.read({
          target,
          ...(range === null ? {} : { range }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        const expectedLength = range?.length ?? input.snapshot.byteLength;
        if (
          receipt.byteLength !== expectedLength ||
          (range !== null &&
            receipt.contentRange !== undefined &&
            receipt.contentRange !== range.contentRange)
        ) {
          await receipt.body.cancel('provider-read-state-stale');
          throw new ReadDeliveryError('dependency-unavailable', 'provider-read-state-stale', 503, {
            retryable: true,
            fallbackEligible: true,
          });
        }
        if (providerAttemptId !== undefined) {
          await this.#registry?.finishReadAttempt({
            providerAttemptId,
            succeeded: true,
            observedByteLength: receipt.byteLength,
          });
        }
        await this.#registry?.appendReadEvent({
          snapshot: input.snapshot,
          eventType: 'object-read-delivered',
          deliveryState,
          method: input.method,
          rangeRequested: range !== null,
        });
        return Object.freeze({
          status: range === null ? 200 : 206,
          headers: responseHeaders(input.snapshot, range, deliveryState),
          body: receipt.body,
          deliveryState,
        });
      } catch (error) {
        const failure = normalizeExternalError(error);
        lastFailure = failure;
        if (providerAttemptId !== undefined) {
          try {
            await this.#registry?.finishReadAttempt({
              providerAttemptId,
              succeeded: false,
              retryable: failure.retryable,
              diagnostic: failure.toSafeDiagnostic(),
            });
          } catch {
            throw new ReadDeliveryError(
              'dependency-unavailable',
              'read-attempt-recording-unavailable',
              503,
              { retryable: true },
            );
          }
        }
        const canFallback = role === 'hot' && input.snapshot.targets.canonical !== undefined;
        if (!canFallback || (!failure.fallbackEligible && failure.status < 500)) break;
      }
    }

    const failure = lastFailure ?? new ReadDeliveryError(
      'dependency-unavailable',
      'verified-read-copy-unavailable',
      503,
      { retryable: true },
    );
    await this.#registry?.appendReadEvent({
      snapshot: input.snapshot,
      eventType: 'object-read-failed',
      method: input.method,
      rangeRequested: range !== null,
      diagnostic: failure.toSafeDiagnostic(),
    });
    throw failure;
  }
}

export interface ReadGrantDeliveryRuntimeOptions {
  authenticate: (bearerToken: string) => Promise<CallerIdentity | null> | CallerIdentity | null;
  authorizeCaller: (caller: Readonly<CallerIdentity>) => Promise<boolean> | boolean;
  registry: ReadGrantRegistry;
  readGrantTokenService: ReadGrantTokenService;
  providerReader: ProviderObjectReader;
  fallbackRuntime?: HttpStorageRuntime;
  controlPlaneReadiness?: () => Promise<boolean> | boolean;
  dataPlaneReadiness?: () => Promise<boolean> | boolean;
  now?: () => Date;
  createId?: () => string;
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (match?.[1] === undefined || match[1].trim() === '') {
    throw new ReadDeliveryError('unauthenticated', 'authentication-required', 401);
  }
  return match[1].trim();
}

function contractVersion(request: Request): ContractVersion {
  const version = requiredString(
    request.headers.get('x-zs-contract-version'),
    'invalid-contract-version',
    16,
  );
  if (!SUPPORTED_CONTRACT_VERSIONS.includes(version as ContractVersion)) {
    throw new ReadDeliveryError('incompatible-version', 'unsupported-contract-version', 409);
  }
  return version as ContractVersion;
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new ReadDeliveryError('invalid-request', 'json-content-type-required', 415);
  }
  try {
    return await request.json();
  } catch {
    throw new ReadDeliveryError('invalid-request', 'invalid-json', 400);
  }
}

function claimsFromGrant(
  grant: Readonly<ReadDeliverySnapshot['grant']>,
  contract: ContractVersion,
): Readonly<ReadGrantTokenClaims> {
  const claims: ReadGrantTokenClaims = {
    tokenPurpose: READ_GRANT_TOKEN_PURPOSE,
    objectReadGrantId: grant.objectReadGrantId,
    storageObjectId: grant.storageObjectId,
    callerAppId: grant.callerAppId,
    purpose: grant.purpose,
    allowedMethods: grant.allowedMethods,
    allowRange: grant.allowRange,
    contractVersion: contract,
    expiresAt: grant.expiresAt,
  };
  if (grant.callerServiceId !== undefined) claims.callerServiceId = grant.callerServiceId;
  return Object.freeze(claims);
}

export function createReadGrantDeliveryHttpRuntime(
  options: ReadGrantDeliveryRuntimeOptions,
): HttpStorageRuntime {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const coordinator = new ObjectReadDeliveryCoordinator({
    providerReader: options.providerReader,
    registry: options.registry,
  });

  async function authenticateAndAuthorize(request: Request): Promise<Readonly<CallerIdentity>> {
    let caller: CallerIdentity | null;
    try {
      caller = await options.authenticate(bearerToken(request));
    } catch {
      caller = null;
    }
    if (caller === null || typeof caller.appId !== 'string') {
      throw new ReadDeliveryError('unauthenticated', 'authentication-failed', 401);
    }
    const claimedApp = requiredString(request.headers.get('x-zs-caller-app'), 'invalid-caller', 96);
    if (claimedApp !== caller.appId) {
      throw new ReadDeliveryError('unauthorized', 'invalid-caller', 403);
    }
    let authorized = false;
    try {
      authorized = (await options.authorizeCaller(caller)) === true;
    } catch {
      authorized = false;
    }
    if (!authorized) throw new ReadDeliveryError('unauthorized', 'invalid-caller', 403);
    return Object.freeze({
      appId: caller.appId,
      ...(caller.serviceId === undefined ? {} : { serviceId: caller.serviceId }),
    });
  }

  function requestMetadata(request: Request): {
    duplicateProtectionKey: string;
    appCorrelationReference: string;
  } {
    const duplicateProtectionKey = requiredString(
      request.headers.get('idempotency-key'),
      'invalid-duplicate-protection-key',
      128,
    );
    if (!SAFE_ID_PATTERN.test(duplicateProtectionKey)) {
      throw new ReadDeliveryError('invalid-request', 'invalid-duplicate-protection-key', 400);
    }
    const appCorrelationReference = requiredString(
      request.headers.get('x-app-correlation-reference'),
      'invalid-app-correlation-reference',
      128,
    );
    if (!safeCorrelation(appCorrelationReference)) {
      throw new ReadDeliveryError('invalid-request', 'invalid-app-correlation-reference', 400);
    }
    return { duplicateProtectionKey, appCorrelationReference };
  }

  async function issueGrant(request: Request): Promise<Response> {
    const version = contractVersion(request);
    const caller = await authenticateAndAuthorize(request);
    const metadata = requestMetadata(request);
    const payload = normalizeReadGrantRequest(await readJson(request));
    const candidateObjectReadGrantId = createId();
    if (!UUID_PATTERN.test(candidateObjectReadGrantId)) {
      throw new ReadDeliveryError('internal', 'invalid-runtime-id', 500);
    }
    const candidateExpiresAt = new Date(now().getTime() + payload.requestedTtlSeconds * 1000);
    const candidateClaims: ReadGrantTokenClaims = {
      tokenPurpose: READ_GRANT_TOKEN_PURPOSE,
      objectReadGrantId: candidateObjectReadGrantId,
      storageObjectId: payload.storageObjectId,
      callerAppId: caller.appId,
      purpose: payload.purpose,
      allowedMethods: payload.allowedMethods,
      allowRange: payload.allowRange,
      contractVersion: version,
      expiresAt: candidateExpiresAt.toISOString(),
    };
    if (caller.serviceId !== undefined) candidateClaims.callerServiceId = caller.serviceId;
    const candidateToken = await options.readGrantTokenService.issue(Object.freeze(candidateClaims));
    const requestFingerprint = fingerprint({ caller, payload, contractVersion: version });
    const issued = await options.registry.issue({
      request: payload,
      caller,
      contractVersion: version,
      appCorrelationReference: metadata.appCorrelationReference,
      duplicateProtectionKey: metadata.duplicateProtectionKey,
      requestFingerprint,
      candidateObjectReadGrantId,
      candidateTokenDigest: readGrantTokenDigest(candidateToken),
      candidateExpiresAt,
    });
    const token = await options.readGrantTokenService.issue(claimsFromGrant(issued.grant, version));
    if (readGrantTokenDigest(token) !== issued.grant.tokenDigest) {
      throw new ReadDeliveryError('internal', 'read-grant-token-replay-mismatch', 500);
    }
    const result: ReadGrantResult = {
      objectReadGrantId: issued.grant.objectReadGrantId,
      storageObjectId: issued.grant.storageObjectId,
      state: issued.grant.state,
      expiresAt: issued.grant.expiresAt,
      allowedMethods: issued.grant.allowedMethods,
      allowRange: issued.grant.allowRange,
      disposition: issued.grant.disposition,
      duplicateProtection: Object.freeze({
        key: metadata.duplicateProtectionKey,
        replayed: issued.replayed,
      }),
      readGrantToken: token,
    };
    if (issued.grant.fileName !== undefined) result.fileName = issued.grant.fileName;
    return json({
      packageVersion: PACKAGE_VERSION,
      contractVersion: CONTRACT_VERSION,
      appCorrelationReference: metadata.appCorrelationReference,
      result: Object.freeze(result),
    });
  }

  async function revokeGrant(request: Request, objectReadGrantId: string): Promise<Response> {
    if (!UUID_PATTERN.test(objectReadGrantId)) {
      throw new ReadDeliveryError('invalid-request', 'invalid-object-read-grant-id', 400);
    }
    contractVersion(request);
    const caller = await authenticateAndAuthorize(request);
    const metadata = requestMetadata(request);
    const revoked = await options.registry.revoke({
      objectReadGrantId,
      caller,
      appCorrelationReference: metadata.appCorrelationReference,
      duplicateProtectionKey: metadata.duplicateProtectionKey,
      requestFingerprint: fingerprint({ caller, objectReadGrantId }),
    });
    const result: ReadGrantRevocationResult = {
      objectReadGrantId: revoked.grant.objectReadGrantId,
      storageObjectId: revoked.grant.storageObjectId,
      state: revoked.grant.state === 'expired' ? 'expired' : 'revoked',
      expiresAt: revoked.grant.expiresAt,
      duplicateProtection: Object.freeze({
        key: metadata.duplicateProtectionKey,
        replayed: revoked.replayed,
      }),
    };
    if (revoked.grant.revokedAt !== undefined) result.revokedAt = revoked.grant.revokedAt;
    return json({
      packageVersion: PACKAGE_VERSION,
      contractVersion: CONTRACT_VERSION,
      appCorrelationReference: metadata.appCorrelationReference,
      result: Object.freeze(result),
    });
  }

  async function deliverContent(
    request: Request,
    storageObjectId: string,
    method: ObjectReadMethod,
  ): Promise<Response> {
    if (!UUID_PATTERN.test(storageObjectId)) {
      throw new ReadDeliveryError('invalid-request', 'invalid-storage-object-id', 400);
    }
    const version = contractVersion(request);
    const caller = await authenticateAndAuthorize(request);
    const token = requiredString(
      request.headers.get('x-zs-read-grant-token'),
      'invalid-read-grant-token',
      4096,
    );
    const rangeHeader = request.headers.get('range');
    const claims = await options.readGrantTokenService.verify(token, {
      tokenPurpose: READ_GRANT_TOKEN_PURPOSE,
      storageObjectId,
      callerAppId: caller.appId,
      callerServiceId: callerService(caller),
      method,
      contractVersion: version,
      rangeRequested: rangeHeader !== null,
      now: now(),
    });
    const snapshot = await options.registry.authorize({
      claims,
      tokenDigest: readGrantTokenDigest(token),
      method,
      rangeRequested: rangeHeader !== null,
      caller,
      now: now(),
    });
    const result = await coordinator.deliver({
      snapshot,
      method,
      rangeHeader,
      signal: request.signal,
    });
    return new Response(method === 'HEAD' ? null : result.body, {
      status: result.status,
      headers: result.headers,
    });
  }

  async function health(): Promise<Readonly<StorageHealth>> {
    if (options.fallbackRuntime !== undefined) return options.fallbackRuntime.health();
    return Object.freeze({
      serviceId: SERVICE_ID,
      packageVersion: PACKAGE_VERSION,
      contractVersion: CONTRACT_VERSION,
      process: 'healthy',
      checkedAt: now().toISOString(),
    });
  }

  async function readiness(): Promise<Readonly<StorageReadiness>> {
    if (options.fallbackRuntime !== undefined) return options.fallbackRuntime.readiness();
    const controlPlaneReady = (await options.controlPlaneReadiness?.()) !== false;
    const dataPlaneReady = (await options.dataPlaneReadiness?.()) !== false;
    const controlPlane = controlPlaneReady
      ? Object.freeze({ status: 'ready' as const })
      : Object.freeze({ status: 'not-ready' as const, code: 'control-plane-unavailable' });
    const dataPlane = dataPlaneReady
      ? Object.freeze({ status: 'ready' as const })
      : Object.freeze({ status: 'not-ready' as const, code: 'data-plane-unavailable' });
    return Object.freeze({
      serviceId: SERVICE_ID,
      process: 'healthy',
      controlPlane,
      dataPlane,
      status: controlPlaneReady && dataPlaneReady ? 'ready' : 'not-ready',
      checkedAt: now().toISOString(),
    });
  }

  async function handle(request: Request): Promise<Response> {
    const correlation = request.headers.get('x-app-correlation-reference') ?? undefined;
    try {
      const url = new URL(request.url);
      if (
        url.searchParams.has('x-zs-read-grant-token') ||
        url.searchParams.has('readGrantToken') ||
        url.searchParams.has('token')
      ) {
        throw new ReadDeliveryError('invalid-request', 'read-grant-query-token-forbidden', 400);
      }
      if (request.method === 'POST' && url.pathname === '/v1/object-read-grants') {
        return await issueGrant(request);
      }
      if (request.method === 'DELETE') {
        const revokeRoute = /^\/v1\/object-read-grants\/([^/]+)$/.exec(url.pathname);
        if (revokeRoute?.[1] !== undefined) return await revokeGrant(request, revokeRoute[1]);
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        const contentRoute = /^\/v1\/storage-objects\/([^/]+)\/content$/.exec(url.pathname);
        if (contentRoute?.[1] !== undefined) {
          return await deliverContent(request, contentRoute[1], request.method);
        }
      }
      if (options.fallbackRuntime !== undefined) return options.fallbackRuntime.handle(request);
      throw new ReadDeliveryError('invalid-request', 'route-not-found', 404);
    } catch (error) {
      const normalized = normalizeExternalError(error);
      const diagnostic: SafeDiagnostic = {
        category: normalized.category,
        code: normalized.code,
        retryable: normalized.retryable,
      };
      if (correlation !== undefined && safeCorrelation(correlation)) {
        diagnostic.appCorrelationReference = correlation;
      }
      return json(
        { contractVersion: CONTRACT_VERSION, error: { diagnostic: Object.freeze(diagnostic) } },
        normalized.status,
        normalized.responseHeaders,
      );
    }
  }

  return Object.freeze({ handle, health, readiness });
}

export { createDeterministicReadGrantTokenService };
export type { ReadGrantRequest };
