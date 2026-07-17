import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { CallerIdentity, ContractVersion, DuplicateProtectionSummary, SafeDiagnostic } from './runtime-contract.js';
import {
  RuntimeStorageRegistryError,
  type PostgresPoolLike,
  type PostgresQueryable,
} from './runtime-storage-registry-types.js';
import {
  PostgresTransactionScope,
  asIso,
  asNumber,
  requireSafeIdentifier,
  requireSha256,
  requireUuid,
} from './runtime-storage-registry-support.js';

export const READ_GRANT_TOKEN_PURPOSE = 'z-s-object-read-grant-v1' as const;
export const READ_GRANT_MIN_TTL_SECONDS = 30 as const;
export const READ_GRANT_MAX_TTL_SECONDS = 300 as const;

export type ObjectReadMethod = 'HEAD' | 'GET';
export type ObjectReadGrantState = 'active' | 'revoked' | 'expired';
export type ObjectReadDisposition = 'inline' | 'attachment';
export type ReadProviderRole = 'hot' | 'canonical';

export interface ReadGrantRequest {
  storageObjectId: string;
  purpose: string;
  allowedMethods: readonly ObjectReadMethod[];
  allowRange: boolean;
  disposition: ObjectReadDisposition;
  fileName?: string;
  requestedTtlSeconds: number;
  businessAuthorizationReference: string;
}

export interface ReadGrantResult {
  objectReadGrantId: string;
  storageObjectId: string;
  state: ObjectReadGrantState;
  expiresAt: string;
  allowedMethods: readonly ObjectReadMethod[];
  allowRange: boolean;
  disposition: ObjectReadDisposition;
  fileName?: string;
  duplicateProtection: DuplicateProtectionSummary;
  readGrantToken: string;
  safeDiagnostic?: SafeDiagnostic;
}

export interface ReadGrantRevocationResult {
  objectReadGrantId: string;
  storageObjectId: string;
  state: 'revoked' | 'expired';
  revokedAt?: string;
  expiresAt: string;
  duplicateProtection: DuplicateProtectionSummary;
}

export interface ReadGrantTokenClaims {
  tokenPurpose: typeof READ_GRANT_TOKEN_PURPOSE;
  objectReadGrantId: string;
  storageObjectId: string;
  callerAppId: string;
  callerServiceId?: string;
  purpose: string;
  allowedMethods: readonly ObjectReadMethod[];
  allowRange: boolean;
  contractVersion: ContractVersion;
  expiresAt: string;
}

export interface ReadGrantTokenExpectation {
  tokenPurpose: typeof READ_GRANT_TOKEN_PURPOSE;
  storageObjectId: string;
  callerAppId: string;
  callerServiceId: string;
  method: ObjectReadMethod;
  contractVersion: ContractVersion;
  rangeRequested: boolean;
  now: Date;
}

export interface ReadGrantTokenService {
  issue(claims: Readonly<ReadGrantTokenClaims>): Promise<string> | string;
  verify(
    token: string,
    expectation: Readonly<ReadGrantTokenExpectation>,
  ): Promise<Readonly<ReadGrantTokenClaims>> | Readonly<ReadGrantTokenClaims>;
}

export class ReadGrantError extends Error {
  readonly category: SafeDiagnostic['category'];
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    category: SafeDiagnostic['category'],
    code: string,
    status: number,
    retryable = false,
  ) {
    super(code);
    this.name = 'ReadGrantError';
    this.category = category;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_FILE_NAME_PATTERN = /^[^\u0000-\u001f\u007f/\\]{1,180}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireTokenString(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string') throw new ReadGrantError('invalid-request', `invalid-${name}`, 400);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max) {
    throw new ReadGrantError('invalid-request', `invalid-${name}`, 400);
  }
  return normalized;
}

function normalizeMethods(value: unknown): readonly ObjectReadMethod[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
    throw new ReadGrantError('invalid-request', 'invalid-allowed-methods', 400);
  }
  const methods = value.map((entry) => {
    if (entry !== 'HEAD' && entry !== 'GET') {
      throw new ReadGrantError('invalid-request', 'invalid-allowed-methods', 400);
    }
    return entry;
  });
  if (new Set(methods).size !== methods.length) {
    throw new ReadGrantError('invalid-request', 'invalid-allowed-methods', 400);
  }
  return Object.freeze([...methods].sort() as ObjectReadMethod[]);
}

export function sanitizeReadFileName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ReadGrantError('invalid-request', 'invalid-file-name', 400);
  }
  const normalized = value.trim();
  if (!SAFE_FILE_NAME_PATTERN.test(normalized) || normalized === '.' || normalized === '..') {
    throw new ReadGrantError('invalid-request', 'invalid-file-name', 400);
  }
  return normalized;
}

