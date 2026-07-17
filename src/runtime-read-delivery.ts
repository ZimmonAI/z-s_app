import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import {
  CONTRACT_VERSION,
  PACKAGE_VERSION,
  SERVICE_ID,
  type CallerIdentity,
  type ContractVersion,
  type DependencyReadiness,
  type HttpStorageRuntime,
  type SafeDiagnostic,
  type StorageHealth,
  type StorageReadiness,
} from './runtime-contract.js';
import {
  ObjectReadGrantError,
  READ_GRANT_TOKEN_PURPOSE,
  createObjectReadGrantClaims,
  parseObjectReadGrantRequest,
  type ObjectReadGrantClaims,
  type ObjectReadGrantRegistry,
  type ObjectReadGrantResult,
  type ObjectReadGrantSnapshot,
  type ObjectReadGrantTokenService,
  type ObjectReadMethod,
  type ObjectReadObjectSnapshot,
  type ObjectReadTargetSnapshot,
} from './runtime-read-grant.js';

export type ObjectReadDeliveryState = 'hot' | 'canonical-fallback';

export class ProviderReadError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly fallbackEligible: boolean;

  constructor(code: string, retryable: boolean, fallbackEligible: boolean) {
    super(code);
    this.name = 'ProviderReadError';
    this.code = code;
    this.retryable = retryable;
    this.fallbackEligible = fallbackEligible;
  }
}

export interface ObjectReadByteRange {
  start: number;
  end: number;
  length: number;
  contentRange: string;
  providerRange: string;
}

export interface ProviderObjectReadInput {
  target: Readonly<ObjectReadTargetSnapshot>;
  method: ObjectReadMethod;
  range?: Readonly<ObjectReadByteRange>;
  expectedByteLength: number;
  signal: AbortSignal;
}

export interface ProviderObjectReadReceipt {
  body?: ReadableStream<Uint8Array>;
  observedByteLength?: number;
  destroy(): void;
}

export interface ProviderObjectReader {
  read(input: Readonly<ProviderObjectReadInput>): Promise<Readonly<ProviderObjectReadReceipt>>;
}

export interface ResolvedS3ReadTarget {
  endpoint: string;
  region: string;
  bucket: string;
  objectKey: string;
  forcePathStyle: boolean;
  credentials: Readonly<{
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  }>;
}

export interface S3ReadTargetResolver {
  resolve(
    target: Readonly<ObjectReadTargetSnapshot>,
  ): Promise<Readonly<ResolvedS3ReadTarget>> | Readonly<ResolvedS3ReadTarget>;
}

export interface S3CompatibleProviderObjectReaderOptions {
  resolveTarget: S3ReadTargetResolver['resolve'];
  createClient?: (configuration: ConstructorParameters<typeof S3Client>[0]) => S3Client;
}

function providerError(error: unknown): ProviderReadError {
  if (error instanceof ProviderReadError) return error;
  const record =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined;
  const metadata =
    record !== undefined && typeof record.$metadata === 'object' && record.$metadata !== null
      ? (record.$metadata as Record<string, unknown>)
      : undefined;
  const status = typeof metadata?.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined;
  const name = typeof record?.name === 'string' ? record.name : '';
  const code = typeof record?.Code === 'string' ? record.Code : '';
  if (status === 404 || /NoSuchKey|NotFound/i.test(`${name}:${code}`)) {
    return new ProviderReadError('provider-object-missing', false, true);
  }
  if (
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500) ||
    /Timeout|Throttl|ServiceUnavailable|ECONNRESET|EAI_AGAIN/i.test(`${name}:${code}`)
  ) {
    return new ProviderReadError('provider-read-unavailable', true, true);
  }
  return new ProviderReadError('provider-read-failed', false, false);
}

