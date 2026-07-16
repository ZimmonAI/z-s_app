import { createHash, randomUUID } from 'node:crypto';
import {
  CONTRACT_VERSION,
  PACKAGE_VERSION,
  SAFE_DIAGNOSTIC_CATEGORIES,
  SERVICE_ID,
  SUPPORTED_CONTRACT_VERSIONS,
  type CallerIdentity,
  type ContractVersion,
  type DependencyReadiness,
  type DuplicateProtectionStore,
  type HttpStorageRuntime,
  type ObjectProtectionStage,
  type ObjectUploadCompletionOperationResult,
  type ObjectUploadCompletionRequestMetadata,
  type ObjectUploadCompletionResult,
  type ObjectWriteIntentCancellationOperationResult,
  type ObjectWriteIntentCancellationResult,
  type ObjectWriteIntentOperationResult,
  type ObjectWriteIntentRequest,
  type ObjectWriteIntentResult,
  type ProviderCapabilityPolicy,
  type ResolvedObjectWritePolicy,
  type SafeDiagnostic,
  type SafeDiagnosticCategory,
  type SafeResolvedStorageProfile,
  type StorageHealth,
  type StorageProfileRequest,
  type StorageReadiness,
  type StorageRuntimeOptions,
} from './runtime-contract.js';
import type { Environment } from './domain.js';
import {
  UPLOAD_COMPLETION_TOKEN_PURPOSE,
  type UploadCompletionTokenClaims,
} from './runtime-upload-token.js';

class StorageRuntimeError extends Error {
  readonly category: SafeDiagnosticCategory;
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly failObjectWriteIntent: boolean;

  constructor(
    category: SafeDiagnosticCategory,
    code: string,
    status: number,
    retryable = false,
    failObjectWriteIntent = false,
  ) {
    super(code);
    this.name = 'StorageRuntimeError';
    this.category = category;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.failObjectWriteIntent = failObjectWriteIntent;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MIME_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
  value: unknown,
  field: string,
  options: { min?: number; max?: number; pattern?: RegExp } = {},
): string {
  const min = options.min ?? 1;
  const max = options.max ?? 256;
  if (typeof value !== 'string') {
    throw new StorageRuntimeError('invalid-request', `invalid-${field}`, 400);
  }
  const normalized = value.trim();
  if (
    normalized.length < min ||
    normalized.length > max ||
    (options.pattern !== undefined && !options.pattern.test(normalized))
  ) {
    throw new StorageRuntimeError('invalid-request', `invalid-${field}`, 400);
  }
  return normalized;
}

function requireInteger(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new StorageRuntimeError('invalid-request', `invalid-${field}`, 400);
  }
  return value as number;
}

function requireUuid(value: unknown, field: string): string {
  return requireString(value, field, { max: 36, pattern: UUID_PATTERN });
}