export function normalizeReadGrantRequest(value: unknown): Readonly<ReadGrantRequest> {
  if (!isRecord(value)) {
    throw new ReadGrantError('invalid-request', 'invalid-object-read-grant', 400);
  }
  const storageObjectId = requireTokenString(value.storageObjectId, 'storage-object-id', 36);
  if (!UUID_PATTERN.test(storageObjectId)) {
    throw new ReadGrantError('invalid-request', 'invalid-storage-object-id', 400);
  }
  const purpose = requireTokenString(value.purpose, 'purpose', 128);
  if (!SAFE_IDENTIFIER_PATTERN.test(purpose)) {
    throw new ReadGrantError('invalid-request', 'invalid-purpose', 400);
  }
  const businessAuthorizationReference = requireTokenString(
    value.businessAuthorizationReference,
    'business-authorization-reference',
    256,
  );
  if (/\r|\n/.test(businessAuthorizationReference)) {
    throw new ReadGrantError('invalid-request', 'invalid-business-authorization-reference', 400);
  }
  if (!Number.isSafeInteger(value.requestedTtlSeconds)) {
    throw new ReadGrantError('invalid-request', 'invalid-requested-ttl-seconds', 400);
  }
  const requestedTtlSeconds = value.requestedTtlSeconds as number;
  if (
    requestedTtlSeconds < READ_GRANT_MIN_TTL_SECONDS ||
    requestedTtlSeconds > READ_GRANT_MAX_TTL_SECONDS
  ) {
    throw new ReadGrantError('invalid-request', 'invalid-requested-ttl-seconds', 400);
  }
  if (typeof value.allowRange !== 'boolean') {
    throw new ReadGrantError('invalid-request', 'invalid-allow-range', 400);
  }
  if (value.disposition !== 'inline' && value.disposition !== 'attachment') {
    throw new ReadGrantError('invalid-request', 'invalid-disposition', 400);
  }
  const result: ReadGrantRequest = {
    storageObjectId,
    purpose,
    allowedMethods: normalizeMethods(value.allowedMethods),
    allowRange: value.allowRange,
    disposition: value.disposition,
    requestedTtlSeconds,
    businessAuthorizationReference,
  };
  const fileName = sanitizeReadFileName(value.fileName);
  if (fileName !== undefined) result.fileName = fileName;
  return Object.freeze(result);
}

function validateClaims(value: unknown): Readonly<ReadGrantTokenClaims> {
  if (!isRecord(value) || value.tokenPurpose !== READ_GRANT_TOKEN_PURPOSE) {
    throw new ReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
  }
  const objectReadGrantId = requireTokenString(value.objectReadGrantId, 'object-read-grant-id', 36);
  const storageObjectId = requireTokenString(value.storageObjectId, 'storage-object-id', 36);
  if (!UUID_PATTERN.test(objectReadGrantId) || !UUID_PATTERN.test(storageObjectId)) {
    throw new ReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
  }
  const callerAppId = requireTokenString(value.callerAppId, 'caller-app', 96);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(callerAppId)) {
    throw new ReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
  }
  const purpose = requireTokenString(value.purpose, 'purpose', 128);
  if (!SAFE_IDENTIFIER_PATTERN.test(purpose)) {
    throw new ReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
  }
  const expiresAt = requireTokenString(value.expiresAt, 'expires-at', 64);
  let normalizedExpiry: string;
  try {
    normalizedExpiry = new Date(expiresAt).toISOString();
  } catch {
    throw new ReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
  }
  if (normalizedExpiry !== expiresAt || value.contractVersion !== '1.0') {
    throw new ReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
  }
  if (typeof value.allowRange !== 'boolean') {
    throw new ReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
  }
  const result: ReadGrantTokenClaims = {
    tokenPurpose: READ_GRANT_TOKEN_PURPOSE,
    objectReadGrantId,
    storageObjectId,
    callerAppId,
    purpose,
    allowedMethods: normalizeMethods(value.allowedMethods),
    allowRange: value.allowRange,
    contractVersion: value.contractVersion,
    expiresAt,
  };
  if (value.callerServiceId !== undefined) {
    const callerServiceId = requireTokenString(value.callerServiceId, 'caller-service', 96);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(callerServiceId)) {
      throw new ReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
    }
    result.callerServiceId = callerServiceId;
  }
  return Object.freeze(result);
}

function encodeClaims(claims: Readonly<ReadGrantTokenClaims>): string {
  const ordered = {
    tokenPurpose: claims.tokenPurpose,
    objectReadGrantId: claims.objectReadGrantId,
    storageObjectId: claims.storageObjectId,
    callerAppId: claims.callerAppId,
    callerServiceId: claims.callerServiceId ?? '',
    purpose: claims.purpose,
    allowedMethods: [...claims.allowedMethods],
    allowRange: claims.allowRange,
    contractVersion: claims.contractVersion,
    expiresAt: claims.expiresAt,
  };
  return Buffer.from(JSON.stringify(ordered), 'utf8').toString('base64url');
}

