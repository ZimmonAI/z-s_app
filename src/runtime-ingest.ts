import { createHash, randomUUID } from 'node:crypto';
import type {
  CallerIdentity,
  ContractVersion,
  DuplicateProtectionStore,
  HttpStorageRuntime,
  ObjectUploadCompletionOperationResult,
  ObjectUploadCompletionRequestMetadata,
  ObjectWriteIntentCancellationOperationResult,
  ObjectWriteIntentOperationResult,
  ObjectWriteIntentRequest,
  ResolvedObjectWritePolicy,
  RuntimeRequestContext,
  SafeDiagnosticCategory,
  SafeResolvedStorageProfile,
  StorageProfileRequest,
  StorageRuntimeOptions,
} from './runtime-contract.js';
import { createHttpStorageRuntime } from './runtime-service.js';
import type {
  CreateObjectWriteIntentInput,
  ObjectWriteIntentExecutionContext,
  ObjectWriteIntentState,
  ProviderCopyExecutionContext,
  ProviderRole,
} from './runtime-storage-registry-types.js';
import type {
  UploadCompletionTokenClaims,
  UploadCompletionTokenService,
} from './runtime-upload-token.js';

export interface ResolvedObjectWriteAuthority {
  managedAppId: string;
  callerServiceId?: string;
  storageProfileId: string;
  storageProfileVersion: number;
  storageProfileFingerprint: string;
  storagePrefixClassId: string;
  normalizedPrefixPattern: string;
  hotProviderBindingId: string;
  canonicalProviderBindingId: string;
  writePolicy: Readonly<ResolvedObjectWritePolicy>;
}

export interface ObjectIngestInput {
  objectWriteIntentId: string;
  storageObjectId: string;
  mediaType: string;
  declaredByteLength: number;
  declaredChecksumSha256: string;
  body: AsyncIterable<Uint8Array>;
  internalLocators: Readonly<{ hot: string; canonical: string }>;
  intentRowVersion?: number;
  objectRowVersion?: number;
  providerCopies?: Readonly<Record<ProviderRole, Readonly<ProviderCopyExecutionContext>>>;
}

export interface ObjectIngestReceipt {
  state: 'accepted';
  checksumSha256: string;
  byteLength: number;
  completionResult?: Readonly<ObjectUploadCompletionOperationResult>;
}

export interface ObjectIngestAdapter {
  ingest(input: Readonly<ObjectIngestInput>): Promise<Readonly<ObjectIngestReceipt>>;
  hasPartialState(input: {
    objectWriteIntentId: string;
    storageObjectId: string;
  }): Promise<boolean> | boolean;
  cleanup(input: {
    objectWriteIntentId: string;
    storageObjectId: string;
  }): Promise<void> | void;
}

export interface ObjectIngestRegistry extends DuplicateProtectionStore {
  createObjectWriteIntent(input: CreateObjectWriteIntentInput): Promise<Readonly<{
    intent: Readonly<{
      objectWriteIntentId: string;
      storageObjectId: string;
      state: ObjectWriteIntentState;
      expiresAt: string;
    }>;
    object: Readonly<{
      storageObjectId: string;
      objectProtectionStage: string;
    }>;
  }>>;
  getObjectWriteIntentExecutionContext(
    objectWriteIntentId: string,
  ): Promise<Readonly<ObjectWriteIntentExecutionContext> | null>;
  expireObjectWriteIntentIfDue(objectWriteIntentId: string): Promise<boolean>;
  beginObjectUpload(input: {
    objectWriteIntentId: string;
    expectedRowVersion: number;
  }): Promise<Readonly<ObjectWriteIntentExecutionContext>>;
  completeObjectUpload(input: {
    objectWriteIntentId: string;
    expectedRowVersion: number;
    checksumSha256: string;
    byteLength: number;
  }): Promise<Readonly<ObjectWriteIntentExecutionContext>>;
  cancelObjectWriteIntent(input: {
    objectWriteIntentId: string;
    expectedState: 'accepted' | 'uploading';
    expectedRowVersion: number;
  }): Promise<Readonly<ObjectWriteIntentExecutionContext>>;
  failObjectUpload(objectWriteIntentId: string): Promise<boolean>;
}