function requireEnvironment(value: unknown): Environment {
  const environment = requireString(value, 'environment', {
    max: 16,
    pattern: /^(dev|stg|prod)$/,
  });
  return environment as Environment;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
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

function normalizeCallerIdentity(value: unknown): Readonly<CallerIdentity> {
  if (!isRecord(value)) {
    throw new StorageRuntimeError('unauthenticated', 'authentication-required', 401);
  }
  const appId = requireString(value.appId, 'caller-app', {
    max: 96,
    pattern: /^[a-z0-9][a-z0-9_-]*$/,
  });
  if (value.serviceId === undefined || value.serviceId === null) {
    return Object.freeze({ appId });
  }
  const serviceId = requireString(value.serviceId, 'caller-service', {
    max: 96,
    pattern: /^[a-z0-9][a-z0-9_-]*$/,
  });
  return Object.freeze({ appId, serviceId });
}

function callerScope(caller: Readonly<CallerIdentity>, operation: string): string {
  return `${caller.appId}:${caller.serviceId ?? ''}:${operation}`;
}

function parseStorageProfileRequest(value: unknown): Readonly<StorageProfileRequest> {
  if (!isRecord(value)) {
    throw new StorageRuntimeError('invalid-request', 'invalid-storage-profile', 400);
  }
  return Object.freeze({
    profileId: requireString(value.profileId, 'profile-id', {
      max: 128,
      pattern: /^[a-z0-9][a-z0-9_-]*$/,
    }),
    profileVersion: requireInteger(value.profileVersion, 'profile-version', 1),
    environment: requireEnvironment(value.environment),
  });
}

function parseWriteIntentRequest(value: unknown): Readonly<ObjectWriteIntentRequest> {
  if (!isRecord(value)) {
    throw new StorageRuntimeError('invalid-request', 'invalid-object-write-intent', 400);
  }
  const requestedProtectionStage =
    value.requestedProtectionStage === undefined || value.requestedProtectionStage === null
      ? undefined
      : requireString(value.requestedProtectionStage, 'object-protection-stage', {
          max: 64,
          pattern: /^[a-z0-9][a-z0-9-]*$/,
        });
  const result: ObjectWriteIntentRequest = {
    storageProfile: parseStorageProfileRequest(value.storageProfile),
    mediaType: requireString(value.mediaType, 'media-type', {
      max: 160,
      pattern: MIME_PATTERN,
    }),
    byteLength: requireInteger(value.byteLength, 'byte-length', 1),
    checksumSha256: requireString(value.checksumSha256, 'checksum-sha256', {
      min: 64,
      max: 64,
      pattern: SHA256_PATTERN,
    }),
    sourceReference: requireString(value.sourceReference, 'source-reference', { max: 256 }),
  };
  if (requestedProtectionStage !== undefined) {
    result.requestedProtectionStage = requestedProtectionStage;
  }
  return Object.freeze(result);
}

function sanitizeCapabilityPolicy(value: unknown): ProviderCapabilityPolicy {
  if (!isRecord(value)) {
    throw new StorageRuntimeError('dependency-unavailable', 'profile-resolution-failed', 503, true);
  }
  if (value.checksumVerification !== 'required') {
    throw new StorageRuntimeError('dependency-unavailable', 'profile-resolution-failed', 503, true);
  }
  if (value.sizeVerification !== 'required-when-supported') {
    throw new StorageRuntimeError('dependency-unavailable', 'profile-resolution-failed', 503, true);
  }
  if (value.headContentLength !== 'required' && value.headContentLength !== 'optional-with-checksum') {
    throw new StorageRuntimeError('dependency-unavailable', 'profile-resolution-failed', 503, true);
  }
  if (
    value.rangeRead !== 'required' &&
    value.rangeRead !== 'optional' &&
    value.rangeRead !== 'not-applicable'
  ) {
    throw new StorageRuntimeError('dependency-unavailable', 'profile-resolution-failed', 503, true);
  }
  return Object.freeze({
    checksumVerification: 'required',
    sizeVerification: 'required-when-supported',
    headContentLength: value.headContentLength,
    rangeRead: value.rangeRead,
  });
}

function sanitizeWritePolicy(value: unknown): Readonly<ResolvedObjectWritePolicy> {
  if (!isRecord(value)) {
    throw new StorageRuntimeError('dependency-unavailable', 'write-policy-unavailable', 503, true);
  }
  if (value.uploadMode !== 'server-streamed-single-object') {
    throw new StorageRuntimeError('not-ready', 'unsupported-upload-mode', 409);
  }
  const maxByteLength = requireInteger(value.maxByteLength, 'max-byte-length', 1);
  if (value.intentTtlSeconds !== 900) {
    throw new StorageRuntimeError('dependency-unavailable', 'invalid-intent-ttl', 503);
  }
  if (!Array.isArray(value.allowedMediaTypes) || value.allowedMediaTypes.length === 0) {
    throw new StorageRuntimeError('dependency-unavailable', 'invalid-media-type-policy', 503);
  }
  const allowedMediaTypes = value.allowedMediaTypes.map((entry) =>
    requireString(entry, 'allowed-media-type', { max: 160, pattern: MIME_PATTERN }),
  );
  if (new Set(allowedMediaTypes).size !== allowedMediaTypes.length) {
    throw new StorageRuntimeError('dependency-unavailable', 'invalid-media-type-policy', 503);
  }
  return Object.freeze({
    uploadMode: 'server-streamed-single-object',
    allowedMediaTypes: Object.freeze(allowedMediaTypes),
    maxByteLength,
    intentTtlSeconds: 900,
  });
}

function sanitizeResolvedProfile(value: unknown): Readonly<SafeResolvedStorageProfile> {
  if (!isRecord(value)) {
    throw new StorageRuntimeError('dependency-unavailable', 'profile-resolution-failed', 503, true);
  }
  const capabilities = isRecord(value.capabilities) ? value.capabilities : {};
  const protectionStages: ObjectProtectionStage[] = Array.isArray(value.protectionStages)
    ? value.protectionStages
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(entry))
        .slice(0, 16)
    : [];
  const result: SafeResolvedStorageProfile = {
    profileId: requireString(value.profileId, 'resolved-profile-id', { max: 128 }),
    profileVersion: requireInteger(value.profileVersion, 'resolved-profile-version', 1),
    environment: requireEnvironment(value.environment),
    active: value.active === true,
    ready: value.ready === true,
    safeFingerprint: requireString(value.safeFingerprint, 'profile-fingerprint', {
      max: 128,
      pattern: SAFE_IDENTIFIER_PATTERN,
    }),
    capabilityPolicy: sanitizeCapabilityPolicy(value.capabilityPolicy),
    capabilities: Object.freeze({
      objectWriteIntent: capabilities.objectWriteIntent === true,
      objectReadGrant: capabilities.objectReadGrant === true,
      objectDeleteRequest: capabilities.objectDeleteRequest === true,
      objectRepairOperation: capabilities.objectRepairOperation === true,
    }),
    protectionStages: Object.freeze(protectionStages),
  };
  if (value.writePolicy !== undefined) result.writePolicy = sanitizeWritePolicy(value.writePolicy);
  return Object.freeze(result);
}