function toWebStream(body: unknown): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body as ReadableStream<Uint8Array>;
  if (
    typeof body === 'object' &&
    body !== null &&
    'transformToWebStream' in body &&
    typeof (body as { transformToWebStream?: unknown }).transformToWebStream === 'function'
  ) {
    return (body as { transformToWebStream(): ReadableStream<Uint8Array> }).transformToWebStream();
  }
  if (body instanceof Readable) {
    return Readable.toWeb(body) as ReadableStream<Uint8Array>;
  }
  if (
    typeof body === 'object' &&
    body !== null &&
    Symbol.asyncIterator in body
  ) {
    return Readable.toWeb(Readable.from(body as AsyncIterable<Uint8Array>)) as ReadableStream<Uint8Array>;
  }
  throw new ProviderReadError('provider-body-unavailable', false, false);
}

export class S3CompatibleProviderObjectReader implements ProviderObjectReader {
  readonly #resolveTarget: S3ReadTargetResolver['resolve'];
  readonly #createClient: (configuration: ConstructorParameters<typeof S3Client>[0]) => S3Client;

  constructor(options: Readonly<S3CompatibleProviderObjectReaderOptions>) {
    if (typeof options.resolveTarget !== 'function') {
      throw new TypeError('resolveTarget must be a function.');
    }
    this.#resolveTarget = options.resolveTarget;
    this.#createClient = options.createClient ?? ((configuration) => new S3Client(configuration ?? {}));
  }

  async read(input: Readonly<ProviderObjectReadInput>): Promise<Readonly<ProviderObjectReadReceipt>> {
    let resolved: Readonly<ResolvedS3ReadTarget>;
    try {
      resolved = await this.#resolveTarget(input.target);
    } catch {
      throw new ProviderReadError('provider-target-unavailable', true, true);
    }
    const client = this.#createClient({
      endpoint: resolved.endpoint,
      region: resolved.region,
      forcePathStyle: resolved.forcePathStyle,
      credentials: resolved.credentials,
    });
    let destroyed = false;
    const destroy = (): void => {
      if (destroyed) return;
      destroyed = true;
      client.destroy();
    };
    try {
      if (input.method === 'HEAD') {
        const output: HeadObjectCommandOutput = await client.send(
          new HeadObjectCommand({ Bucket: resolved.bucket, Key: resolved.objectKey }),
          { abortSignal: input.signal },
        );
        const observed = output.ContentLength;
        if (observed !== undefined && observed !== input.expectedByteLength) {
          throw new ProviderReadError('provider-object-stale', false, true);
        }
        destroy();
        return Object.freeze({
          ...(observed === undefined ? {} : { observedByteLength: observed }),
          destroy,
        });
      }
      const output: GetObjectCommandOutput = await client.send(
        new GetObjectCommand({
          Bucket: resolved.bucket,
          Key: resolved.objectKey,
          ...(input.range === undefined ? {} : { Range: input.range.providerRange }),
        }),
        { abortSignal: input.signal },
      );
      const expectedLength = input.range?.length ?? input.expectedByteLength;
      if (output.ContentLength !== undefined && output.ContentLength !== expectedLength) {
        throw new ProviderReadError('provider-object-stale', false, true);
      }
      return Object.freeze({
        body: toWebStream(output.Body),
        ...(output.ContentLength === undefined ? {} : { observedByteLength: output.ContentLength }),
        destroy,
      });
    } catch (error) {
      destroy();
      throw providerError(error);
    }
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
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

function requireHeader(request: Request, name: string, code: string, max: number): string {
  const value = request.headers.get(name);
  if (value === null) throw new ObjectReadGrantError('invalid-request', code, 400);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new ObjectReadGrantError('invalid-request', code, 400);
  }
  return normalized;
}

function requireUuid(value: string, code: string): string {
  if (!UUID_PATTERN.test(value)) throw new ObjectReadGrantError('invalid-request', code, 400);
  return value;
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (match?.[1] === undefined || match[1].trim() === '') {
    throw new ObjectReadGrantError('unauthenticated', 'authentication-required', 401);
  }
  return match[1].trim();
}