export interface ObjectIngestRuntimeOptions {
  authenticate: StorageRuntimeOptions['authenticate'];
  authorizeCaller: StorageRuntimeOptions['authorizeCaller'];
  resolveStorageProfile: StorageRuntimeOptions['resolveStorageProfile'];
  resolveObjectWriteAuthority: NonNullable<StorageRuntimeOptions['resolveObjectWriteAuthority']>;
  uploadCompletionTokenService: UploadCompletionTokenService;
  registry: ObjectIngestRegistry;
  adapter: ObjectIngestAdapter;
  controlPlaneReadiness: StorageRuntimeOptions['controlPlaneReadiness'];
  dataPlaneReadiness: StorageRuntimeOptions['dataPlaneReadiness'];
  now?: () => Date;
  createId?: () => string;
  createLocatorId?: () => string;
}

export class ObjectIngestRuntimeError extends Error {
  readonly category: SafeDiagnosticCategory;
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly failObjectWriteIntent: boolean;

  constructor(
    category: SafeDiagnosticCategory,
    code: string,
    status: number,
    options: { retryable?: boolean; failObjectWriteIntent?: boolean } = {},
  ) {
    super(code);
    this.name = 'ObjectIngestRuntimeError';
    this.category = category;
    this.code = code;
    this.status = status;
    this.retryable = options.retryable ?? false;
    this.failObjectWriteIntent = options.failObjectWriteIntent ?? false;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MIME_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function invalid(code: string, status = 400): never {
  throw new ObjectIngestRuntimeError('invalid-request', code, status);
}

function conflict(code: string): never {
  throw new ObjectIngestRuntimeError('duplicate-conflict', code, 409);
}

function requireUuid(value: string, code: string): string {
  if (!UUID_PATTERN.test(value)) invalid(code);
  return value;
}

function requireSafeId(value: string, code: string, maximum = 128): string {
  if (value.length > maximum || !SAFE_ID_PATTERN.test(value)) invalid(code);
  return value;
}

function requirePositiveSafeInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) invalid(code);
  return value;
}

function requireSha256(value: string, code: string): string {
  if (!SHA256_PATTERN.test(value)) invalid(code);
  return value;
}

function callerServiceId(caller: Readonly<CallerIdentity>): string {
  return caller.serviceId ?? '';
}

function assertSameCaller(
  execution: Readonly<ObjectWriteIntentExecutionContext>,
  caller: Readonly<CallerIdentity>,
): void {
  if (
    execution.callerAppId !== caller.appId ||
    (execution.callerServiceId ?? '') !== callerServiceId(caller)
  ) {
    throw new ObjectIngestRuntimeError('unauthorized', 'object-write-intent-caller-mismatch', 403);
  }
}

function normalizeWritePolicy(
  value: Readonly<ResolvedObjectWritePolicy>,
): Readonly<ResolvedObjectWritePolicy> {
  if (value.uploadMode !== 'server-streamed-single-object') {
    invalid('unsupported-upload-mode');
  }
  if (value.intentTtlSeconds !== 900) invalid('invalid-intent-ttl');
  requirePositiveSafeInteger(value.maxByteLength, 'invalid-max-byte-length');
  if (!Array.isArray(value.allowedMediaTypes) || value.allowedMediaTypes.length === 0) {
    invalid('invalid-allowed-media-types');
  }
  const mediaTypes = value.allowedMediaTypes.map((entry) => {
    if (typeof entry !== 'string' || !MIME_PATTERN.test(entry)) {
      invalid('invalid-allowed-media-types');
    }
    return entry;
  });
  if (new Set(mediaTypes).size !== mediaTypes.length) invalid('invalid-allowed-media-types');
  return Object.freeze({
    uploadMode: 'server-streamed-single-object',
    allowedMediaTypes: Object.freeze(mediaTypes),
    maxByteLength: value.maxByteLength,
    intentTtlSeconds: 900,
  });
}