function externalRuntimeError(
  error: unknown,
  fallback: Readonly<{
    category: SafeDiagnosticCategory;
    code: string;
    status: number;
    retryable?: boolean;
  }>,
): StorageRuntimeError {
  if (error instanceof StorageRuntimeError) return error;
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
      return new StorageRuntimeError(
        category as SafeDiagnosticCategory,
        code,
        status as number,
        error.retryable === true,
        error.failObjectWriteIntent === true,
      );
    }
  }
  return new StorageRuntimeError(
    fallback.category,
    fallback.code,
    fallback.status,
    fallback.retryable ?? false,
  );
}

interface WriteIntentCoreResult {
  writeIntentId: string;
  storageObjectId: string;
  state: 'accepted' | 'pending' | 'rejected';
  expiresAt: string;
  objectProtectionStage: ObjectProtectionStage;
  uploadCompletionToken?: string;
}

function sanitizeWriteIntentCore(value: unknown): Readonly<WriteIntentCoreResult> {
  if (!isRecord(value)) {
    throw new StorageRuntimeError('internal', 'invalid-runtime-result', 500);
  }
  const state = requireString(value.state, 'write-intent-state', { max: 48 });
  if (state !== 'accepted' && state !== 'pending' && state !== 'rejected') {
    throw new StorageRuntimeError('internal', 'invalid-runtime-result', 500);
  }
  const expiresAt = requireString(value.expiresAt, 'expires-at', { max: 64 });
  if (new Date(expiresAt).toISOString() !== expiresAt) {
    throw new StorageRuntimeError('internal', 'invalid-runtime-result', 500);
  }
  const result: WriteIntentCoreResult = {
    writeIntentId: requireUuid(value.writeIntentId, 'write-intent-id'),
    storageObjectId: requireUuid(value.storageObjectId, 'storage-object-id'),
    state,
    expiresAt,
    objectProtectionStage: requireString(value.objectProtectionStage, 'object-protection-stage', {
      max: 64,
      pattern: /^[a-z0-9][a-z0-9-]*$/,
    }),
  };
  if (value.uploadCompletionToken !== undefined) {
    result.uploadCompletionToken = requireString(
      value.uploadCompletionToken,
      'upload-completion-token',
      { max: 4096 },
    );
  }
  return Object.freeze(result);
}

function sanitizeUploadCompletionCore(
  value: unknown,
): Readonly<ObjectUploadCompletionOperationResult> {
  if (!isRecord(value) || value.state !== 'recorded') {
    throw new StorageRuntimeError('internal', 'invalid-runtime-result', 500);
  }
  if (!isRecord(value.integrityVerification)) {
    throw new StorageRuntimeError('internal', 'invalid-runtime-result', 500);
  }
  const verification = value.integrityVerification;
  if (
    verification.verified !== true ||
    verification.checksumVerified !== true ||
    verification.sizeVerified !== true ||
    verification.sizeVerificationDisposition !== 'matched'
  ) {
    throw new StorageRuntimeError('internal', 'invalid-runtime-result', 500);
  }
  if (value.objectProtectionStage !== 'upload-completion-recorded') {
    throw new StorageRuntimeError('internal', 'invalid-runtime-result', 500);
  }
  return Object.freeze({
    storageObjectId: requireUuid(value.storageObjectId, 'storage-object-id'),
    writeIntentId: requireUuid(value.writeIntentId, 'write-intent-id'),
    state: 'recorded',
    checksumSha256: requireString(value.checksumSha256, 'checksum-sha256', {
      min: 64,
      max: 64,
      pattern: SHA256_PATTERN,
    }),
    byteLength: requireInteger(value.byteLength, 'byte-length', 1),
    integrityVerification: Object.freeze({
      verified: true,
      checksumVerified: true,
      sizeVerified: true,
      sizeVerificationDisposition: 'matched',
    }),
    objectProtectionStage: 'upload-completion-recorded',
  });
}