export function createDeterministicReadGrantTokenService(options: {
  signingKey: string | Uint8Array;
}): ReadGrantTokenService {
  const key =
    typeof options.signingKey === 'string'
      ? Buffer.from(options.signingKey, 'utf8')
      : Buffer.from(options.signingKey);
  if (key.byteLength < 32) throw new TypeError('signingKey must contain at least 32 bytes.');

  function signature(payload: string): Buffer {
    return createHmac('sha256', key).update(payload).digest();
  }

  return Object.freeze({
    issue(claims: Readonly<ReadGrantTokenClaims>): string {
      const normalized = validateClaims(claims);
      const payload = encodeClaims(normalized);
      return `${payload}.${signature(payload).toString('base64url')}`;
    },
    verify(
      token: string,
      expectation: Readonly<ReadGrantTokenExpectation>,
    ): Readonly<ReadGrantTokenClaims> {
      if (token.length > 4096 || !TOKEN_PATTERN.test(token)) {
        throw new ReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
      }
      const [payload, providedSignature] = token.split('.');
      if (payload === undefined || providedSignature === undefined) {
        throw new ReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
      }
      let signatureBytes: Buffer;
      try {
        signatureBytes = Buffer.from(providedSignature, 'base64url');
      } catch {
        throw new ReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
      }
      const expectedSignature = signature(payload);
      if (
        signatureBytes.byteLength !== expectedSignature.byteLength ||
        !timingSafeEqual(signatureBytes, expectedSignature)
      ) {
        throw new ReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      } catch {
        throw new ReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
      }
      const claims = validateClaims(decoded);
      if (
        claims.tokenPurpose !== expectation.tokenPurpose ||
        claims.storageObjectId !== expectation.storageObjectId ||
        claims.callerAppId !== expectation.callerAppId ||
        (claims.callerServiceId ?? '') !== expectation.callerServiceId ||
        claims.contractVersion !== expectation.contractVersion ||
        !claims.allowedMethods.includes(expectation.method) ||
        (expectation.rangeRequested && !claims.allowRange)
      ) {
        throw new ReadGrantError('unauthorized', 'read-grant-scope-mismatch', 403);
      }
      if (new Date(claims.expiresAt).getTime() <= expectation.now.getTime()) {
        throw new ReadGrantError('unauthenticated', 'read-grant-expired', 401);
      }
      return claims;
    },
  });
}

export function readGrantTokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface ReadGrantSnapshot {
  objectReadGrantId: string;
  storageObjectId: string;
  managedAppId: string;
  callerAppId: string;
  callerServiceId?: string;
  appCorrelationReference: string;
  businessAuthorizationReference: string;
  purpose: string;
  allowedMethods: readonly ObjectReadMethod[];
  allowRange: boolean;
  disposition: ObjectReadDisposition;
  fileName?: string;
  tokenDigest: string;
  tokenPurpose: typeof READ_GRANT_TOKEN_PURPOSE;
  state: ObjectReadGrantState;
  expiresAt: string;
  revokedAt?: string;
  createdAt: string;
  updatedAt: string;
  rowVersion: number;
}

export interface ResolvedReadTarget {
  providerRole: ReadProviderRole;
  storageObjectCopyId: string;
  providerId: string;
  bucketLabel: string;
  internalLocator: string;
  normalizedPrefixPattern: string;
  credentialSecretReferenceId: string;
}

export interface ReadDeliverySnapshot {
  grant: ReadGrantSnapshot;
  storageObjectId: string;
  mediaType: string;
  byteLength: number;
  checksumSha256: string;
  targets: Readonly<Partial<Record<ReadProviderRole, Readonly<ResolvedReadTarget>>>>;
}

export interface ReadGrantRegistry {
  issue(input: {
    request: Readonly<ReadGrantRequest>;
    caller: Readonly<CallerIdentity>;
    contractVersion: ContractVersion;
    appCorrelationReference: string;
    duplicateProtectionKey: string;
    requestFingerprint: string;
    candidateObjectReadGrantId: string;
    candidateTokenDigest: string;
    candidateExpiresAt: Date;
  }): Promise<Readonly<{ grant: ReadGrantSnapshot; replayed: boolean }>>;
  revoke(input: {
    objectReadGrantId: string;
    caller: Readonly<CallerIdentity>;
    appCorrelationReference: string;
    duplicateProtectionKey: string;
    requestFingerprint: string;
  }): Promise<Readonly<{ grant: ReadGrantSnapshot; replayed: boolean }>>;
  authorize(input: {
    claims: Readonly<ReadGrantTokenClaims>;
    tokenDigest: string;
    method: ObjectReadMethod;
    rangeRequested: boolean;
    caller: Readonly<CallerIdentity>;
    now: Date;
  }): Promise<Readonly<ReadDeliverySnapshot>>;
  beginReadAttempt(input: {
    snapshot: Readonly<ReadDeliverySnapshot>;
    providerRole: ReadProviderRole;
    attemptNumber: number;
  }): Promise<string>;
  finishReadAttempt(input: {
    providerAttemptId: string;
    succeeded: boolean;
    retryable?: boolean;
    observedByteLength?: number;
    diagnostic?: Readonly<SafeDiagnostic>;
  }): Promise<void>;
  appendReadEvent(input: {
    snapshot: Readonly<ReadDeliverySnapshot>;
    eventType: string;
    deliveryState?: 'hot' | 'canonical-fallback';
    method: ObjectReadMethod;
    rangeRequested: boolean;
    diagnostic?: Readonly<SafeDiagnostic>;
  }): Promise<void>;
}

interface ReadGrantRow extends Record<string, unknown> {
  object_read_grant_id: string;
  storage_object_id: string;
  managed_app_id: string;
  caller_app_id: string;
  caller_service_id: string | null;
  app_correlation_ref: string;
  business_authorization_ref: string;
  purpose: string;
  allowed_methods: string[];
  range_allowed: boolean;
  disposition: ObjectReadDisposition;
  safe_file_name: string | null;
  read_grant_token_digest: string;
  token_purpose: string;
  state: ObjectReadGrantState;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  row_version: number;
}