function normalizeAuthority(
  value: Readonly<ResolvedObjectWriteAuthority>,
): Readonly<ResolvedObjectWriteAuthority> {
  const callerService =
    value.callerServiceId === undefined
      ? undefined
      : requireSafeId(value.callerServiceId, 'invalid-authority-caller-service', 96);
  const authority: ResolvedObjectWriteAuthority = {
    managedAppId: requireUuid(value.managedAppId, 'invalid-authority-managed-app'),
    storageProfileId: requireUuid(value.storageProfileId, 'invalid-authority-storage-profile'),
    storageProfileVersion: requirePositiveSafeInteger(
      value.storageProfileVersion,
      'invalid-authority-profile-version',
    ),
    storageProfileFingerprint: requireSafeId(
      value.storageProfileFingerprint,
      'invalid-authority-profile-fingerprint',
    ),
    storagePrefixClassId: requireUuid(
      value.storagePrefixClassId,
      'invalid-authority-prefix-class',
    ),
    normalizedPrefixPattern: value.normalizedPrefixPattern,
    hotProviderBindingId: requireUuid(
      value.hotProviderBindingId,
      'invalid-authority-hot-binding',
    ),
    canonicalProviderBindingId: requireUuid(
      value.canonicalProviderBindingId,
      'invalid-authority-canonical-binding',
    ),
    writePolicy: normalizeWritePolicy(value.writePolicy),
  };
  if (callerService !== undefined) authority.callerServiceId = callerService;
  if (
    typeof authority.normalizedPrefixPattern !== 'string' ||
    authority.normalizedPrefixPattern.length < 2 ||
    authority.normalizedPrefixPattern.length > 1024 ||
    authority.normalizedPrefixPattern.startsWith('/') ||
    authority.normalizedPrefixPattern.includes('..') ||
    authority.normalizedPrefixPattern.includes('\\') ||
    authority.normalizedPrefixPattern.includes('://') ||
    !authority.normalizedPrefixPattern.endsWith('*')
  ) {
    invalid('invalid-authority-prefix-pattern');
  }
  return Object.freeze(authority);
}

function locatorFor(
  authority: Readonly<ResolvedObjectWriteAuthority>,
  locatorId: string,
  role: 'hot' | 'canonical',
): string {
  const prefix = authority.normalizedPrefixPattern.slice(0, -1);
  const separator = prefix.endsWith('/') ? '' : '/';
  return `${prefix}${separator}${requireSafeId(locatorId, 'invalid-locator-id')}/${role}`;
}

function metadataMatches(
  execution: Readonly<ObjectWriteIntentExecutionContext>,
  metadata: Readonly<ObjectUploadCompletionRequestMetadata>,
): void {
  if (metadata.mediaType !== execution.expectedContentType) invalid('content-type-mismatch');
  if (metadata.byteLength !== execution.expectedByteLength) invalid('content-length-mismatch');
  if (metadata.checksumSha256 !== execution.expectedChecksumSha256) {
    invalid('declared-checksum-mismatch');
  }
}

function validateReceipt(value: Readonly<ObjectIngestReceipt>): void {
  if (value.state !== 'accepted') {
    throw new ObjectIngestRuntimeError('internal', 'invalid-ingest-receipt', 500, {
      failObjectWriteIntent: true,
    });
  }
  requirePositiveSafeInteger(value.byteLength, 'invalid-ingest-receipt-byte-length');
  requireSha256(value.checksumSha256, 'invalid-ingest-receipt-checksum');
}

function bodyTracker(input: {
  body: ReadableStream<Uint8Array>;
  maximumByteLength: number;
}): {
  body: AsyncIterable<Uint8Array>;
  result(): Readonly<{ byteLength: number; checksumSha256: string; completed: boolean }>;
} {
  const reader = input.body.getReader();
  const hash = createHash('sha256');
  let byteLength = 0;
  let completed = false;
  let used = false;

  const body: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      if (used) {
        throw new ObjectIngestRuntimeError('invalid-request', 'request-body-already-consumed', 400, {
          failObjectWriteIntent: true,
        });
      }
      used = true;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) {
            completed = true;
            return;
          }
          const chunk = next.value;
          byteLength += chunk.byteLength;
          if (byteLength > input.maximumByteLength) {
            throw new ObjectIngestRuntimeError('invalid-request', 'content-length-exceeded', 413, {
              failObjectWriteIntent: true,
            });
          }
          hash.update(chunk);
          yield chunk;
        }
      } catch (error) {
        if (error instanceof ObjectIngestRuntimeError) throw error;
        throw new ObjectIngestRuntimeError('invalid-request', 'request-body-aborted', 400, {
          failObjectWriteIntent: true,
        });
      } finally {
        reader.releaseLock();
      }
    },
  };

  return {
    body,
    result: () =>
      Object.freeze({
        byteLength,
        checksumSha256: hash.copy().digest('hex'),
        completed,
      }),
  };
}