function sanitizeCancellationCore(
  value: unknown,
): Readonly<ObjectWriteIntentCancellationOperationResult> {
  if (!isRecord(value) || value.state !== 'cancelled') {
    throw new StorageRuntimeError('internal', 'invalid-runtime-result', 500);
  }
  return Object.freeze({
    storageObjectId: requireUuid(value.storageObjectId, 'storage-object-id'),
    writeIntentId: requireUuid(value.writeIntentId, 'write-intent-id'),
    state: 'cancelled',
  });
}

function normalizeReadiness(value: unknown): DependencyReadiness {
  if (value === true || value === 'ready') {
    return Object.freeze({ status: 'ready' });
  }
  if (isRecord(value) && value.status === 'ready') {
    return Object.freeze({ status: 'ready' });
  }
  const code =
    isRecord(value) &&
    typeof value.code === 'string' &&
    /^[a-z0-9][a-z0-9-]{0,95}$/.test(value.code)
      ? value.code
      : 'dependency-not-ready';
  return Object.freeze({ status: 'not-ready', code });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function safeCorrelationReference(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) return undefined;
  return normalized;
}

export function createSafeDiagnostic(
  category: SafeDiagnosticCategory | string,
  code: string,
  retryable = false,
  correlationReference?: string,
): Readonly<SafeDiagnostic> {
  const safeCategory: SafeDiagnosticCategory = SAFE_DIAGNOSTIC_CATEGORIES.includes(
    category as SafeDiagnosticCategory,
  )
    ? (category as SafeDiagnosticCategory)
    : 'internal';
  const safeCode =
    safeCategory !== 'internal' && /^[a-z0-9][a-z0-9-]{0,95}$/.test(code)
      ? code
      : 'internal-error';
  const reference = safeCorrelationReference(correlationReference);
  const diagnostic: SafeDiagnostic = {
    category: safeCategory,
    code: safeCode,
    retryable: safeCategory === 'internal' ? false : Boolean(retryable),
  };
  if (reference !== undefined) {
    diagnostic.appCorrelationReference = reference;
  }
  return Object.freeze(diagnostic);
}

export function serializeSafeDiagnostic(
  error: unknown,
  correlationReference?: string,
): Readonly<SafeDiagnostic> {
  const normalized = externalRuntimeError(error, {
    category: 'internal',
    code: 'internal-error',
    status: 500,
  });
  return createSafeDiagnostic(
    normalized.category,
    normalized.code,
    normalized.retryable,
    correlationReference,
  );
}

export function createInMemoryDuplicateProtectionStore(): DuplicateProtectionStore {
  const entries = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
  return Object.freeze({
    async execute<T>(input: {
      scope: string;
      key: string;
      fingerprint: string;
      operation: () => Promise<T>;
    }): Promise<Readonly<{ replayed: boolean; value: T }>> {
      const mapKey = `${input.scope}:${input.key}`;
      const existing = entries.get(mapKey);
      if (existing !== undefined) {
        if (existing.fingerprint !== input.fingerprint) {
          throw new StorageRuntimeError('duplicate-conflict', 'idempotency-key-reused', 409);
        }
        return Object.freeze({ replayed: true, value: (await existing.promise) as T });
      }

      const operationPromise = Promise.resolve().then(input.operation);
      entries.set(mapKey, { fingerprint: input.fingerprint, promise: operationPromise });
      try {
        return Object.freeze({ replayed: false, value: await operationPromise });
      } catch (error) {
        const current = entries.get(mapKey);
        if (current?.promise === operationPromise) entries.delete(mapKey);
        throw error;
      }
    },
    clear(): void {
      entries.clear();
    },
  });
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new StorageRuntimeError('invalid-request', 'json-content-type-required', 415);
  }
  try {
    return await request.json();
  } catch {
    throw new StorageRuntimeError('invalid-request', 'invalid-json', 400);
  }
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (match?.[1] === undefined || match[1].trim() === '') {
    throw new StorageRuntimeError('unauthenticated', 'authentication-required', 401);
  }
  return match[1].trim();
}

function requiredHeader(request: Request, name: string, code: string, max = 256): string {
  return requireString(request.headers.get(name), code, { max });
}

function duplicateProtectionKey(request: Request): string {
  return requireString(request.headers.get('idempotency-key'), 'duplicate-protection-key', {
    max: 128,
    pattern: SAFE_IDENTIFIER_PATTERN,
  });
}

function correlationReference(request: Request): string {
  const value = requiredHeader(
    request,
    'x-app-correlation-reference',
    'app-correlation-reference',
    128,
  );
  if (safeCorrelationReference(value) === undefined) {
    throw new StorageRuntimeError('invalid-request', 'invalid-app-correlation-reference', 400);
  }
  return value;
}

function contractVersion(request: Request): ContractVersion {
  const version = requiredHeader(request, 'x-zs-contract-version', 'contract-version', 16);
  if (!SUPPORTED_CONTRACT_VERSIONS.includes(version as ContractVersion)) {
    throw new StorageRuntimeError(
      'incompatible-version',
      'unsupported-contract-version',
      409,
    );
  }
  return version as ContractVersion;
}