interface ReadDeliveryRow extends ReadGrantRow {
  registry_state: string;
  verified_checksum_sha256: string | null;
  verified_byte_length: string | number | null;
  expected_content_type: string;
  provider_role: ReadProviderRole;
  storage_object_copy_id: string;
  copy_state: string;
  observed_checksum_sha256: string | null;
  observed_byte_length: string | number | null;
  internal_locator: string;
  bucket_label: string;
  provider_id: string;
  provider_status: string;
  secret_reference_id: string;
  normalized_prefix_pattern: string;
}

function mapGrant(row: ReadGrantRow): Readonly<ReadGrantSnapshot> {
  const methods = normalizeMethods(row.allowed_methods);
  const result: ReadGrantSnapshot = {
    objectReadGrantId: row.object_read_grant_id,
    storageObjectId: row.storage_object_id,
    managedAppId: row.managed_app_id,
    callerAppId: row.caller_app_id,
    appCorrelationReference: row.app_correlation_ref,
    businessAuthorizationReference: row.business_authorization_ref,
    purpose: row.purpose,
    allowedMethods: methods,
    allowRange: row.range_allowed,
    disposition: row.disposition,
    tokenDigest: requireSha256(row.read_grant_token_digest, 'read-grant-token-digest'),
    tokenPurpose: READ_GRANT_TOKEN_PURPOSE,
    state: row.state,
    expiresAt: asIso(row.expires_at),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
    rowVersion: row.row_version,
  };
  if (row.caller_service_id !== null) result.callerServiceId = row.caller_service_id;
  if (row.safe_file_name !== null) result.fileName = row.safe_file_name;
  if (row.revoked_at !== null) result.revokedAt = asIso(row.revoked_at);
  return Object.freeze(result);
}

function callerService(caller: Readonly<CallerIdentity>): string {
  return caller.serviceId ?? '';
}

function normalizeDatabaseError(error: unknown): never {
  if (error instanceof ReadGrantError || error instanceof RuntimeStorageRegistryError) throw error;
  throw new ReadGrantError('dependency-unavailable', 'read-grant-registry-unavailable', 503, true);
}

export interface PostgresReadGrantRegistryOptions {
  pool: PostgresPoolLike;
  now?: () => Date;
  createId?: () => string;
  idempotencyReservationTtlMs?: number;
}

export class PostgresReadGrantRegistry implements ReadGrantRegistry {
  readonly #scope: PostgresTransactionScope;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #idempotencyReservationTtlMs: number;

  constructor(options: PostgresReadGrantRegistryOptions) {
    this.#scope = new PostgresTransactionScope(options.pool);
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#idempotencyReservationTtlMs = options.idempotencyReservationTtlMs ?? 5 * 60_000;
  }