async function safeCleanup(
  adapter: ObjectIngestAdapter,
  execution: Pick<ObjectWriteIntentExecutionContext, 'objectWriteIntentId' | 'storageObjectId'>,
): Promise<void> {
  try {
    await adapter.cleanup({
      objectWriteIntentId: execution.objectWriteIntentId,
      storageObjectId: execution.storageObjectId,
    });
  } catch {
    throw new ObjectIngestRuntimeError('dependency-unavailable', 'ingest-cleanup-failed', 503, {
      retryable: true,
      failObjectWriteIntent: true,
    });
  }
}

export function createObjectIngestRuntime(options: ObjectIngestRuntimeOptions): HttpStorageRuntime {
  const now = options.now ?? (() => new Date());
  const createLocatorId = options.createLocatorId ?? randomUUID;

  const runtimeOptions: StorageRuntimeOptions = {
    authenticate: options.authenticate,
    authorizeCaller: options.authorizeCaller,
    resolveStorageProfile: options.resolveStorageProfile,
    resolveObjectWriteAuthority: async (request, context) =>
      normalizeAuthority(await options.resolveObjectWriteAuthority(request, context)),
    uploadCompletionTokenService: options.uploadCompletionTokenService,
    duplicateProtectionStore: options.registry,
    controlPlaneReadiness: options.controlPlaneReadiness,
    dataPlaneReadiness: options.dataPlaneReadiness,
    createObjectWriteIntent: async ({ request, resolvedProfile, writeAuthority, context }) => {
      if (writeAuthority === undefined) {
        throw new ObjectIngestRuntimeError(
          'dependency-unavailable',
          'write-authority-unavailable',
          503,
          { retryable: true },
        );
      }
      const authority = normalizeAuthority(writeAuthority);
      if (
        authority.storageProfileVersion !== request.storageProfile.profileVersion ||
        authority.storageProfileFingerprint !== resolvedProfile.safeFingerprint
      ) {
        conflict('storage-profile-authority-mismatch');
      }
      if ((authority.callerServiceId ?? '') !== callerServiceId(context.caller)) {
        throw new ObjectIngestRuntimeError('unauthorized', 'write-authority-caller-mismatch', 403);
      }
      const locatorId = createLocatorId();
      const expiresAt = new Date(now().getTime() + authority.writePolicy.intentTtlSeconds * 1000);
      const createInput: CreateObjectWriteIntentInput = {
        managedAppId: authority.managedAppId,
        storageProfileId: authority.storageProfileId,
        storageProfileFingerprint: authority.storageProfileFingerprint,
        storagePrefixClassId: authority.storagePrefixClassId,
        hotProviderBindingId: authority.hotProviderBindingId,
        canonicalProviderBindingId: authority.canonicalProviderBindingId,
        appCorrelationReference: context.appCorrelationReference,
        sourceReference: request.sourceReference,
        expectedContentType: request.mediaType,
        expectedByteLength: request.byteLength,
        expectedChecksumSha256: request.checksumSha256,
        expiresAt,
        internalLocators: Object.freeze({
          hot: locatorFor(authority, locatorId, 'hot'),
          canonical: locatorFor(authority, locatorId, 'canonical'),
        }),
        safeTechnicalMetadata: Object.freeze({
          upload_mode: authority.writePolicy.uploadMode,
          profile_version: authority.storageProfileVersion,
        }),
      };
      if (authority.callerServiceId !== undefined) {
        createInput.callerServiceId = authority.callerServiceId;
      }
      if (request.requestedProtectionStage !== undefined) {
        createInput.requestedObjectProtectionStage = request.requestedProtectionStage;
      }
      const created = await options.registry.createObjectWriteIntent(createInput);
      const result: ObjectWriteIntentOperationResult = {
        writeIntentId: created.intent.objectWriteIntentId,
        storageObjectId: created.object.storageObjectId,
        state: 'accepted',
        expiresAt: created.intent.expiresAt,
        objectProtectionStage: 'write-intent-created',
      };
      return Object.freeze(result);
    },
    completeObjectUpload: async ({ metadata, body, tokenClaims, context }) => {
      const execution = await options.registry.getObjectWriteIntentExecutionContext(
        metadata.objectWriteIntentId,
      );
      if (execution === null) invalid('object-write-intent-not-found', 404);
      assertSameCaller(execution, context.caller);
      if (execution.appCorrelationReference !== context.appCorrelationReference) {
        throw new ObjectIngestRuntimeError(
          'unauthorized',
          'object-write-intent-correlation-mismatch',
          403,
        );
      }
      if (
        tokenClaims.objectWriteIntentId !== execution.objectWriteIntentId ||
        tokenClaims.storageObjectId !== execution.storageObjectId ||
        tokenClaims.expiresAt !== execution.expiresAt
      ) {
        throw new ObjectIngestRuntimeError(
          'unauthenticated',
          'invalid-upload-completion-token',
          401,
        );
      }
      if (new Date(execution.expiresAt).getTime() <= now().getTime()) {
        await options.registry.expireObjectWriteIntentIfDue(execution.objectWriteIntentId);
        conflict('object-write-intent-expired');
      }
      if (execution.state !== 'accepted') {
        conflict(`object-write-intent-${execution.state}`);
      }
      metadataMatches(execution, metadata);
      if (body === null) invalid('request-body-required');

      const uploading = await options.registry.beginObjectUpload({
        objectWriteIntentId: execution.objectWriteIntentId,
        expectedRowVersion: execution.rowVersion,
      });
      const tracked = bodyTracker({
        body,
        maximumByteLength: execution.expectedByteLength,
      });
      try {
        const receipt = await options.adapter.ingest(
          Object.freeze({
            objectWriteIntentId: uploading.objectWriteIntentId,
            storageObjectId: uploading.storageObjectId,
            mediaType: uploading.expectedContentType,
            declaredByteLength: uploading.expectedByteLength,
            declaredChecksumSha256: uploading.expectedChecksumSha256,
            body: tracked.body,
            internalLocators: uploading.internalLocators,
            intentRowVersion: uploading.rowVersion,
            ...(uploading.objectRowVersion === undefined
              ? {}
              : { objectRowVersion: uploading.objectRowVersion }),
            ...(uploading.providerCopies === undefined
              ? {}
              : { providerCopies: uploading.providerCopies }),
          }),
        );
        validateReceipt(receipt);
        const observed = tracked.result();
        if (!observed.completed) {
          throw new ObjectIngestRuntimeError('invalid-request', 'request-body-not-fully-consumed', 400, {
            failObjectWriteIntent: true,
          });
        }
        if (observed.byteLength !== uploading.expectedByteLength) {
          throw new ObjectIngestRuntimeError('invalid-request', 'content-length-mismatch', 400, {
            failObjectWriteIntent: true,
          });
        }
        if (observed.checksumSha256 !== uploading.expectedChecksumSha256) {
          throw new ObjectIngestRuntimeError('invalid-request', 'computed-checksum-mismatch', 400, {
            failObjectWriteIntent: true,
          });
        }
        if (
          receipt.byteLength !== observed.byteLength ||
          receipt.checksumSha256 !== observed.checksumSha256
        ) {
          throw new ObjectIngestRuntimeError('internal', 'invalid-ingest-receipt', 500, {
            failObjectWriteIntent: true,
          });
        }
        if (receipt.completionResult !== undefined) {
          const result = receipt.completionResult;
          if (
            result.storageObjectId !== uploading.storageObjectId ||
            result.writeIntentId !== uploading.objectWriteIntentId ||
            result.state !== 'recorded' ||
            result.checksumSha256 !== observed.checksumSha256 ||
            result.byteLength !== observed.byteLength ||
            result.storageState === undefined ||
            result.verifiedMedia === undefined ||
            result.copies === undefined
          ) {
            throw new ObjectIngestRuntimeError('internal', 'invalid-dual-provider-result', 500, {
              failObjectWriteIntent: true,
            });
          }
          return result;
        }
        const completed = await options.registry.completeObjectUpload({
          objectWriteIntentId: uploading.objectWriteIntentId,
          expectedRowVersion: uploading.rowVersion,
          checksumSha256: observed.checksumSha256,
          byteLength: observed.byteLength,
        });
        const result: ObjectUploadCompletionOperationResult = {
          storageObjectId: completed.storageObjectId,
          writeIntentId: completed.objectWriteIntentId,
          state: 'recorded',
          checksumSha256: observed.checksumSha256,
          byteLength: observed.byteLength,
          integrityVerification: Object.freeze({
            verified: true,
            checksumVerified: true,
            sizeVerified: true,
            sizeVerificationDisposition: 'matched',
          }),
          objectProtectionStage: 'upload-completion-recorded',
        };
        return Object.freeze(result);
      } catch (error) {
        await safeCleanup(options.adapter, uploading);
        if (error instanceof ObjectIngestRuntimeError) {
          if (error.failObjectWriteIntent) throw error;
          throw new ObjectIngestRuntimeError(error.category, error.code, error.status, {
            retryable: error.retryable,
            failObjectWriteIntent: true,
          });
        }
        throw new ObjectIngestRuntimeError('dependency-unavailable', 'object-ingest-failed', 503, {
          retryable: true,
          failObjectWriteIntent: true,
        });
      }
    },
    cancelObjectWriteIntent: async ({ objectWriteIntentId, context }) => {
      const execution = await options.registry.getObjectWriteIntentExecutionContext(
        objectWriteIntentId,
      );
      if (execution === null) invalid('object-write-intent-not-found', 404);
      assertSameCaller(execution, context.caller);
      if (execution.appCorrelationReference !== context.appCorrelationReference) {
        throw new ObjectIngestRuntimeError(
          'unauthorized',
          'object-write-intent-correlation-mismatch',
          403,
        );
      }
      if (new Date(execution.expiresAt).getTime() <= now().getTime()) {
        await options.registry.expireObjectWriteIntentIfDue(execution.objectWriteIntentId);
        conflict('object-write-intent-expired');
      }
      if (execution.state !== 'accepted' && execution.state !== 'uploading') {
        conflict(`object-write-intent-${execution.state}`);
      }
      if (
        execution.state === 'uploading' &&
        (await options.adapter.hasPartialState({
          objectWriteIntentId: execution.objectWriteIntentId,
          storageObjectId: execution.storageObjectId,
        }))
      ) {
        await safeCleanup(options.adapter, execution);
      }
      const cancelled = await options.registry.cancelObjectWriteIntent({
        objectWriteIntentId: execution.objectWriteIntentId,
        expectedState: execution.state,
        expectedRowVersion: execution.rowVersion,
      });
      const result: ObjectWriteIntentCancellationOperationResult = {
        storageObjectId: cancelled.storageObjectId,
        writeIntentId: cancelled.objectWriteIntentId,
        state: 'cancelled',
      };
      return Object.freeze(result);
    },
    handleObjectUploadFailure: async ({ objectWriteIntentId }) => {
      await options.registry.failObjectUpload(objectWriteIntentId);
    },
  };
  if (options.now !== undefined) runtimeOptions.now = options.now;
  if (options.createId !== undefined) runtimeOptions.createId = options.createId;
  return createHttpStorageRuntime(runtimeOptions);
}

export type ObjectUploadCompletionTokenClaims = UploadCompletionTokenClaims;
export type ObjectIngestContractVersion = ContractVersion;
export type ObjectIngestProfileRequest = StorageProfileRequest;
export type ObjectIngestSafeProfile = SafeResolvedStorageProfile;
export type ObjectIngestWriteIntentRequest = ObjectWriteIntentRequest;
export type ObjectIngestRequestContext = RuntimeRequestContext;