function contractVersion(request: Request): ContractVersion {
  const value = requireHeader(request, 'x-zs-contract-version', 'contract-version', 16);
  if (value !== CONTRACT_VERSION) {
    throw new ObjectReadGrantError('incompatible-version', 'unsupported-contract-version', 409);
  }
  return value;
}

function correlationReference(request: Request): string {
  const value = requireHeader(
    request,
    'x-app-correlation-reference',
    'app-correlation-reference',
    128,
  );
  if (!SAFE_CORRELATION_PATTERN.test(value)) {
    throw new ObjectReadGrantError('invalid-request', 'invalid-app-correlation-reference', 400);
  }
  return value;
}

function duplicateProtectionKey(request: Request): string {
  const value = requireHeader(request, 'idempotency-key', 'duplicate-protection-key', 128);
  if (!SAFE_IDEMPOTENCY_PATTERN.test(value)) {
    throw new ObjectReadGrantError('invalid-request', 'invalid-duplicate-protection-key', 400);
  }
  return value;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new ObjectReadGrantError('invalid-request', 'json-content-type-required', 415);
  }
  try {
    return await request.json();
  } catch {
    throw new ObjectReadGrantError('invalid-request', 'invalid-json', 400);
  }
}

function json(body: unknown, status = 200, headers?: Readonly<Record<string, string>>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function diagnostic(error: ObjectReadGrantError, correlation?: string): Readonly<SafeDiagnostic> {
  return Object.freeze({
    category: error.category,
    code: /^[a-z0-9][a-z0-9-]{0,95}$/.test(error.code) ? error.code : 'internal-error',
    retryable: error.retryable,
    ...(correlation !== undefined && SAFE_CORRELATION_PATTERN.test(correlation)
      ? { appCorrelationReference: correlation }
      : {}),
  });
}

function normalizeError(error: unknown): ObjectReadGrantError {
  if (error instanceof ObjectReadGrantError) return error;
  if (error instanceof ProviderReadError) {
    return new ObjectReadGrantError(
      'dependency-unavailable',
      error.code,
      error.retryable ? 503 : 502,
      error.retryable,
    );
  }
  return new ObjectReadGrantError('internal', 'internal-error', 500);
}

export function parseSingleByteRange(
  header: string | null,
  totalSize: number,
  allowRange: boolean,
  method: ObjectReadMethod,
): Readonly<ObjectReadByteRange> | undefined {
  if (header === null) return undefined;
  if (!allowRange) {
    throw new ObjectReadGrantError('unauthorized', 'read-grant-range-not-allowed', 403);
  }
  const unsatisfied = Object.freeze({ 'content-range': `bytes */${totalSize}` });
  if (method !== 'GET' || totalSize <= 0 || !/^bytes=/i.test(header) || header.includes(',')) {
    throw new ObjectReadGrantError('invalid-request', 'invalid-byte-range', 416, false, unsatisfied);
  }
  const value = header.slice(header.indexOf('=') + 1).trim();
  const match = /^(\d*)-(\d*)$/.exec(value);
  if (match === null || (match[1] === '' && match[2] === '')) {
    throw new ObjectReadGrantError('invalid-request', 'invalid-byte-range', 416, false, unsatisfied);
  }
  let start: number;
  let end: number;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      throw new ObjectReadGrantError('invalid-request', 'invalid-byte-range', 416, false, unsatisfied);
    }
    const length = Math.min(suffix, totalSize);
    start = totalSize - length;
    end = totalSize - 1;
  } else {
    start = Number(match[1]);
    if (!Number.isSafeInteger(start) || start < 0 || start >= totalSize) {
      throw new ObjectReadGrantError('invalid-request', 'unsatisfiable-byte-range', 416, false, unsatisfied);
    }
    if (match[2] === '') end = totalSize - 1;
    else {
      end = Number(match[2]);
      if (!Number.isSafeInteger(end) || end < start) {
        throw new ObjectReadGrantError('invalid-request', 'invalid-byte-range', 416, false, unsatisfied);
      }
      end = Math.min(end, totalSize - 1);
    }
  }
  const length = end - start + 1;
  return Object.freeze({
    start,
    end,
    length,
    contentRange: `bytes ${start}-${end}/${totalSize}`,
    providerRange: `bytes=${start}-${end}`,
  });
}