  async #readGrant(client: PostgresQueryable, objectReadGrantId: string): Promise<ReadGrantSnapshot> {
    const result = await client.query<ReadGrantRow>(
      `SELECT object_read_grant_id, storage_object_id, managed_app_id, caller_app_id,
              caller_service_id, app_correlation_ref, business_authorization_ref, purpose,
              allowed_methods, range_allowed, disposition, safe_file_name,
              read_grant_token_digest, token_purpose, state, expires_at, revoked_at,
              created_at, updated_at, row_version
         FROM public.object_read_grants
        WHERE object_read_grant_id = $1`,
      [objectReadGrantId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ReadGrantError('internal', 'read-grant-result-missing', 500);
    return mapGrant(row);
  }

  async issue(input: {
    request: Readonly<ReadGrantRequest>;
    caller: Readonly<CallerIdentity>;
    contractVersion: ContractVersion;
    appCorrelationReference: string;
    duplicateProtectionKey: string;
    requestFingerprint: string;
    candidateObjectReadGrantId: string;
    candidateTokenDigest: string;
    candidateExpiresAt: Date;
  }): Promise<Readonly<{ grant: ReadGrantSnapshot; replayed: boolean }>> {
    requireUuid(input.candidateObjectReadGrantId, 'object-read-grant-id');
    requireSha256(input.candidateTokenDigest, 'read-grant-token-digest');
    requireSha256(input.requestFingerprint, 'request-fingerprint');
    const key = requireSafeIdentifier(input.duplicateProtectionKey, 'duplicate-protection-key');
    try {
      return await this.#scope.run(async (client) => {
        const now = this.#now();
        const objectResult = await client.query<{
          storage_object_id: string;
          managed_app_id: string;
          registry_state: string;
          verified_checksum_sha256: string | null;
          verified_byte_length: string | number | null;
          profile_status: string;
          readable_copy_count: string | number;
          head_capability_count: string | number;
          get_capability_count: string | number;
          range_capability_count: string | number;
        }>(
          `SELECT object_record.storage_object_id, object_record.managed_app_id,
                  object_record.registry_state, object_record.verified_checksum_sha256,
                  object_record.verified_byte_length, profile.status AS profile_status,
                  COUNT(DISTINCT copy.storage_object_copy_id) FILTER (
                    WHERE copy.copy_state = 'verified'
                      AND copy.observed_checksum_sha256 = object_record.verified_checksum_sha256
                      AND copy.observed_byte_length = object_record.verified_byte_length
                  ) AS readable_copy_count,
                  COUNT(DISTINCT binding.id) FILTER (
                    WHERE capability.capability = 'head' AND capability.result = 'passed'
                      AND (capability.expires_at IS NULL OR capability.expires_at > $3)
                  ) AS head_capability_count,
                  COUNT(DISTINCT binding.id) FILTER (
                    WHERE capability.capability = 'get' AND capability.result = 'passed'
                      AND (capability.expires_at IS NULL OR capability.expires_at > $3)
                  ) AS get_capability_count,
                  COUNT(DISTINCT binding.id) FILTER (
                    WHERE capability.capability = 'range' AND capability.result = 'passed'
                      AND (capability.expires_at IS NULL OR capability.expires_at > $3)
                  ) AS range_capability_count
             FROM public.storage_objects AS object_record
             JOIN public.managed_apps AS app ON app.id = object_record.managed_app_id
             JOIN public.storage_profiles AS profile ON profile.id = object_record.storage_profile_id
             JOIN public.storage_prefix_classes AS prefix_class
               ON prefix_class.id = object_record.storage_prefix_class_id
             LEFT JOIN public.storage_object_copies AS copy
               ON copy.storage_object_id = object_record.storage_object_id
             LEFT JOIN public.storage_profile_provider_bindings AS binding
               ON binding.id = copy.storage_profile_provider_binding_id
             LEFT JOIN public.storage_capability_results AS capability
               ON capability.storage_profile_id = object_record.storage_profile_id
              AND capability.storage_provider_id = binding.storage_provider_id
              AND capability.bucket_label = binding.bucket_label
              AND capability.prefix_class_id = prefix_class.prefix_class_id
            WHERE object_record.storage_object_id = $1
              AND app.app_id = $2
            GROUP BY object_record.storage_object_id, object_record.managed_app_id,
                     object_record.registry_state, object_record.verified_checksum_sha256,
                     object_record.verified_byte_length, profile.status`,
          [input.request.storageObjectId, input.caller.appId, now],
        );
        const object = objectResult.rows[0];
        const requiresHead = input.request.allowedMethods.includes('HEAD');
        const requiresGet = input.request.allowedMethods.includes('GET');
        if (
          object === undefined ||
          (object.registry_state !== 'active' && object.registry_state !== 'degraded') ||
          object.verified_checksum_sha256 === null ||
          object.verified_byte_length === null ||
          object.profile_status !== 'active' ||
          asNumber(object.readable_copy_count) < 1 ||
          (requiresHead && asNumber(object.head_capability_count) < 1) ||
          (requiresGet && asNumber(object.get_capability_count) < 1) ||
          (input.request.allowRange && asNumber(object.range_capability_count) < 1)
        ) {
          throw new ReadGrantError('not-ready', 'storage-object-not-readable', 409);
        }

        const idempotencyExpiry = new Date(now.getTime() + this.#idempotencyReservationTtlMs);
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO public.storage_idempotency_records (
             id, caller_app_id, caller_service_id, operation_scope, idempotency_key,
             request_fingerprint, state, expires_at, created_at, updated_at
           ) VALUES ($1, $2, $3, 'object-read-grant', $4, $5, 'in_progress', $6, $7, $7)
           ON CONFLICT (caller_app_id, caller_service_id, operation_scope, idempotency_key)
           DO NOTHING RETURNING id`,
          [
            this.#createId(),
            input.caller.appId,
            callerService(input.caller),
            key,
            input.requestFingerprint,
            idempotencyExpiry,
            now,
          ],
        );
        const existing = await client.query<{
          request_fingerprint: string;
          state: string;
          result_kind: string | null;
          result_reference_id: string | null;
          expires_at: Date | string;
        }>(
          `SELECT request_fingerprint, state, result_kind, result_reference_id, expires_at
             FROM public.storage_idempotency_records
            WHERE caller_app_id = $1 AND caller_service_id = $2
              AND operation_scope = 'object-read-grant' AND idempotency_key = $3
            FOR UPDATE`,
          [input.caller.appId, callerService(input.caller), key],
        );
        const duplicate = existing.rows[0];
        if (duplicate === undefined) {
          throw new ReadGrantError('internal', 'idempotency-record-missing', 500);
        }
        if (duplicate.request_fingerprint !== input.requestFingerprint) {
          throw new ReadGrantError('duplicate-conflict', 'idempotency-key-reused', 409);
        }
        if (
          inserted.rowCount === 0 &&
          duplicate.state === 'succeeded' &&
          duplicate.result_kind === 'object-read-grant' &&
          duplicate.result_reference_id !== null
        ) {
          return Object.freeze({
            grant: await this.#readGrant(client, duplicate.result_reference_id),
            replayed: true,
          });
        }
        if (
          inserted.rowCount === 0 &&
          duplicate.state === 'in_progress' &&
          new Date(duplicate.expires_at) > now
        ) {
          throw new ReadGrantError(
            'duplicate-conflict',
            'idempotency-request-in-progress',
            409,
            true,
          );
        }
        if (inserted.rowCount === 0) {
          await client.query(
            `UPDATE public.storage_idempotency_records
                SET state = 'in_progress', result_kind = NULL, result_reference_id = NULL,
                    result_storage_object_id = NULL, expires_at = $4, updated_at = $5
              WHERE caller_app_id = $1 AND caller_service_id = $2
                AND operation_scope = 'object-read-grant' AND idempotency_key = $3`,
            [
              input.caller.appId,
              callerService(input.caller),
              key,
              idempotencyExpiry,
              now,
            ],
          );
        }

        await client.query(
          `INSERT INTO public.object_read_grants (
             object_read_grant_id, storage_object_id, managed_app_id, caller_service_id,
             app_correlation_ref, business_authorization_ref, purpose, allowed_methods,
             range_allowed, disposition, safe_file_name, read_grant_token_digest,
             token_purpose, state, expires_at, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, $12,
                     $13, 'active', $14, $15, $15)`,
          [
            input.candidateObjectReadGrantId,
            input.request.storageObjectId,
            object.managed_app_id,
            input.caller.serviceId ?? null,
            input.appCorrelationReference,
            input.request.businessAuthorizationReference,
            input.request.purpose,
            [...input.request.allowedMethods],
            input.request.allowRange,
            input.request.disposition,
            input.request.fileName ?? null,
            input.candidateTokenDigest,
            READ_GRANT_TOKEN_PURPOSE,
            input.candidateExpiresAt,
            now,
          ],
        );
        await client.query(
          `UPDATE public.storage_idempotency_records
              SET state = 'succeeded', result_kind = 'object-read-grant',
                  result_reference_id = $4, result_storage_object_id = $5, updated_at = $6
            WHERE caller_app_id = $1 AND caller_service_id = $2
              AND operation_scope = 'object-read-grant' AND idempotency_key = $3`,
          [
            input.caller.appId,
            callerService(input.caller),
            key,
            input.candidateObjectReadGrantId,
            input.request.storageObjectId,
            now,
          ],
        );
        return Object.freeze({
          grant: await this.#readGrant(client, input.candidateObjectReadGrantId),
          replayed: false,
        });
      });
    } catch (error) {
      return normalizeDatabaseError(error);
    }
  }

  async revoke(input: {
    objectReadGrantId: string;
    caller: Readonly<CallerIdentity>;
    appCorrelationReference: string;
    duplicateProtectionKey: string;
    requestFingerprint: string;
  }): Promise<Readonly<{ grant: ReadGrantSnapshot; replayed: boolean }>> {
    requireUuid(input.objectReadGrantId, 'object-read-grant-id');
    requireSha256(input.requestFingerprint, 'request-fingerprint');
    const key = requireSafeIdentifier(input.duplicateProtectionKey, 'duplicate-protection-key');
    try {
      return await this.#scope.run(async (client) => {
        const now = this.#now();
        const result = await client.query<ReadGrantRow>(
          `SELECT grant.object_read_grant_id, grant.storage_object_id, grant.managed_app_id,
                  app.app_id AS caller_app_id, grant.caller_service_id,
                  grant.app_correlation_ref, grant.business_authorization_ref, grant.purpose,
                  grant.allowed_methods, grant.range_allowed, grant.disposition,
                  grant.safe_file_name, grant.read_grant_token_digest, grant.token_purpose,
                  grant.state, grant.expires_at, grant.revoked_at, grant.created_at,
                  grant.updated_at, grant.row_version
             FROM public.object_read_grants AS grant
             JOIN public.managed_apps AS app ON app.id = grant.managed_app_id
            WHERE grant.object_read_grant_id = $1
              AND app.app_id = $2
              AND COALESCE(grant.caller_service_id, '') = $3
            FOR UPDATE OF grant`,
          [input.objectReadGrantId, input.caller.appId, callerService(input.caller)],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw new ReadGrantError('unauthorized', 'read-grant-not-found', 404);
        }
        if (row.state === 'active' && new Date(row.expires_at) <= now) {
          await client.query(
            `UPDATE public.object_read_grants
                SET state = 'expired', updated_at = $2, row_version = row_version + 1
              WHERE object_read_grant_id = $1 AND state = 'active'`,
            [input.objectReadGrantId, now],
          );
        } else if (row.state === 'active') {
          await client.query(
            `UPDATE public.object_read_grants
                SET state = 'revoked', revoked_at = $2, updated_at = $2,
                    row_version = row_version + 1
              WHERE object_read_grant_id = $1 AND state = 'active'`,
            [input.objectReadGrantId, now],
          );
        }

        const idempotencyExpiry = new Date(now.getTime() + this.#idempotencyReservationTtlMs);
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO public.storage_idempotency_records (
             id, caller_app_id, caller_service_id, operation_scope, idempotency_key,
             request_fingerprint, state, result_kind, result_reference_id,
             result_storage_object_id, expires_at, created_at, updated_at
           ) VALUES ($1, $2, $3, 'object-read-grant-revoke', $4, $5, 'succeeded',
                     'object-read-grant-revoke', $6, $7, $8, $9, $9)
           ON CONFLICT (caller_app_id, caller_service_id, operation_scope, idempotency_key)
           DO NOTHING RETURNING id`,
          [
            this.#createId(),
            input.caller.appId,
            callerService(input.caller),
            key,
            input.requestFingerprint,
            input.objectReadGrantId,
            row.storage_object_id,
            idempotencyExpiry,
            now,
          ],
        );
        const duplicate = await client.query<{
          request_fingerprint: string;
          result_reference_id: string | null;
        }>(
          `SELECT request_fingerprint, result_reference_id
             FROM public.storage_idempotency_records
            WHERE caller_app_id = $1 AND caller_service_id = $2
              AND operation_scope = 'object-read-grant-revoke' AND idempotency_key = $3`,
          [input.caller.appId, callerService(input.caller), key],
        );
        const duplicateRow = duplicate.rows[0];
        if (duplicateRow === undefined) {
          throw new ReadGrantError('internal', 'idempotency-record-missing', 500);
        }
        if (
          duplicateRow.request_fingerprint !== input.requestFingerprint ||
          duplicateRow.result_reference_id !== input.objectReadGrantId
        ) {
          throw new ReadGrantError('duplicate-conflict', 'idempotency-key-reused', 409);
        }
        return Object.freeze({
          grant: await this.#readGrant(client, input.objectReadGrantId),
          replayed: inserted.rowCount === 0,
        });
      });
    } catch (error) {
      return normalizeDatabaseError(error);
    }
  }

  async authorize(input: {
    claims: Readonly<ReadGrantTokenClaims>;
    tokenDigest: string;
    method: ObjectReadMethod;
    rangeRequested: boolean;
    caller: Readonly<CallerIdentity>;
    now: Date;
  }): Promise<Readonly<ReadDeliverySnapshot>> {
    requireSha256(input.tokenDigest, 'read-grant-token-digest');
    try {
      return await this.#scope.run(async (client) => {
        await client.query(
          `UPDATE public.object_read_grants
              SET state = 'expired', updated_at = $2, row_version = row_version + 1
            WHERE object_read_grant_id = $1 AND state = 'active' AND expires_at <= $2`,
          [input.claims.objectReadGrantId, input.now],
        );
        const result = await client.query<ReadDeliveryRow>(
          `SELECT grant.object_read_grant_id, grant.storage_object_id, grant.managed_app_id,
                  app.app_id AS caller_app_id, grant.caller_service_id,
                  grant.app_correlation_ref, grant.business_authorization_ref, grant.purpose,
                  grant.allowed_methods, grant.range_allowed, grant.disposition,
                  grant.safe_file_name, grant.read_grant_token_digest, grant.token_purpose,
                  grant.state, grant.expires_at, grant.revoked_at, grant.created_at,
                  grant.updated_at, grant.row_version, object_record.registry_state,
                  object_record.verified_checksum_sha256, object_record.verified_byte_length,
                  object_record.expected_content_type, copy.provider_role,
                  copy.storage_object_copy_id, copy.copy_state,
                  copy.observed_checksum_sha256, copy.observed_byte_length,
                  copy.internal_locator, binding.bucket_label, provider.provider_id,
                  provider.status AS provider_status, provider.secret_reference_id,
                  prefix_class.normalized_prefix_pattern
             FROM public.object_read_grants AS grant
             JOIN public.managed_apps AS app ON app.id = grant.managed_app_id
             JOIN public.storage_objects AS object_record
               ON object_record.storage_object_id = grant.storage_object_id
             JOIN public.storage_prefix_classes AS prefix_class
               ON prefix_class.id = object_record.storage_prefix_class_id
             JOIN public.storage_object_copies AS copy
               ON copy.storage_object_id = object_record.storage_object_id
             JOIN public.storage_profile_provider_bindings AS binding
               ON binding.id = copy.storage_profile_provider_binding_id
             JOIN public.storage_providers AS provider
               ON provider.id = binding.storage_provider_id
            WHERE grant.object_read_grant_id = $1
            ORDER BY copy.provider_role DESC`,
          [input.claims.objectReadGrantId],
        );
        const first = result.rows[0];
        if (first === undefined) {
          throw new ReadGrantError('unauthorized', 'read-grant-not-found', 404);
        }
        const grant = mapGrant(first);
        if (
          grant.state !== 'active' ||
          new Date(grant.expiresAt) <= input.now ||
          grant.tokenDigest !== input.tokenDigest
        ) {
          throw new ReadGrantError('unauthenticated', 'read-grant-inactive', 401);
        }
        if (
          grant.objectReadGrantId !== input.claims.objectReadGrantId ||
          grant.storageObjectId !== input.claims.storageObjectId ||
          grant.callerAppId !== input.caller.appId ||
          (grant.callerServiceId ?? '') !== callerService(input.caller) ||
          grant.purpose !== input.claims.purpose ||
          grant.allowRange !== input.claims.allowRange ||
          grant.expiresAt !== input.claims.expiresAt ||
          JSON.stringify(grant.allowedMethods) !== JSON.stringify(input.claims.allowedMethods) ||
          !grant.allowedMethods.includes(input.method) ||
          (input.rangeRequested && !grant.allowRange)
        ) {
          throw new ReadGrantError('unauthorized', 'read-grant-scope-mismatch', 403);
        }
        if (
          (first.registry_state !== 'active' && first.registry_state !== 'degraded') ||
          first.verified_checksum_sha256 === null ||
          first.verified_byte_length === null
        ) {
          throw new ReadGrantError('not-ready', 'storage-object-not-readable', 409);
        }
        const verifiedLength = asNumber(first.verified_byte_length);
        const targets: Partial<Record<ReadProviderRole, Readonly<ResolvedReadTarget>>> = {};
        for (const row of result.rows) {
          if (
            row.copy_state !== 'verified' ||
            row.provider_status !== 'active' ||
            row.observed_checksum_sha256 !== first.verified_checksum_sha256 ||
            row.observed_byte_length === null ||
            asNumber(row.observed_byte_length) !== verifiedLength
          ) {
            continue;
          }
          targets[row.provider_role] = Object.freeze({
            providerRole: row.provider_role,
            storageObjectCopyId: row.storage_object_copy_id,
            providerId: row.provider_id,
            bucketLabel: row.bucket_label,
            internalLocator: row.internal_locator,
            normalizedPrefixPattern: row.normalized_prefix_pattern,
            credentialSecretReferenceId: row.secret_reference_id,
          });
        }
        if (targets.hot === undefined && targets.canonical === undefined) {
          throw new ReadGrantError('not-ready', 'verified-read-copy-unavailable', 503, true);
        }
        return Object.freeze({
          grant,
          storageObjectId: grant.storageObjectId,
          mediaType: first.expected_content_type,
          byteLength: verifiedLength,
          checksumSha256: first.verified_checksum_sha256,
          targets: Object.freeze(targets),
        });
      });
    } catch (error) {
      return normalizeDatabaseError(error);
    }
  }

  async beginReadAttempt(input: {
    snapshot: Readonly<ReadDeliverySnapshot>;
    providerRole: ReadProviderRole;
    attemptNumber: number;
  }): Promise<string> {
    const target = input.snapshot.targets[input.providerRole];
    if (target === undefined) {
      throw new ReadGrantError('internal', 'read-target-missing', 500);
    }
    const providerAttemptId = this.#createId();
    try {
      await this.#scope.run(async (client) => {
        const now = this.#now();
        await client.query(
          `INSERT INTO public.storage_provider_attempts (
             storage_provider_attempt_id, storage_object_copy_id, storage_object_id,
             operation, operation_reference, attempt_number, state, retryable,
             expected_checksum_sha256, expected_byte_length, started_at, created_at, updated_at
           ) VALUES ($1, $2, $3, 'read', $4, $5, 'in_progress', false, $6, $7, $8, $8, $8)`,
          [
            providerAttemptId,
            target.storageObjectCopyId,
            input.snapshot.storageObjectId,
            `object-read-grant:${input.snapshot.grant.objectReadGrantId}`,
            input.attemptNumber,
            input.snapshot.checksumSha256,
            input.snapshot.byteLength,
            now,
          ],
        );
      });
      return providerAttemptId;
    } catch (error) {
      return normalizeDatabaseError(error);
    }
  }

  async finishReadAttempt(input: {
    providerAttemptId: string;
    succeeded: boolean;
    retryable?: boolean;
    observedByteLength?: number;
    diagnostic?: Readonly<SafeDiagnostic>;
  }): Promise<void> {
    requireUuid(input.providerAttemptId, 'provider-attempt-id');
    try {
      await this.#scope.run(async (client) => {
        const now = this.#now();
        const result = await client.query(
          `UPDATE public.storage_provider_attempts
              SET state = $2, retryable = $3, observed_byte_length = $4,
                  safe_diagnostic_category = $5, safe_diagnostic_code = $6,
                  finished_at = $7, updated_at = $7
            WHERE storage_provider_attempt_id = $1 AND state = 'in_progress'`,
          [
            input.providerAttemptId,
            input.succeeded ? 'succeeded' : 'failed',
            input.retryable ?? false,
            input.observedByteLength ?? null,
            input.diagnostic?.category ?? null,
            input.diagnostic?.code ?? null,
            now,
          ],
        );
        if (result.rowCount !== 1) {
          throw new ReadGrantError('duplicate-conflict', 'read-attempt-finish-conflict', 409);
        }
      });
    } catch (error) {
      return normalizeDatabaseError(error);
    }
  }

  async appendReadEvent(input: {
    snapshot: Readonly<ReadDeliverySnapshot>;
    eventType: string;
    deliveryState?: 'hot' | 'canonical-fallback';
    method: ObjectReadMethod;
    rangeRequested: boolean;
    diagnostic?: Readonly<SafeDiagnostic>;
  }): Promise<void> {
    requireSafeIdentifier(input.eventType, 'event-type', 96);
    try {
      await this.#scope.run(async (client) => {
        const now = this.#now();
        const payload: Record<string, unknown> = {
          objectReadGrantId: input.snapshot.grant.objectReadGrantId,
          method: input.method,
          rangeRequested: input.rangeRequested,
        };
        if (input.deliveryState !== undefined) payload.deliveryState = input.deliveryState;
        await client.query(
          `INSERT INTO public.storage_operation_events (
             storage_operation_event_id, dedupe_key, event_type, contract_version,
             occurred_at, managed_app_id, caller_service_id, storage_object_id,
             app_correlation_ref, safe_payload, safe_diagnostic_category,
             safe_diagnostic_code, created_at
           ) VALUES ($1, $2, $3, '1.0', $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $4)`,
          [
            this.#createId(),
            `${input.eventType}:${input.snapshot.grant.objectReadGrantId}:${this.#createId()}`,
            input.eventType,
            now,
            input.snapshot.grant.managedAppId,
            input.snapshot.grant.callerServiceId ?? null,
            input.snapshot.storageObjectId,
            input.snapshot.grant.appCorrelationReference,
            JSON.stringify(payload),
            input.diagnostic?.category ?? null,
            input.diagnostic?.code ?? null,
          ],
        );
      });
    } catch (error) {
      return normalizeDatabaseError(error);
    }
  }
}