function parseContentLength(request: Request): number {
  const value = requiredHeader(request, 'content-length', 'content-length', 32);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new StorageRuntimeError('invalid-request', 'invalid-content-length', 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new StorageRuntimeError('invalid-request', 'invalid-content-length', 400);
  }
  return parsed;
}

export function createHttpStorageRuntime(options: StorageRuntimeOptions): HttpStorageRuntime {
  const requiredFunctions: ReadonlyArray<keyof StorageRuntimeOptions> = [
    'authenticate',
    'authorizeCaller',
    'resolveStorageProfile',
    'createObjectWriteIntent',
    'controlPlaneReadiness',
    'dataPlaneReadiness',
  ];
  for (const name of requiredFunctions) {
    if (typeof options[name] !== 'function') {
      throw new TypeError(`${name} must be a function.`);
    }
  }

  const duplicateStore =
    options.duplicateProtectionStore ?? createInMemoryDuplicateProtectionStore();
  if (typeof duplicateStore.execute !== 'function') {
    throw new TypeError('duplicateProtectionStore.execute must be a function.');
  }
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;

  async function health(): Promise<Readonly<StorageHealth>> {
    return Object.freeze({
      serviceId: SERVICE_ID,
      packageVersion: PACKAGE_VERSION,
      contractVersion: CONTRACT_VERSION,
      process: 'healthy',
      checkedAt: now().toISOString(),
    });
  }

  async function checkReadiness(
    check: StorageRuntimeOptions['controlPlaneReadiness'],
    unavailableCode: string,
  ): Promise<DependencyReadiness> {
    try {
      return normalizeReadiness(await check());
    } catch {
      return normalizeReadiness({ status: 'not-ready', code: unavailableCode });
    }
  }

  async function readiness(): Promise<Readonly<StorageReadiness>> {
    const [controlPlane, dataPlane] = await Promise.all([
      checkReadiness(options.controlPlaneReadiness, 'control-plane-unavailable'),
      checkReadiness(options.dataPlaneReadiness, 'data-plane-unavailable'),
    ]);
    return Object.freeze({
      serviceId: SERVICE_ID,
      process: 'healthy',
      controlPlane,
      dataPlane,
      status:
        controlPlane.status === 'ready' && dataPlane.status === 'ready'
          ? 'ready'
          : 'not-ready',
      checkedAt: now().toISOString(),
    });
  }

  async function authenticateAndAuthorize(request: Request): Promise<Readonly<CallerIdentity>> {
    const token = bearerToken(request);
    let caller: Readonly<CallerIdentity>;
    try {
      caller = normalizeCallerIdentity(await options.authenticate(token));
    } catch (error) {
      if (error instanceof StorageRuntimeError) throw error;
      throw new StorageRuntimeError('unauthenticated', 'authentication-failed', 401);
    }

    const claimedApp = requiredHeader(request, 'x-zs-caller-app', 'caller-app', 96);
    if (claimedApp !== caller.appId) {
      throw new StorageRuntimeError('unauthorized', 'invalid-caller', 403);
    }
    let authorized = false;
    try {
      authorized = (await options.authorizeCaller(caller)) === true;
    } catch {
      authorized = false;
    }
    if (!authorized) {
      throw new StorageRuntimeError('unauthorized', 'invalid-caller', 403);
    }
    return caller;
  }

  async function issueUploadCompletionToken(input: {
    result: Readonly<WriteIntentCoreResult>;
    caller: Readonly<CallerIdentity>;
    contractVersion: ContractVersion;
  }): Promise<string> {
    if (options.uploadCompletionTokenService !== undefined) {
      const claims: UploadCompletionTokenClaims = {
        purpose: UPLOAD_COMPLETION_TOKEN_PURPOSE,
        objectWriteIntentId: input.result.writeIntentId,
        storageObjectId: input.result.storageObjectId,
        callerAppId: input.caller.appId,
        contractVersion: input.contractVersion,
        expiresAt: input.result.expiresAt,
      };
      if (input.caller.serviceId !== undefined) claims.callerServiceId = input.caller.serviceId;
      try {
        return requireString(
          await options.uploadCompletionTokenService.issue(Object.freeze(claims)),
          'upload-completion-token',
          { max: 4096 },
        );
      } catch (error) {
        throw externalRuntimeError(error, {
          category: 'dependency-unavailable',
          code: 'upload-completion-token-unavailable',
          status: 503,
          retryable: true,
        });
      }
    }
    if (input.result.uploadCompletionToken !== undefined) return input.result.uploadCompletionToken;
    throw new StorageRuntimeError(
      'dependency-unavailable',
      'upload-completion-token-unavailable',
      503,
      true,
    );
  }

  async function handleWriteIntent(request: Request): Promise<Response> {
    const version = contractVersion(request);
    const caller = await authenticateAndAuthorize(request);
    const key = duplicateProtectionKey(request);
    const appCorrelationReference = correlationReference(request);
    const payload = parseWriteIntentRequest(await readJsonBody(request));
    const resolutionContext = Object.freeze({ caller, appCorrelationReference });

    let resolvedProfile: Readonly<SafeResolvedStorageProfile>;
    let writeAuthority: Awaited<ReturnType<NonNullable<StorageRuntimeOptions['resolveObjectWriteAuthority']>>> | undefined;
    try {
      const [profileValue, authorityValue] = await Promise.all([
        options.resolveStorageProfile(payload.storageProfile, resolutionContext),
        options.resolveObjectWriteAuthority?.(payload.storageProfile, resolutionContext),
      ]);
      resolvedProfile = sanitizeResolvedProfile(profileValue);
      writeAuthority = authorityValue;
    } catch (error) {
      throw externalRuntimeError(error, {
        category: 'dependency-unavailable',
        code: 'profile-resolution-failed',
        status: 503,
        retryable: true,
      });
    }

    if (
      resolvedProfile.profileId !== payload.storageProfile.profileId ||
      resolvedProfile.profileVersion !== payload.storageProfile.profileVersion ||
      resolvedProfile.environment !== payload.storageProfile.environment
    ) {
      throw new StorageRuntimeError('duplicate-conflict', 'storage-profile-version-mismatch', 409);
    }
    if (resolvedProfile.active !== true) {
      throw new StorageRuntimeError('not-ready', 'storage-profile-inactive', 503);
    }
    if (!resolvedProfile.ready || !resolvedProfile.capabilities.objectWriteIntent) {
      throw new StorageRuntimeError('not-ready', 'storage-profile-not-ready', 503, true);
    }

    const authorityRecord = isRecord(writeAuthority) ? writeAuthority : undefined;
    if (
      authorityRecord !== undefined &&
      (authorityRecord.storageProfileVersion !== payload.storageProfile.profileVersion ||
        authorityRecord.storageProfileFingerprint !== resolvedProfile.safeFingerprint)
    ) {
      throw new StorageRuntimeError('duplicate-conflict', 'storage-profile-authority-mismatch', 409);
    }
    const writePolicy = sanitizeWritePolicy(
      authorityRecord?.writePolicy ?? resolvedProfile.writePolicy,
    );
    if (!writePolicy.allowedMediaTypes.includes(payload.mediaType)) {
      throw new StorageRuntimeError('invalid-request', 'media-type-not-allowed', 415);
    }
    if (payload.byteLength > writePolicy.maxByteLength) {
      throw new StorageRuntimeError('invalid-request', 'byte-length-exceeds-profile-limit', 413);
    }
    if (
      payload.requestedProtectionStage !== undefined &&
      payload.requestedProtectionStage !== 'write-intent-created'
    ) {
      throw new StorageRuntimeError('invalid-request', 'invalid-object-protection-stage', 400);
    }

    const scope = callerScope(caller, 'object-write-intent');
    const requestFingerprint = fingerprint({
      caller,
      payload,
      profile: {
        profileId: resolvedProfile.profileId,
        profileVersion: resolvedProfile.profileVersion,
        environment: resolvedProfile.environment,
        safeFingerprint: resolvedProfile.safeFingerprint,
        writePolicy,
      },
    });
    const duplicateResult = await duplicateStore.execute({
      scope,
      key,
      fingerprint: requestFingerprint,
      operation: async () => {
        try {
          const operationResult: ObjectWriteIntentOperationResult =
            await options.createObjectWriteIntent({
              request: payload,
              resolvedProfile,
              ...(writeAuthority === undefined ? {} : { writeAuthority }),
              context: Object.freeze({
                caller,
                contractVersion: version,
                appCorrelationReference,
                duplicateProtectionKey: key,
                requestId: createId(),
              }),
            });
          const sanitized = sanitizeWriteIntentCore(operationResult);
          if (options.uploadCompletionTokenService !== undefined) {
            const { uploadCompletionToken: _token, ...tokenless } = sanitized;
            return Object.freeze(tokenless);
          }
          return sanitized;
        } catch (error) {
          throw externalRuntimeError(error, {
            category: 'dependency-unavailable',
            code: 'write-intent-unavailable',
            status: 503,
            retryable: true,
          });
        }
      },
    });

    const core = sanitizeWriteIntentCore(duplicateResult.value);
    const uploadCompletionToken = await issueUploadCompletionToken({
      result: core,
      caller,
      contractVersion: version,
    });
    const result: ObjectWriteIntentResult = Object.freeze({
      writeIntentId: core.writeIntentId,
      storageObjectId: core.storageObjectId,
      state: core.state,
      uploadCompletionToken,
      expiresAt: core.expiresAt,
      objectProtectionStage: core.objectProtectionStage,
      duplicateProtection: Object.freeze({ key, replayed: duplicateResult.replayed }),
    });
    return json({
      packageVersion: PACKAGE_VERSION,
      contractVersion: CONTRACT_VERSION,
      appCorrelationReference,
      result,
    });
  }

  async function handleUploadContent(
    request: Request,
    objectWriteIntentId: string,
  ): Promise<Response> {
    requireUuid(objectWriteIntentId, 'object-write-intent-id');
    const version = contractVersion(request);
    const caller = await authenticateAndAuthorize(request);
    const key = duplicateProtectionKey(request);
    const appCorrelationReference = correlationReference(request);
    if (
      options.uploadCompletionTokenService === undefined ||
      options.completeObjectUpload === undefined
    ) {
      throw new StorageRuntimeError('not-ready', 'object-upload-completion-not-configured', 503, true);
    }
    const token = requiredHeader(
      request,
      'x-zs-upload-completion-token',
      'upload-completion-token',
      4096,
    );
    let tokenClaims: Readonly<UploadCompletionTokenClaims>;
    try {
      tokenClaims = await options.uploadCompletionTokenService.verify(token, {
        purpose: UPLOAD_COMPLETION_TOKEN_PURPOSE,
        objectWriteIntentId,
        callerAppId: caller.appId,
        callerServiceId: caller.serviceId ?? '',
        contractVersion: version,
        now: now(),
      });
    } catch (error) {
      throw externalRuntimeError(error, {
        category: 'unauthenticated',
        code: 'invalid-upload-completion-token',
        status: 401,
      });
    }

    const metadata: ObjectUploadCompletionRequestMetadata = Object.freeze({
      objectWriteIntentId,
      mediaType: requiredHeader(request, 'content-type', 'content-type', 160),
      byteLength: parseContentLength(request),
      checksumSha256: requireString(
        request.headers.get('x-content-sha256'),
        'content-sha256',
        { min: 64, max: 64, pattern: SHA256_PATTERN },
      ),
    });
    if (!MIME_PATTERN.test(metadata.mediaType)) {
      throw new StorageRuntimeError('invalid-request', 'invalid-content-type', 400);
    }
    const context = Object.freeze({
      caller,
      contractVersion: version,
      appCorrelationReference,
      duplicateProtectionKey: key,
      requestId: createId(),
    });
    const requestFingerprint = fingerprint({
      caller,
      objectWriteIntentId,
      mediaType: metadata.mediaType,
      byteLength: metadata.byteLength,
      checksumSha256: metadata.checksumSha256,
    });

    let duplicateResult: Readonly<{
      replayed: boolean;
      value: ObjectUploadCompletionOperationResult;
    }>;
    try {
      duplicateResult = await duplicateStore.execute({
        scope: callerScope(caller, 'object-upload-completion'),
        key,
        fingerprint: requestFingerprint,
        operation: async () =>
          sanitizeUploadCompletionCore(
            await options.completeObjectUpload?.({
              metadata,
              body: request.body,
              tokenClaims,
              context,
            }),
          ),
      });
    } catch (error) {
      const normalized = externalRuntimeError(error, {
        category: 'dependency-unavailable',
        code: 'object-upload-completion-unavailable',
        status: 503,
        retryable: true,
      });
      if (normalized.failObjectWriteIntent && options.handleObjectUploadFailure !== undefined) {
        try {
          await options.handleObjectUploadFailure({
            objectWriteIntentId,
            context,
            safeCode: normalized.code,
          });
        } catch {
          throw new StorageRuntimeError(
            'dependency-unavailable',
            'object-upload-failure-recording-unavailable',
            503,
            true,
          );
        }
      }
      throw normalized;
    }

    const core = sanitizeUploadCompletionCore(duplicateResult.value);
    const result: ObjectUploadCompletionResult = Object.freeze({
      ...core,
      duplicateProtection: Object.freeze({ key, replayed: duplicateResult.replayed }),
    });
    return json({
      packageVersion: PACKAGE_VERSION,
      contractVersion: CONTRACT_VERSION,
      appCorrelationReference,
      result,
    });
  }

  async function handleCancelIntent(
    request: Request,
    objectWriteIntentId: string,
  ): Promise<Response> {
    requireUuid(objectWriteIntentId, 'object-write-intent-id');
    const version = contractVersion(request);
    const caller = await authenticateAndAuthorize(request);
    const key = duplicateProtectionKey(request);
    const appCorrelationReference = correlationReference(request);
    if (options.cancelObjectWriteIntent === undefined) {
      throw new StorageRuntimeError('not-ready', 'object-write-intent-cancel-not-configured', 503, true);
    }
    const context = Object.freeze({
      caller,
      contractVersion: version,
      appCorrelationReference,
      duplicateProtectionKey: key,
      requestId: createId(),
    });
    const duplicateResult = await duplicateStore.execute({
      scope: callerScope(caller, 'object-write-intent-cancel'),
      key,
      fingerprint: fingerprint({ caller, objectWriteIntentId }),
      operation: async () => {
        try {
          return sanitizeCancellationCore(
            await options.cancelObjectWriteIntent?.({ objectWriteIntentId, context }),
          );
        } catch (error) {
          throw externalRuntimeError(error, {
            category: 'dependency-unavailable',
            code: 'object-write-intent-cancel-unavailable',
            status: 503,
            retryable: true,
          });
        }
      },
    });
    const core = sanitizeCancellationCore(duplicateResult.value);
    const result: ObjectWriteIntentCancellationResult = Object.freeze({
      ...core,
      duplicateProtection: Object.freeze({ key, replayed: duplicateResult.replayed }),
    });
    return json({
      packageVersion: PACKAGE_VERSION,
      contractVersion: CONTRACT_VERSION,
      appCorrelationReference,
      result,
    });
  }

  async function handle(request: Request): Promise<Response> {
    const correlation = request.headers.get('x-app-correlation-reference') ?? undefined;
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return json(await health());
      }
      if (request.method === 'GET' && url.pathname === '/readyz') {
        const result = await readiness();
        return json(result, result.status === 'ready' ? 200 : 503);
      }
      if (request.method === 'POST' && url.pathname === '/v1/object-write-intents') {
        return await handleWriteIntent(request);
      }
      if (request.method === 'PUT') {
        const contentRoute = /^\/v1\/object-write-intents\/([^/]+)\/content$/.exec(url.pathname);
        if (contentRoute?.[1] !== undefined) {
          return await handleUploadContent(request, contentRoute[1]);
        }
      }
      if (request.method === 'DELETE') {
        const cancelRoute = /^\/v1\/object-write-intents\/([^/]+)$/.exec(url.pathname);
        if (cancelRoute?.[1] !== undefined) {
          return await handleCancelIntent(request, cancelRoute[1]);
        }
      }
      throw new StorageRuntimeError('invalid-request', 'route-not-found', 404);
    } catch (error) {
      const normalized = externalRuntimeError(error, {
        category: 'internal',
        code: 'internal-error',
        status: 500,
      });
      const diagnostic = serializeSafeDiagnostic(normalized, correlation);
      return json({ contractVersion: CONTRACT_VERSION, error: { diagnostic } }, normalized.status);
    }
  }

  return Object.freeze({ handle, health, readiness });
}