function assertGrantMatchesClaims(
  grant: Readonly<ObjectReadGrantSnapshot>,
  claims: Readonly<ObjectReadGrantClaims>,
  tokenDigest: string,
): void {
  if (
    grant.tokenPurpose !== READ_GRANT_TOKEN_PURPOSE ||
    grant.tokenDigest !== tokenDigest ||
    grant.objectReadGrantId !== claims.objectReadGrantId ||
    grant.storageObjectId !== claims.storageObjectId ||
    grant.callerAppId !== claims.callerAppId ||
    (grant.callerServiceId ?? '') !== (claims.callerServiceId ?? '') ||
    grant.purpose !== claims.grantPurpose ||
    grant.allowRange !== claims.allowRange ||
    grant.disposition !== claims.disposition ||
    (grant.fileName ?? '') !== (claims.fileName ?? '') ||
    grant.expiresAt !== claims.expiresAt ||
    grant.allowedMethods.length !== claims.allowedMethods.length ||
    grant.allowedMethods.some((method, index) => claims.allowedMethods[index] !== method)
  ) {
    throw new ObjectReadGrantError('unauthorized', 'read-grant-scope-mismatch', 403);
  }
}

function assertReadableObject(object: Readonly<ObjectReadObjectSnapshot>): void {
  if (object.registryState === 'delete_pending' || object.registryState === 'deleted') {
    throw new ObjectReadGrantError('not-ready', 'storage-object-delete-state', 409);
  }
  if (object.registryState === 'reserved') {
    throw new ObjectReadGrantError('not-ready', 'storage-object-unverified', 409);
  }
  if (object.registryState !== 'active' && object.registryState !== 'degraded') {
    throw new ObjectReadGrantError('not-ready', 'storage-object-state-conflict', 409);
  }
  if (object.targets.hot === undefined && object.targets.canonical === undefined) {
    throw new ObjectReadGrantError('not-ready', 'storage-object-no-verified-copy', 409);
  }
}

