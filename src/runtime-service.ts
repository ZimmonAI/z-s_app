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
  type ObjectWriteIntentRequest,
  type ObjectWriteIntentResult,
  type ProviderCapabilityPolicy,
  type SafeDiagnostic,
  type SafeDiagnosticCategory,
  type SafeResolvedStorageProfile,
  type StorageHealth,
  type StorageProfileRequest,
  type StorageReadiness,
  type StorageRuntimeOptions,
} from './runtime-contract.js';
import type { Environment } from './domain.js';

class StorageRuntimeError extends Error {
  readonly category: SafeDiagnosticCategory;
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    category: SafeDiagnosticCategory,
    code: string,
    status: number,
    retryable = false,
  ) {
    super(code);
    this.name = 'StorageRuntimeError';
    this.category = category;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

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
      pattern: /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i,
    }),
    byteLength: requireInteger(value.byteLength, 'byte-length', 1),
    checksumSha256: requireString(value.checksumSha256, 'checksum-sha256', {
      min: 64,
      max: 64,
      pattern: /^[a-f0-9]{64}$/,
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

  return Object.freeze({
    profileId: requireString(value.profileId, 'resolved-profile-id', { max: 128 }),
    profileVersion: requireInteger(value.profileVersion, 'resolved-profile-version', 1),
    environment: requireEnvironment(value.environment),
    ready: value.ready === true,
    safeFingerprint: requireString(value.safeFingerprint, 'profile-fingerprint', {
      max: 128,
      pattern: /^[a-zA-Z0-9._:-]+$/,
    }),
    capabilityPolicy: sanitizeCapabilityPolicy(value.capabilityPolicy),
    capabilities: Object.freeze({
      objectWriteIntent: capabilities.objectWriteIntent === true,
      objectReadGrant: capabilities.objectReadGrant === true,
      objectDeleteRequest: capabilities.objectDeleteRequest === true,
      objectRepairOperation: capabilities.objectRepairOperation === true,
    }),
    protectionStages: Object.freeze(protectionStages),
  });
}

function sanitizeWriteIntentResult(
  value: unknown,
  duplicateProtectionKey: string,
  replayed: boolean,
): Readonly<ObjectWriteIntentResult> {
  if (!isRecord(value)) {
    throw new StorageRuntimeError('internal', 'invalid-runtime-result', 500);
  }
  const state = requireString(value.state, 'write-intent-state', { max: 48 });
  if (state !== 'accepted' && state !== 'pending' && state !== 'rejected') {
    throw new StorageRuntimeError('internal', 'invalid-runtime-result', 500);
  }
  return Object.freeze({
    writeIntentId: requireString(value.writeIntentId, 'write-intent-id', { max: 128 }),
    storageObjectId: requireString(value.storageObjectId, 'storage-object-id', { max: 128 }),
    state,
    uploadCompletionToken: requireString(value.uploadCompletionToken, 'upload-completion-token', {
      max: 512,
    }),
    expiresAt: requireString(value.expiresAt, 'expires-at', { max: 64 }),
    objectProtectionStage: requireString(value.objectProtectionStage, 'object-protection-stage', {
      max: 64,
    }),
    duplicateProtection: Object.freeze({
      key: duplicateProtectionKey,
      replayed,
    }),
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
  if (error instanceof StorageRuntimeError) {
    return createSafeDiagnostic(
      error.category,
      error.code,
      error.retryable,
      correlationReference,
    );
  }
  return createSafeDiagnostic('internal', 'internal-error', false, correlationReference);
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

  const duplicateProtectionStore =
    options.duplicateProtectionStore ?? createInMemoryDuplicateProtectionStore();
  if (typeof duplicateProtectionStore.execute !== 'function') {
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

  async function handleWriteIntent(request: Request): Promise<Response> {
    const version = requiredHeader(request, 'x-zs-contract-version', 'contract-version', 16);
    if (!SUPPORTED_CONTRACT_VERSIONS.includes(version as ContractVersion)) {
      throw new StorageRuntimeError(
        'incompatible-version',
        'unsupported-contract-version',
        409,
      );
    }
    const contractVersion = version as ContractVersion;
    const caller = await authenticateAndAuthorize(request);
    const duplicateProtectionKey = requiredHeader(
      request,
      'idempotency-key',
      'duplicate-protection-key',
      128,
    );
    const appCorrelationReference = requiredHeader(
      request,
      'x-app-correlation-reference',
      'app-correlation-reference',
      128,
    );
    if (safeCorrelationReference(appCorrelationReference) === undefined) {
      throw new StorageRuntimeError(
        'invalid-request',
        'invalid-app-correlation-reference',
        400,
      );
    }

    const payload = parseWriteIntentRequest(await readJsonBody(request));
    let resolvedProfile: Readonly<SafeResolvedStorageProfile>;
    try {
      resolvedProfile = sanitizeResolvedProfile(
        await options.resolveStorageProfile(payload.storageProfile, {
          caller,
          appCorrelationReference,
        }),
      );
    } catch (error) {
      if (error instanceof StorageRuntimeError) throw error;
      throw new StorageRuntimeError(
        'dependency-unavailable',
        'profile-resolution-failed',
        503,
        true,
      );
    }
    if (!resolvedProfile.ready || !resolvedProfile.capabilities.objectWriteIntent) {
      throw new StorageRuntimeError('not-ready', 'storage-profile-not-ready', 503, true);
    }

    const scope = `${caller.appId}:object-write-intent`;
    const requestFingerprint = fingerprint({ caller: caller.appId, payload });
    const duplicateResult = await duplicateProtectionStore.execute({
      scope,
      key: duplicateProtectionKey,
      fingerprint: requestFingerprint,
      operation: async () => {
        let operationResult: Omit<ObjectWriteIntentResult, 'duplicateProtection'>;
        try {
          operationResult = await options.createObjectWriteIntent({
            request: payload,
            resolvedProfile,
            context: Object.freeze({
              caller,
              contractVersion,
              appCorrelationReference,
              duplicateProtectionKey,
              requestId: createId(),
            }),
          });
        } catch {
          throw new StorageRuntimeError(
            'dependency-unavailable',
            'write-intent-unavailable',
            503,
            true,
          );
        }
        return sanitizeWriteIntentResult(operationResult, duplicateProtectionKey, false);
      },
    });

    const result = duplicateResult.replayed
      ? sanitizeWriteIntentResult(duplicateResult.value, duplicateProtectionKey, true)
      : duplicateResult.value;
    return json({
      contractVersion: CONTRACT_VERSION,
      appCorrelationReference,
      result,
    });
  }

  async function handle(request: Request): Promise<Response> {
    const correlationReference = request.headers.get('x-app-correlation-reference') ?? undefined;
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
      throw new StorageRuntimeError('invalid-request', 'route-not-found', 404);
    } catch (error) {
      const diagnostic = serializeSafeDiagnostic(error, correlationReference);
      const status = error instanceof StorageRuntimeError ? error.status : 500;
      return json({ contractVersion: CONTRACT_VERSION, error: { diagnostic } }, status);
    }
  }

  return Object.freeze({ handle, health, readiness });
}