export {
  ObjectIngestRuntimeError,
  createObjectIngestRuntime,
  type ObjectIngestAdapter,
  type ObjectIngestInput,
  type ObjectIngestReceipt,
  type ObjectIngestRegistry,
  type ObjectIngestRuntimeOptions,
  type ResolvedObjectWriteAuthority,
} from './runtime-ingest.js';
export {
  UPLOAD_COMPLETION_TOKEN_PURPOSE,
  UploadCompletionTokenError,
  createDeterministicUploadCompletionTokenService,
  type UploadCompletionTokenClaims,
  type UploadCompletionTokenExpectation,
  type UploadCompletionTokenService,
} from './runtime-upload-token.js';

export {
  DualProviderObjectIngestAdapter,
  TargetedProviderRetryCoordinator,
  type DualProviderAttemptReservation,
  type DualProviderObjectIngestAdapterOptions,
  type DualProviderStorageTruth,
  type DualProviderWriteOutcome,
  type DualProviderWriteRegistry,
  type ProviderWriteTargetResolver,
  type TargetedProviderRetryReservation,
  type VerifiedProviderWriteSource,
} from './runtime-dual-provider.js';
export {
  BoundedMediaVerifier,
  MediaVerificationError,
  type BoundedMediaVerifierOptions,
  type MediaVerificationAdapter,
  type MediaVerificationInput,
  type MediaVerificationSource,
} from './runtime-media-verification.js';
export {
  ProviderExecutionError,
  S3CompatibleProviderObjectWriter,
  type ProviderCleanupResult,
  type ProviderCredentialResolver,
  type ProviderObjectWriter,
  type ProviderObservedMetadata,
  type ProviderWriteReceipt,
  type ResolvedProviderWriteTarget,
  type ResolvedS3CredentialBinding,
  type S3CompatibleProviderObjectWriterOptions,
} from './runtime-s3-provider.js';