function contentDisposition(disposition: 'inline' | 'attachment', fileName?: string): string {
  if (fileName === undefined) return disposition;
  return `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function responseHeaders(input: {
  object: Readonly<ObjectReadObjectSnapshot>;
  grant: Readonly<ObjectReadGrantSnapshot>;
  range?: Readonly<ObjectReadByteRange>;
  state: ObjectReadDeliveryState;
}): Headers {
  const length = input.range?.length ?? input.object.verifiedByteLength;
  const headers = new Headers({
    'content-type': input.object.verifiedContentType,
    'content-length': String(length),
    'accept-ranges': 'bytes',
    etag: `"sha256-${input.object.verifiedChecksumSha256}"`,
    'content-disposition': contentDisposition(input.grant.disposition, input.grant.fileName),
    'cache-control': 'private, no-store, max-age=0, no-transform',
    'x-content-type-options': 'nosniff',
    'x-zs-delivery-state': input.state,
  });
  if (input.range !== undefined) headers.set('content-range', input.range.contentRange);
  return headers;
}

async function authenticateAndAuthorize(
  request: Request,
  options: Readonly<Pick<ReadDeliveryRuntimeOptions, 'authenticate' | 'authorizeCaller'>>,
): Promise<Readonly<CallerIdentity>> {
  let caller: CallerIdentity | null;
  try {
    caller = await options.authenticate(bearerToken(request));
  } catch {
    caller = null;
  }
  if (caller === null || typeof caller.appId !== 'string') {
    throw new ObjectReadGrantError('unauthenticated', 'authentication-failed', 401);
  }
  const claimedApp = requireHeader(request, 'x-zs-caller-app', 'caller-app', 96);
  if (caller.appId !== claimedApp) {
    throw new ObjectReadGrantError('unauthorized', 'invalid-caller', 403);
  }
  let authorized = false;
  try {
    authorized = (await options.authorizeCaller(Object.freeze({ ...caller }))) === true;
  } catch {
    authorized = false;
  }
  if (!authorized) throw new ObjectReadGrantError('unauthorized', 'invalid-caller', 403);
  return Object.freeze({ ...caller });
}

function wrapBody(input: {
  body: ReadableStream<Uint8Array>;
  receipt: Readonly<ProviderObjectReadReceipt>;
  finalize: (outcome: 'succeeded' | 'failed' | 'cancelled') => Promise<void>;
}): ReadableStream<Uint8Array> {
  const reader = input.body.getReader();
  let finalized = false;
  const finalize = async (outcome: 'succeeded' | 'failed' | 'cancelled'): Promise<void> => {
    if (finalized) return;
    finalized = true;
    input.receipt.destroy();
    try {
      await input.finalize(outcome);
    } catch {
      // Delivery has already begun. Do not expose registry/provider failures through the stream body.
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          await finalize('succeeded');
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch {
        await finalize('failed');
        controller.error(new Error('object-read-stream-failed'));
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await finalize('cancelled');
      }
    },
  });
}

export interface ReadDeliveryRuntimeOptions {
  authenticate: (bearerToken: string) => Promise<CallerIdentity | null> | CallerIdentity | null;
  authorizeCaller: (caller: Readonly<CallerIdentity>) => Promise<boolean> | boolean;
  registry: ObjectReadGrantRegistry;
  tokenService: ObjectReadGrantTokenService;
  providerReader: ProviderObjectReader;
  delegate?: HttpStorageRuntime;
  now?: () => Date;
  createId?: () => string;
}

export function createReadDeliveryHttpStorageRuntime(
  options: Readonly<ReadDeliveryRuntimeOptions>,
): HttpStorageRuntime {
  if (typeof options.authenticate !== 'function' || typeof options.authorizeCaller !== 'function') {
    throw new TypeError('authenticate and authorizeCaller must be functions.');
  }
  if (typeof options.registry?.issue !== 'function' || typeof options.providerReader?.read !== 'function') {
    throw new TypeError('registry and providerReader are required.');
  }
  if (typeof options.tokenService?.issue !== 'function' || typeof options.tokenService.verify !== 'function') {
    throw new TypeError('tokenService is required.');
  }
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;

  async function issue(request: Request): Promise<Response> {
    const version = contractVersion(request);
    const caller = await authenticateAndAuthorize(request, options);
    const key = duplicateProtectionKey(request);
    const appCorrelationReference = correlationReference(request);
    const payload = parseObjectReadGrantRequest(await readJsonBody(request));
    const proposedGrantId = createId();
    const proposedExpiresAt = new Date(now().getTime() + payload.requestedTtlSeconds * 1000);
    const proposedClaims: ObjectReadGrantClaims = {
      purpose: READ_GRANT_TOKEN_PURPOSE,
      objectReadGrantId: proposedGrantId,
      storageObjectId: payload.storageObjectId,
      callerAppId: caller.appId,
      grantPurpose: payload.purpose,
      allowedMethods: payload.allowedMethods,
      allowRange: payload.allowRange,
      disposition: payload.disposition,
      contractVersion: version,
      expiresAt: proposedExpiresAt.toISOString(),
    };
    if (caller.serviceId !== undefined) proposedClaims.callerServiceId = caller.serviceId;
    if (payload.fileName !== undefined) proposedClaims.fileName = payload.fileName;
    const proposedToken = options.tokenService.issue(Object.freeze(proposedClaims));
    const requestFingerprint = fingerprint({ caller, version, payload });
    const issued = await options.registry.issue({
      caller,
      contractVersion: version,
      appCorrelationReference,
      duplicateProtectionKey: key,
      requestFingerprint,
      request: payload,
      proposedGrantId,
      proposedExpiresAt,
      proposedTokenDigest: options.tokenService.digest(proposedToken),
    });
    const token = options.tokenService.issue(
      createObjectReadGrantClaims({ grant: issued.grant, contractVersion: version }),
    );
    if (options.tokenService.digest(token) !== issued.grant.tokenDigest) {
      throw new ObjectReadGrantError('internal', 'read-grant-token-key-mismatch', 500);
    }
    const result: ObjectReadGrantResult = {
      objectReadGrantId: issued.grant.objectReadGrantId,
      storageObjectId: issued.grant.storageObjectId,
      state: issued.grant.state,
      expiresAt: issued.grant.expiresAt,
      allowedMethods: issued.grant.allowedMethods,
      allowRange: issued.grant.allowRange,
      disposition: issued.grant.disposition,
      duplicateProtection: Object.freeze({ key, replayed: issued.replayed }),
      readGrantToken: token,
    };
    if (issued.grant.fileName !== undefined) result.fileName = issued.grant.fileName;
    return json({
      packageVersion: PACKAGE_VERSION,
      contractVersion: CONTRACT_VERSION,
      appCorrelationReference,
      result: Object.freeze(result),
    }, 201);
  }

  async function revoke(request: Request, objectReadGrantId: string): Promise<Response> {
    requireUuid(objectReadGrantId, 'invalid-object-read-grant-id');
    const version = contractVersion(request);
    const caller = await authenticateAndAuthorize(request, options);
    const key = duplicateProtectionKey(request);
    const appCorrelationReference = correlationReference(request);
    const revoked = await options.registry.revoke({
      caller,
      contractVersion: version,
      appCorrelationReference,
      duplicateProtectionKey: key,
      requestFingerprint: fingerprint({ caller, version, objectReadGrantId }),
      objectReadGrantId,
    });
    return json({
      packageVersion: PACKAGE_VERSION,
      contractVersion: CONTRACT_VERSION,
      appCorrelationReference,
      result: Object.freeze({
        objectReadGrantId: revoked.grant.objectReadGrantId,
        storageObjectId: revoked.grant.storageObjectId,
        state: revoked.grant.state,
        revokedAt: revoked.grant.revokedAt,
        duplicateProtection: Object.freeze({ key, replayed: revoked.replayed }),
      }),
    });
  }

  async function finishAttempt(input: {
    providerAttemptId: string;
    grant: Readonly<ObjectReadGrantSnapshot>;
    requestId: string;
    state: ObjectReadDeliveryState;
    outcome: 'succeeded' | 'failed' | 'cancelled';
    object: Readonly<ObjectReadObjectSnapshot>;
  }): Promise<void> {
    const succeeded = input.outcome === 'succeeded';
    const failureDiagnostic: Readonly<SafeDiagnostic> | undefined = succeeded
      ? undefined
      : Object.freeze({
          category: 'dependency-unavailable',
          code: input.outcome === 'cancelled' ? 'read-delivery-cancelled' : 'read-stream-failed',
          retryable: input.outcome !== 'cancelled',
        });
    await options.registry.completeReadAttempt({
      providerAttemptId: input.providerAttemptId,
      succeeded,
      ...(failureDiagnostic === undefined
        ? {}
        : { retryable: failureDiagnostic.retryable, safeDiagnostic: failureDiagnostic }),
      ...(succeeded
        ? {
            observedChecksumSha256: input.object.verifiedChecksumSha256,
            observedByteLength: input.object.verifiedByteLength,
          }
        : {}),
    });
    await options.registry.appendReadEvent({
      dedupeKey: `read-delivery:${input.requestId}:${input.outcome}`,
      eventType: succeeded ? 'object-read.delivered' : 'object-read.failed',
      grant: input.grant,
      occurredAt: now(),
      payload: Object.freeze({
        objectReadGrantId: input.grant.objectReadGrantId,
        deliveryState: input.state,
        outcome: input.outcome,
      }),
      ...(failureDiagnostic === undefined ? {} : { diagnostic: failureDiagnostic }),
    });
  }

  async function deliver(
    request: Request,
    storageObjectId: string,
    method: ObjectReadMethod,
  ): Promise<Response> {
    requireUuid(storageObjectId, 'invalid-storage-object-id');
    const version = contractVersion(request);
    const caller = await authenticateAndAuthorize(request, options);
    correlationReference(request);
    const rangeHeader = request.headers.get('range');
    const token = requireHeader(request, 'x-zs-read-grant-token', 'read-grant-token', 4096);
    const claims = options.tokenService.verify(token, {
      storageObjectId,
      callerAppId: caller.appId,
      callerServiceId: caller.serviceId ?? '',
      method,
      rangeRequested: rangeHeader !== null,
      contractVersion: version,
      now: now(),
    });
    const grant = await options.registry.getForDelivery({
      objectReadGrantId: claims.objectReadGrantId,
      storageObjectId,
      caller,
      now: now(),
    });
    if (grant === null) throw new ObjectReadGrantError('unauthorized', 'read-grant-not-found', 403);
    assertGrantMatchesClaims(grant, claims, options.tokenService.digest(token));
    if (grant.state === 'expired') {
      throw new ObjectReadGrantError('unauthenticated', 'read-grant-expired', 401);
    }
    if (grant.state === 'revoked') {
      throw new ObjectReadGrantError('unauthorized', 'read-grant-revoked', 403);
    }
    if (!grant.allowedMethods.includes(method)) {
      throw new ObjectReadGrantError('unauthorized', 'read-grant-method-not-allowed', 403);
    }
    const object = await options.registry.resolveObjectForRead({
      storageObjectId,
      managedAppId: grant.managedAppId,
    });
    if (object === null) throw new ObjectReadGrantError('not-ready', 'storage-object-not-found', 404);
    assertReadableObject(object);
    const range = parseSingleByteRange(rangeHeader, object.verifiedByteLength, grant.allowRange, method);
    const requestId = createId();

    const candidates: Array<Readonly<{ target: ObjectReadTargetSnapshot; state: ObjectReadDeliveryState }>> = [];
    if (object.targets.hot !== undefined) candidates.push({ target: object.targets.hot, state: 'hot' });
    if (object.targets.canonical !== undefined) {
      candidates.push({ target: object.targets.canonical, state: 'canonical-fallback' });
    }
    let lastError: ObjectReadGrantError | undefined;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (candidate === undefined) continue;
      const providerAttemptId = await options.registry.beginReadAttempt({
        grant,
        target: candidate.target,
        requestId,
        method,
        rangeRequested: range !== undefined,
        attemptNumber: index + 1,
        expectedChecksumSha256: object.verifiedChecksumSha256,
        expectedByteLength: object.verifiedByteLength,
      });
      let receipt: Readonly<ProviderObjectReadReceipt>;
      try {
        receipt = await options.providerReader.read({
          target: candidate.target,
          method,
          ...(range === undefined ? {} : { range }),
          expectedByteLength: object.verifiedByteLength,
          signal: request.signal,
        });
      } catch (error) {
        const providerFailure = providerError(error);
        const safe = Object.freeze({
          category: 'dependency-unavailable' as const,
          code: providerFailure.code,
          retryable: providerFailure.retryable,
        });
        await options.registry.completeReadAttempt({
          providerAttemptId,
          succeeded: false,
          retryable: providerFailure.retryable,
          safeDiagnostic: safe,
        });
        const isHot = candidate.target.providerRole === 'hot';
        if (isHot && providerFailure.fallbackEligible && object.targets.canonical !== undefined) {
          lastError = new ObjectReadGrantError(
            'dependency-unavailable',
            providerFailure.code,
            503,
            providerFailure.retryable,
          );
          continue;
        }
        throw new ObjectReadGrantError(
          'dependency-unavailable',
          providerFailure.code,
          providerFailure.retryable ? 503 : 502,
          providerFailure.retryable,
        );
      }
      const headers = responseHeaders({
        object,
        grant,
        ...(range === undefined ? {} : { range }),
        state: candidate.state,
      });
      if (method === 'HEAD') {
        receipt.destroy();
        await finishAttempt({
          providerAttemptId,
          grant,
          requestId,
          state: candidate.state,
          outcome: 'succeeded',
          object,
        });
        return new Response(null, { status: range === undefined ? 200 : 206, headers });
      }
      if (receipt.body === undefined) {
        receipt.destroy();
        await options.registry.completeReadAttempt({
          providerAttemptId,
          succeeded: false,
          safeDiagnostic: Object.freeze({
            category: 'dependency-unavailable',
            code: 'provider-body-unavailable',
            retryable: false,
          }),
        });
        throw new ObjectReadGrantError('dependency-unavailable', 'provider-body-unavailable', 502);
      }
      const body = wrapBody({
        body: receipt.body,
        receipt,
        finalize: async (outcome) =>
          finishAttempt({
            providerAttemptId,
            grant,
            requestId,
            state: candidate.state,
            outcome,
            object,
          }),
      });
      return new Response(body, { status: range === undefined ? 200 : 206, headers });
    }
    throw lastError ?? new ObjectReadGrantError('not-ready', 'storage-object-no-verified-copy', 409);
  }

  async function health(): Promise<Readonly<StorageHealth>> {
    if (options.delegate !== undefined) return options.delegate.health();
    return Object.freeze({
      serviceId: SERVICE_ID,
      packageVersion: PACKAGE_VERSION,
      contractVersion: CONTRACT_VERSION,
      process: 'healthy',
      checkedAt: now().toISOString(),
    });
  }

  async function readiness(): Promise<Readonly<StorageReadiness>> {
    if (options.delegate !== undefined) return options.delegate.readiness();
    const ready: DependencyReadiness = Object.freeze({ status: 'ready' });
    return Object.freeze({
      serviceId: SERVICE_ID,
      process: 'healthy',
      controlPlane: ready,
      dataPlane: ready,
      status: 'ready',
      checkedAt: now().toISOString(),
    });
  }

  async function handle(request: Request): Promise<Response> {
    const correlation = request.headers.get('x-app-correlation-reference') ?? undefined;
    try {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/v1/object-read-grants') {
        return await issue(request);
      }
      if (request.method === 'DELETE') {
        const match = /^\/v1\/object-read-grants\/([^/]+)$/.exec(url.pathname);
        if (match?.[1] !== undefined) return await revoke(request, match[1]);
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        const match = /^\/v1\/storage-objects\/([^/]+)\/content$/.exec(url.pathname);
        if (match?.[1] !== undefined) {
          return await deliver(request, match[1], request.method as ObjectReadMethod);
        }
      }
      if (options.delegate !== undefined) return options.delegate.handle(request);
      throw new ObjectReadGrantError('invalid-request', 'route-not-found', 404);
    } catch (error) {
      const normalized = normalizeError(error);
      return json(
        {
          contractVersion: CONTRACT_VERSION,
          error: { diagnostic: diagnostic(normalized, correlation) },
        },
        normalized.status,
        normalized.responseHeaders,
      );
    }
  }

  return Object.freeze({ handle, health, readiness });
}
