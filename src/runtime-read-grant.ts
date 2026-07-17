import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  CONTRACT_VERSION,
  PACKAGE_VERSION,
  SUPPORTED_CONTRACT_VERSIONS,
  type CallerIdentity,
  type ContractVersion,
  type HttpStorageRuntime,
  type ObjectReadGrantRequest,
  type ObjectReadGrantResult,
  type ObjectReadGrantRevocationResult,
  type SafeDiagnostic,
  type StorageRuntimeOptions,
} from './runtime-contract.js';
import {
  createHttpStorageRuntime,
  createSafeDiagnostic,
} from './runtime-service.js';
import {
  PostgresTransactionScope,
  asIso,
  asNumber,
  assertSafeJsonObject,
  parseDuplicateScope,
  requireSafeIdentifier,
  requireSha256,
  requireUuid,
} from './runtime-storage-registry-support.js';
import type {
  PostgresPoolLike,
  PostgresQueryable,
} from './runtime-storage-registry-types.js';
import type {
  ObjectReadDeliveryRegistry,
  ObjectReadDeliveryService,
  ObjectReadDeliverySnapshot,
  ObjectReadGrantDisposition,
  ObjectReadMethod,
  ReadGrantDeliveryAuthorization,
} from './runtime-read-delivery.js';

export const OBJECT_READ_GRANT_TOKEN_PURPOSE = 'object-read-grant' as const;

export interface ObjectReadGrantTokenClaims {
  tokenPurpose: typeof OBJECT_READ_GRANT_TOKEN_PURPOSE;
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

export interface ObjectReadGrantTokenExpectation {
  tokenPurpose?: typeof OBJECT_READ_GRANT_TOKEN_PURPOSE;
  objectReadGrantId?: string;
  storageObjectId?: string;
  callerAppId?: string;
  callerServiceId?: string;
  contractVersion?: ContractVersion;
  now?: Date;
}

export interface ObjectReadGrantTokenService {
  issue(claims: Readonly<ObjectReadGrantTokenClaims>): string | Promise<string>;
  verify(
    token: string,
    expected?: Readonly<ObjectReadGrantTokenExpectation>,
  ):
    | Readonly<ObjectReadGrantTokenClaims>
    | Promise<Readonly<ObjectReadGrantTokenClaims>>;
}

export class ObjectReadGrantTokenError extends Error {
  readonly category = 'unauthenticated' as const;
  readonly status = 401;
  readonly retryable = false;
  readonly code: 'invalid-object-read-grant-token' | 'object-read-grant-token-expired';

  constructor(code: ObjectReadGrantTokenError['code']) {
    super(code);
    this.name = 'ObjectReadGrantTokenError';
    this.code = code;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CALLER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,95}$/;
const SAFE_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,179}$/;

function rejectToken(): never {
  throw new ObjectReadGrantTokenError('invalid-object-read-grant-token');
}

function normalizeUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) rejectToken();
  return value;
}

function normalizeSafeId(value: unknown, pattern = SAFE_ID_PATTERN): string {
  if (typeof value !== 'string' || !pattern.test(value)) rejectToken();
  return value;
}

function normalizeIso(value: unknown): string {
  if (typeof value !== 'string') rejectToken();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) rejectToken();
  return value;
}

function normalizeAllowedMethods(value: unknown, reject: () => never): readonly ObjectReadMethod[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) reject();
  const methods = value.map((entry) => {
    if (entry !== 'HEAD' && entry !== 'GET') reject();
    return entry;
  });
  if (new Set(methods).size !== methods.length) reject();
  return Object.freeze(
    (['HEAD', 'GET'] as const).filter((method) => methods.includes(method)),
  );
}

function normalizeTokenClaims(value: unknown): Readonly<ObjectReadGrantTokenClaims> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) rejectToken();
  const record = value as Record<string, unknown>;
  if (record.tokenPurpose !== OBJECT_READ_GRANT_TOKEN_PURPOSE) rejectToken();
  if (record.contractVersion !== CONTRACT_VERSION) rejectToken();
  if (typeof record.allowRange !== 'boolean') rejectToken();
  const callerServiceId =
    record.callerServiceId === undefined
      ? undefined
      : normalizeSafeId(record.callerServiceId, SAFE_CALLER_PATTERN);
  const claims: ObjectReadGrantTokenClaims = {
    tokenPurpose: OBJECT_READ_GRANT_TOKEN_PURPOSE,
    objectReadGrantId: normalizeUuid(record.objectReadGrantId),
    storageObjectId: normalizeUuid(record.storageObjectId),
    callerAppId: normalizeSafeId(record.callerAppId, SAFE_CALLER_PATTERN),
    purpose: normalizeSafeId(record.purpose),
    allowedMethods: normalizeAllowedMethods(record.allowedMethods, rejectToken),
    allowRange: record.allowRange,
    contractVersion: CONTRACT_VERSION,
    expiresAt: normalizeIso(record.expiresAt),
  };
  if (callerServiceId !== undefined) claims.callerServiceId = callerServiceId;
  return Object.freeze(claims);
}

function encodeTokenPayload(claims: Readonly<ObjectReadGrantTokenClaims>): string {
  return Buffer.from(
    JSON.stringify({
      tokenPurpose: claims.tokenPurpose,
      objectReadGrantId: claims.objectReadGrantId,
      storageObjectId: claims.storageObjectId,
      callerAppId: claims.callerAppId,
      ...(claims.callerServiceId === undefined
        ? {}
        : { callerServiceId: claims.callerServiceId }),
      purpose: claims.purpose,
      allowedMethods: claims.allowedMethods,
      allowRange: claims.allowRange,
      contractVersion: claims.contractVersion,
      expiresAt: claims.expiresAt,
    }),
    'utf8',
  ).toString('base64url');
}

function assertExpectedToken(
  claims: Readonly<ObjectReadGrantTokenClaims>,
  expected: Readonly<ObjectReadGrantTokenExpectation>,
): void {
  if ((expected.tokenPurpose ?? OBJECT_READ_GRANT_TOKEN_PURPOSE) !== claims.tokenPurpose) rejectToken();
  if (
    expected.objectReadGrantId !== undefined &&
    expected.objectReadGrantId !== claims.objectReadGrantId
  ) {
    rejectToken();
  }
  if (expected.storageObjectId !== undefined && expected.storageObjectId !== claims.storageObjectId) {
    rejectToken();
  }
  if (expected.callerAppId !== undefined && expected.callerAppId !== claims.callerAppId) {
    rejectToken();
  }
  if (
    expected.callerServiceId !== undefined &&
    expected.callerServiceId !== (claims.callerServiceId ?? '')
  ) {
    rejectToken();
  }
  if (expected.contractVersion !== undefined && expected.contractVersion !== claims.contractVersion) {
    rejectToken();
  }
}

export function createDeterministicObjectReadGrantTokenService(options: {
  signingKey: string;
  now?: () => Date;
}): ObjectReadGrantTokenService {
  if (typeof options.signingKey !== 'string' || options.signingKey.length < 16) {
    throw new TypeError('signingKey must contain at least 16 characters.');
  }
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    issue(claimsInput: Readonly<ObjectReadGrantTokenClaims>): string {
      const claims = normalizeTokenClaims(claimsInput);
      const payload = encodeTokenPayload(claims);
      const signature = createHmac('sha256', options.signingKey)
        .update(payload)
        .digest('base64url');
      return `${payload}.${signature}`;
    },
    verify(
      token: string,
      expected: Readonly<ObjectReadGrantTokenExpectation> = {},
    ): Readonly<ObjectReadGrantTokenClaims> {
      if (typeof token !== 'string' || token.length < 32 || token.length > 4096) rejectToken();
      const segments = token.split('.');
      if (segments.length !== 2) rejectToken();
      const payload = segments[0];
      const supplied = segments[1];
      if (payload === undefined || supplied === undefined) rejectToken();
      const expectedSignature = createHmac('sha256', options.signingKey).update(payload).digest();
      let suppliedBytes: Buffer;
      try {
        suppliedBytes = Buffer.from(supplied, 'base64url');
      } catch {
        rejectToken();
      }
      if (
        suppliedBytes.length !== expectedSignature.length ||
        !timingSafeEqual(suppliedBytes, expectedSignature)
      ) {
        rejectToken();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      } catch {
        rejectToken();
      }
      const claims = normalizeTokenClaims(parsed);
      assertExpectedToken(claims, expected);
      const verificationTime = expected.now ?? now();
      if (new Date(claims.expiresAt).getTime() <= verificationTime.getTime()) {
        throw new ObjectReadGrantTokenError('object-read-grant-token-expired');
      }
      return claims;
    },
  });
}

export function objectReadGrantTokenDigest(token: string): string {
  if (typeof token !== 'string' || token.length < 32 || token.length > 4096) {
    throw new ObjectReadGrantTokenError('invalid-object-read-grant-token');
  }
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export type ObjectReadGrantState = 'active' | 'revoked' | 'expired';

export interface ObjectReadGrantSnapshot extends ReadGrantDeliveryAuthorization {
  managedAppId: string;
  callerAppId: string;
  callerServiceId?: string;
  appCorrelationReference: string;
  businessAuthorizationReference: string;
  tokenDigest: string;
  tokenPurpose: typeof OBJECT_READ_GRANT_TOKEN_PURPOSE;
  state: ObjectReadGrantState;
  revokedAt?: string;
  createdAt: string;
  updatedAt: string;
  rowVersion: number;
}

export interface ObjectReadGrantRegistry {
  execute<T>(input: {
    scope: string;
    key: string;
    fingerprint: string;
    operation: () => Promise<T>;
  }): Promise<Readonly<{ replayed: boolean; value: T }>>;
  createObjectReadGrant(input: {
    objectReadGrantId: string;
    storageObjectId: string;
    callerAppId: string;
    callerServiceId?: string;
    appCorrelationReference: string;
    businessAuthorizationReference: string;
    purpose: string;
    allowedMethods: readonly ObjectReadMethod[];
    allowRange: boolean;
    disposition: ObjectReadGrantDisposition;
    fileName?: string;
    tokenDigest: string;
    expiresAt: Date;
  }): Promise<Readonly<ObjectReadGrantSnapshot>>;
  getObjectReadGrant(input: {
    objectReadGrantId: string;
    storageObjectId: string;
    callerAppId: string;
    callerServiceId?: string;
    tokenDigest: string;
  }): Promise<Readonly<ObjectReadGrantSnapshot> | null>;
  revokeObjectReadGrant(input: {
    objectReadGrantId: string;
    callerAppId: string;
    callerServiceId?: string;
    appCorrelationReference: string;
  }): Promise<Readonly<ObjectReadGrantSnapshot>>;
}

interface ObjectReadGrantRow extends Record<string, unknown> {
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
  disposition: ObjectReadGrantDisposition;
  safe_file_name: string | null;
  read_grant_token_digest: string;
  token_purpose: typeof OBJECT_READ_GRANT_TOKEN_PURPOSE;
  state: ObjectReadGrantState;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  row_version: number;
}

export interface PostgresObjectReadRegistryOptions {
  pool: PostgresPoolLike;
  now?: () => Date;
  createId?: () => string;
  idempotencyReservationTtlMs?: number;
}

function mapGrantRow(row: ObjectReadGrantRow): Readonly<ObjectReadGrantSnapshot> {
  const methods = normalizeAllowedMethods(row.allowed_methods, () => {
    throw new Error('invalid-object-read-grant-methods');
  });
  const result: ObjectReadGrantSnapshot = {
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
    tokenDigest: row.read_grant_token_digest,
    tokenPurpose: row.token_purpose,
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

const GRANT_SELECT = `SELECT grant.object_read_grant_id, grant.storage_object_id,
       grant.managed_app_id, managed_app.app_id AS caller_app_id, grant.caller_service_id,
       grant.app_correlation_ref, grant.business_authorization_ref, grant.purpose,
       grant.allowed_methods, grant.range_allowed, grant.disposition, grant.safe_file_name,
       grant.read_grant_token_digest, grant.token_purpose, grant.state, grant.expires_at,
       grant.revoked_at, grant.created_at, grant.updated_at, grant.row_version
  FROM public.object_read_grants AS grant
  JOIN public.managed_apps AS managed_app ON managed_app.id = grant.managed_app_id`;

export class PostgresObjectReadRegistry
  implements ObjectReadGrantRegistry, ObjectReadDeliveryRegistry
{
  readonly #scope: PostgresTransactionScope;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #idempotencyReservationTtlMs: number;

  constructor(options: PostgresObjectReadRegistryOptions) {
    this.#scope = new PostgresTransactionScope(options.pool);
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#idempotencyReservationTtlMs = options.idempotencyReservationTtlMs ?? 5 * 60_000;
  }

  async execute<T>(input: {
    scope: string;
    key: string;
    fingerprint: string;
    operation: () => Promise<T>;
  }): Promise<Readonly<{ replayed: boolean; value: T }>> {
    const parsedScope = parseDuplicateScope(input.scope);
    const key = requireSafeIdentifier(input.key, 'duplicate-protection-key');
    const requestFingerprint = requireSha256(input.fingerprint, 'request-fingerprint');
    return this.#scope.run(async (client) => {
      const now = this.#now();
      const expiresAt = new Date(now.getTime() + this.#idempotencyReservationTtlMs);
      const recordId = this.#createId();
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO public.storage_idempotency_records (
           id, caller_app_id, caller_service_id, operation_scope, idempotency_key,
           request_fingerprint, state, expires_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'in_progress', $7, $8, $8)
         ON CONFLICT (caller_app_id, caller_service_id, operation_scope, idempotency_key)
         DO NOTHING
         RETURNING id`,
        [
          recordId,
          parsedScope.callerAppId,
          parsedScope.callerServiceId,
          parsedScope.operationScope,
          key,
          requestFingerprint,
          expiresAt,
          now,
        ],
      );
      const existing = await client.query<{
        request_fingerprint: string;
        state: 'in_progress' | 'succeeded' | 'failed';
        result_kind: string | null;
        result_reference_id: string | null;
        result_storage_object_id: string | null;
        expires_at: Date | string;
      }>(
        `SELECT request_fingerprint, state, result_kind, result_reference_id,
                result_storage_object_id, expires_at
           FROM public.storage_idempotency_records
          WHERE caller_app_id = $1 AND caller_service_id = $2
            AND operation_scope = $3 AND idempotency_key = $4
          FOR UPDATE`,
        [parsedScope.callerAppId, parsedScope.callerServiceId, parsedScope.operationScope, key],
      );
      const row = existing.rows[0];
      if (row === undefined) throw registryError('internal', 'idempotency-record-missing', 500);
      if (row.request_fingerprint !== requestFingerprint) {
        throw registryError('duplicate-conflict', 'idempotency-key-reused', 409);
      }
      if (inserted.rowCount === 0 && row.state === 'succeeded') {
        if (row.result_kind === null || row.result_reference_id === null) {
          throw registryError('internal', 'idempotency-result-missing', 500);
        }
        const decoded = await this.#decodeResult(
          client,
          row.result_kind,
          row.result_reference_id,
          row.result_storage_object_id,
        );
        return Object.freeze({ replayed: true, value: decoded as T });
      }
      if (inserted.rowCount === 0 && row.state === 'in_progress' && new Date(row.expires_at) > now) {
        throw registryError(
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
                  result_storage_object_id = NULL, expires_at = $5, updated_at = $6
            WHERE caller_app_id = $1 AND caller_service_id = $2
              AND operation_scope = $3 AND idempotency_key = $4`,
          [
            parsedScope.callerAppId,
            parsedScope.callerServiceId,
            parsedScope.operationScope,
            key,
            expiresAt,
            now,
          ],
        );
      }
      const value = await input.operation();
      const reference = this.#encodeResult(value);
      await client.query(
        `UPDATE public.storage_idempotency_records
            SET state = 'succeeded', result_kind = $5, result_reference_id = $6,
                result_storage_object_id = $7, updated_at = $8
          WHERE caller_app_id = $1 AND caller_service_id = $2
            AND operation_scope = $3 AND idempotency_key = $4`,
        [
          parsedScope.callerAppId,
          parsedScope.callerServiceId,
          parsedScope.operationScope,
          key,
          reference.resultKind,
          reference.resultReferenceId,
          reference.storageObjectId,
          now,
        ],
      );
      return Object.freeze({ replayed: false, value });
    });
  }

  #encodeResult(value: unknown): {
    resultKind: 'object-read-grant' | 'object-read-grant-revocation';
    resultReferenceId: string;
    storageObjectId: string;
  } {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw registryError('internal', 'invalid-idempotency-result', 500);
    }
    const record = value as Record<string, unknown>;
    const resultReferenceId = requireUuid(
      typeof record.objectReadGrantId === 'string' ? record.objectReadGrantId : '',
      'duplicate-result-read-grant',
    );
    const storageObjectId = requireUuid(
      typeof record.storageObjectId === 'string' ? record.storageObjectId : '',
      'duplicate-result-storage-object',
    );
    const state = record.state;
    if (state !== 'active' && state !== 'revoked' && state !== 'expired') {
      throw registryError('internal', 'unsupported-idempotency-result', 500);
    }
    return {
      resultKind: state === 'active' ? 'object-read-grant' : 'object-read-grant-revocation',
      resultReferenceId,
      storageObjectId,
    };
  }

  async #decodeResult(
    client: PostgresQueryable,
    resultKind: string,
    resultReferenceId: string,
    storageObjectId: string | null,
  ): Promise<Readonly<ObjectReadGrantSnapshot>> {
    if (resultKind !== 'object-read-grant' && resultKind !== 'object-read-grant-revocation') {
      throw registryError('internal', 'unsupported-idempotency-result-kind', 500);
    }
    const grantId = requireUuid(resultReferenceId, 'duplicate-result-read-grant');
    const objectId = requireUuid(storageObjectId ?? '', 'duplicate-result-storage-object');
    const result = await client.query<ObjectReadGrantRow>(
      `${GRANT_SELECT}
        WHERE grant.object_read_grant_id = $1 AND grant.storage_object_id = $2`,
      [grantId, objectId],
    );
    const row = result.rows[0];
    if (row === undefined) throw registryError('internal', 'idempotency-result-missing', 500);
    const snapshot = mapGrantRow(row);
    if (
      resultKind === 'object-read-grant' &&
      (snapshot.state !== 'active' || new Date(snapshot.expiresAt) <= this.#now())
    ) {
      throw registryError('duplicate-conflict', 'object-read-grant-replay-not-active', 409);
    }
    return snapshot;
  }

  async createObjectReadGrant(input: {
    objectReadGrantId: string;
    storageObjectId: string;
    callerAppId: string;
    callerServiceId?: string;
    appCorrelationReference: string;
    businessAuthorizationReference: string;
    purpose: string;
    allowedMethods: readonly ObjectReadMethod[];
    allowRange: boolean;
    disposition: ObjectReadGrantDisposition;
    fileName?: string;
    tokenDigest: string;
    expiresAt: Date;
  }): Promise<Readonly<ObjectReadGrantSnapshot>> {
    requireUuid(input.objectReadGrantId, 'object-read-grant-id');
    requireUuid(input.storageObjectId, 'storage-object-id');
    requireSha256(input.tokenDigest, 'read-grant-token-digest');
    return this.#scope.run(async (client) => {
      const authority = await client.query<{
        managed_app_id: string;
        caller_app_id: string;
        managed_app_status: string;
        profile_status: string;
        registry_state: string;
        verified_checksum_sha256: string | null;
        verified_byte_length: string | number | null;
        usable_copy_count: string | number;
      }>(
        `SELECT object_record.managed_app_id, managed_app.app_id AS caller_app_id,
                managed_app.status AS managed_app_status, profile.status AS profile_status,
                object_record.registry_state, object_record.verified_checksum_sha256,
                object_record.verified_byte_length,
                (SELECT count(*) FROM public.storage_object_copies AS copy
                  WHERE copy.storage_object_id = object_record.storage_object_id
                    AND copy.copy_state = 'verified'
                    AND copy.observed_checksum_sha256 = object_record.verified_checksum_sha256
                    AND copy.observed_byte_length = object_record.verified_byte_length) AS usable_copy_count
           FROM public.storage_objects AS object_record
           JOIN public.managed_apps AS managed_app ON managed_app.id = object_record.managed_app_id
           JOIN public.storage_profiles AS profile ON profile.id = object_record.storage_profile_id
          WHERE object_record.storage_object_id = $1
          FOR SHARE OF object_record, managed_app, profile`,
        [input.storageObjectId],
      );
      const row = authority.rows[0];
      if (row === undefined) throw registryError('not-ready', 'storage-object-not-found', 404);
      if (row.caller_app_id !== input.callerAppId) {
        throw registryError('unauthorized', 'storage-object-scope-mismatch', 403);
      }
      if (row.managed_app_status !== 'active' || row.profile_status !== 'active') {
        throw registryError('not-ready', 'storage-profile-not-ready', 503, true);
      }
      if (row.registry_state !== 'active' && row.registry_state !== 'degraded') {
        throw registryError('not-ready', 'storage-object-not-ready', 409, true);
      }
      if (
        row.verified_checksum_sha256 === null ||
        row.verified_byte_length === null ||
        asNumber(row.usable_copy_count) < 1
      ) {
        throw registryError('not-ready', 'storage-object-unverified', 409);
      }
      const now = this.#now();
      await client.query(
        `INSERT INTO public.object_read_grants (
           object_read_grant_id, storage_object_id, managed_app_id, caller_service_id,
           app_correlation_ref, business_authorization_ref, purpose, allowed_methods,
           range_allowed, disposition, safe_file_name, read_grant_token_digest,
           token_purpose, state, expires_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, $12,
                   $13, 'active', $14, $15, $15)`,
        [
          input.objectReadGrantId,
          input.storageObjectId,
          row.managed_app_id,
          input.callerServiceId ?? null,
          input.appCorrelationReference,
          input.businessAuthorizationReference,
          input.purpose,
          input.allowedMethods,
          input.allowRange,
          input.disposition,
          input.fileName ?? null,
          input.tokenDigest,
          OBJECT_READ_GRANT_TOKEN_PURPOSE,
          input.expiresAt,
          now,
        ],
      );
      await this.#insertEvent(client, {
        eventType: 'object-read-grant-issued',
        dedupeKey: `object-read-grant-issued:${input.objectReadGrantId}`,
        managedAppId: row.managed_app_id,
        ...(input.callerServiceId === undefined ? {} : { callerServiceId: input.callerServiceId }),
        storageObjectId: input.storageObjectId,
        appCorrelationReference: input.appCorrelationReference,
        payload: Object.freeze({
          objectReadGrantId: input.objectReadGrantId,
          allowedMethods: input.allowedMethods,
          rangeAllowed: input.allowRange,
          state: 'active',
        }),
        occurredAt: now,
      });
      return this.#readGrant(client, input.objectReadGrantId);
    });
  }

  async getObjectReadGrant(input: {
    objectReadGrantId: string;
    storageObjectId: string;
    callerAppId: string;
    callerServiceId?: string;
    tokenDigest: string;
  }): Promise<Readonly<ObjectReadGrantSnapshot> | null> {
    requireUuid(input.objectReadGrantId, 'object-read-grant-id');
    requireUuid(input.storageObjectId, 'storage-object-id');
    requireSha256(input.tokenDigest, 'read-grant-token-digest');
    return this.#scope.run(async (client) => {
      const now = this.#now();
      await client.query(
        `UPDATE public.object_read_grants
            SET state = 'expired', updated_at = $2, row_version = row_version + 1
          WHERE object_read_grant_id = $1 AND state = 'active' AND expires_at <= $2`,
        [input.objectReadGrantId, now],
      );
      const result = await client.query<ObjectReadGrantRow>(
        `${GRANT_SELECT}
          WHERE grant.object_read_grant_id = $1
            AND grant.storage_object_id = $2
            AND managed_app.app_id = $3
            AND COALESCE(grant.caller_service_id, '') = $4
            AND grant.read_grant_token_digest = $5`,
        [
          input.objectReadGrantId,
          input.storageObjectId,
          input.callerAppId,
          input.callerServiceId ?? '',
          input.tokenDigest,
        ],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapGrantRow(row);
    });
  }

  async revokeObjectReadGrant(input: {
    objectReadGrantId: string;
    callerAppId: string;
    callerServiceId?: string;
    appCorrelationReference: string;
  }): Promise<Readonly<ObjectReadGrantSnapshot>> {
    requireUuid(input.objectReadGrantId, 'object-read-grant-id');
    return this.#scope.run(async (client) => {
      const currentResult = await client.query<ObjectReadGrantRow>(
        `${GRANT_SELECT}
          WHERE grant.object_read_grant_id = $1
          FOR UPDATE OF grant`,
        [input.objectReadGrantId],
      );
      const currentRow = currentResult.rows[0];
      if (
        currentRow === undefined ||
        currentRow.caller_app_id !== input.callerAppId ||
        (currentRow.caller_service_id ?? '') !== (input.callerServiceId ?? '')
      ) {
        throw registryError('unauthorized', 'object-read-grant-scope-mismatch', 403);
      }
      const current = mapGrantRow(currentRow);
      if (current.state !== 'active') return current;
      const now = this.#now();
      const expired = new Date(current.expiresAt) <= now;
      const nextState: 'expired' | 'revoked' = expired ? 'expired' : 'revoked';
      const update = await client.query(
        `UPDATE public.object_read_grants
            SET state = $2, revoked_at = CASE WHEN $2 = 'revoked' THEN $3 ELSE NULL END,
                updated_at = $3, row_version = row_version + 1
          WHERE object_read_grant_id = $1 AND state = 'active' AND row_version = $4`,
        [input.objectReadGrantId, nextState, now, current.rowVersion],
      );
      if (update.rowCount !== 1) {
        throw registryError('duplicate-conflict', 'object-read-grant-version-conflict', 409);
      }
      await this.#insertEvent(client, {
        eventType: nextState === 'revoked' ? 'object-read-grant-revoked' : 'object-read-grant-expired',
        dedupeKey: `object-read-grant-${nextState}:${input.objectReadGrantId}`,
        managedAppId: current.managedAppId,
        ...(input.callerServiceId === undefined ? {} : { callerServiceId: input.callerServiceId }),
        storageObjectId: current.storageObjectId,
        appCorrelationReference: input.appCorrelationReference,
        payload: Object.freeze({
          objectReadGrantId: input.objectReadGrantId,
          state: nextState,
        }),
        occurredAt: now,
      });
      return this.#readGrant(client, input.objectReadGrantId);
    });
  }

  async getObjectReadDeliverySnapshot(input: {
    storageObjectId: string;
    callerAppId: string;
    callerServiceId?: string;
  }): Promise<Readonly<ObjectReadDeliverySnapshot> | null> {
    requireUuid(input.storageObjectId, 'storage-object-id');
    return this.#scope.run(async (client) => {
      const result = await client.query<{
        storage_object_id: string;
        caller_app_id: string;
        registry_state: ObjectReadDeliverySnapshot['registryState'];
        object_protection_stage: string;
        verified_checksum_sha256: string | null;
        verified_byte_length: string | number | null;
        expected_content_type: string;
        hot_storage_object_copy_id: string;
        hot_copy_state: ObjectReadDeliverySnapshot['copies']['hot']['state'];
        hot_observed_checksum_sha256: string | null;
        hot_observed_byte_length: string | number | null;
        hot_latest_verified_at: Date | string | null;
        hot_provider_id: string;
        hot_bucket_label: string;
        hot_internal_locator: string;
        hot_secret_reference_id: string;
        canonical_storage_object_copy_id: string;
        canonical_copy_state: ObjectReadDeliverySnapshot['copies']['canonical']['state'];
        canonical_observed_checksum_sha256: string | null;
        canonical_observed_byte_length: string | number | null;
        canonical_latest_verified_at: Date | string | null;
        canonical_provider_id: string;
        canonical_bucket_label: string;
        canonical_internal_locator: string;
        canonical_secret_reference_id: string;
      }>(
        `SELECT object_record.storage_object_id, managed_app.app_id AS caller_app_id,
                object_record.registry_state, object_record.object_protection_stage,
                object_record.verified_checksum_sha256, object_record.verified_byte_length,
                object_record.expected_content_type,
                hot_copy.storage_object_copy_id AS hot_storage_object_copy_id,
                hot_copy.copy_state AS hot_copy_state,
                hot_copy.observed_checksum_sha256 AS hot_observed_checksum_sha256,
                hot_copy.observed_byte_length AS hot_observed_byte_length,
                hot_copy.latest_verified_at AS hot_latest_verified_at,
                hot_provider.provider_id AS hot_provider_id,
                hot_binding.bucket_label AS hot_bucket_label,
                hot_copy.internal_locator AS hot_internal_locator,
                hot_provider.secret_reference_id AS hot_secret_reference_id,
                canonical_copy.storage_object_copy_id AS canonical_storage_object_copy_id,
                canonical_copy.copy_state AS canonical_copy_state,
                canonical_copy.observed_checksum_sha256 AS canonical_observed_checksum_sha256,
                canonical_copy.observed_byte_length AS canonical_observed_byte_length,
                canonical_copy.latest_verified_at AS canonical_latest_verified_at,
                canonical_provider.provider_id AS canonical_provider_id,
                canonical_binding.bucket_label AS canonical_bucket_label,
                canonical_copy.internal_locator AS canonical_internal_locator,
                canonical_provider.secret_reference_id AS canonical_secret_reference_id
           FROM public.storage_objects AS object_record
           JOIN public.managed_apps AS managed_app ON managed_app.id = object_record.managed_app_id
           JOIN public.storage_object_copies AS hot_copy
             ON hot_copy.storage_object_id = object_record.storage_object_id
            AND hot_copy.provider_role = 'hot'
           JOIN public.storage_profile_provider_bindings AS hot_binding
             ON hot_binding.id = hot_copy.storage_profile_provider_binding_id
           JOIN public.storage_providers AS hot_provider
             ON hot_provider.id = hot_binding.storage_provider_id AND hot_provider.status = 'active'
           JOIN public.storage_object_copies AS canonical_copy
             ON canonical_copy.storage_object_id = object_record.storage_object_id
            AND canonical_copy.provider_role = 'canonical'
           JOIN public.storage_profile_provider_bindings AS canonical_binding
             ON canonical_binding.id = canonical_copy.storage_profile_provider_binding_id
           JOIN public.storage_providers AS canonical_provider
             ON canonical_provider.id = canonical_binding.storage_provider_id
            AND canonical_provider.status = 'active'
          WHERE object_record.storage_object_id = $1 AND managed_app.app_id = $2`,
        [input.storageObjectId, input.callerAppId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const copy = (
        role: 'hot' | 'canonical',
        values: {
          id: string;
          state: ObjectReadDeliverySnapshot['copies']['hot']['state'];
          checksum: string | null;
          length: string | number | null;
          verifiedAt: Date | string | null;
          providerId: string;
          bucketLabel: string;
          locator: string;
          secretReferenceId: string;
        },
      ) => Object.freeze({
        storageObjectCopyId: values.id,
        providerRole: role,
        state: values.state,
        ...(values.checksum === null ? {} : { observedChecksumSha256: values.checksum }),
        ...(values.length === null ? {} : { observedByteLength: asNumber(values.length) }),
        ...(values.verifiedAt === null ? {} : { latestVerifiedAt: asIso(values.verifiedAt) }),
        target: Object.freeze({
          providerRole: role,
          providerId: values.providerId,
          bucketLabel: values.bucketLabel,
          internalLocator: values.locator,
          credentialSecretReferenceId: values.secretReferenceId,
        }),
      });
      return Object.freeze({
        storageObjectId: row.storage_object_id,
        callerAppId: row.caller_app_id,
        registryState: row.registry_state,
        objectProtectionStage: row.object_protection_stage,
        ...(row.verified_checksum_sha256 === null
          ? {}
          : { verifiedChecksumSha256: row.verified_checksum_sha256 }),
        ...(row.verified_byte_length === null
          ? {}
          : { verifiedByteLength: asNumber(row.verified_byte_length) }),
        verifiedContentType: row.expected_content_type,
        copies: Object.freeze({
          hot: copy('hot', {
            id: row.hot_storage_object_copy_id,
            state: row.hot_copy_state,
            checksum: row.hot_observed_checksum_sha256,
            length: row.hot_observed_byte_length,
            verifiedAt: row.hot_latest_verified_at,
            providerId: row.hot_provider_id,
            bucketLabel: row.hot_bucket_label,
            locator: row.hot_internal_locator,
            secretReferenceId: row.hot_secret_reference_id,
          }),
          canonical: copy('canonical', {
            id: row.canonical_storage_object_copy_id,
            state: row.canonical_copy_state,
            checksum: row.canonical_observed_checksum_sha256,
            length: row.canonical_observed_byte_length,
            verifiedAt: row.canonical_latest_verified_at,
            providerId: row.canonical_provider_id,
            bucketLabel: row.canonical_bucket_label,
            locator: row.canonical_internal_locator,
            secretReferenceId: row.canonical_secret_reference_id,
          }),
        }),
      });
    });
  }

  async beginObjectReadAttempt(input: {
    storageObjectCopyId: string;
    storageObjectId: string;
    operationReference: string;
    expectedChecksumSha256: string;
    expectedByteLength: number;
  }): Promise<Readonly<{ providerAttemptId: string }>> {
    requireUuid(input.storageObjectCopyId, 'storage-object-copy-id');
    requireUuid(input.storageObjectId, 'storage-object-id');
    requireSha256(input.expectedChecksumSha256, 'expected-checksum-sha256');
    const providerAttemptId = this.#createId();
    await this.#scope.run(async (client) => {
      const now = this.#now();
      await client.query(
        `INSERT INTO public.storage_provider_attempts (
           storage_provider_attempt_id, storage_object_copy_id, storage_object_id,
           operation, operation_reference, attempt_number, state, retryable,
           expected_checksum_sha256, expected_byte_length, started_at, created_at, updated_at
         ) VALUES ($1, $2, $3, 'read', $4, 1, 'in_progress', false, $5, $6, $7, $7, $7)`,
        [
          providerAttemptId,
          input.storageObjectCopyId,
          input.storageObjectId,
          input.operationReference,
          input.expectedChecksumSha256,
          input.expectedByteLength,
          now,
        ],
      );
    });
    return Object.freeze({ providerAttemptId });
  }

  async finishObjectReadAttempt(input: {
    providerAttemptId: string;
    nextState: 'succeeded' | 'failed';
    observedByteLength?: number;
    diagnostic?: Readonly<SafeDiagnostic>;
  }): Promise<void> {
    requireUuid(input.providerAttemptId, 'provider-attempt-id');
    await this.#scope.run(async (client) => {
      const now = this.#now();
      const result = await client.query(
        `UPDATE public.storage_provider_attempts
            SET state = $2, retryable = $3, observed_byte_length = $4,
                safe_diagnostic_category = $5, safe_diagnostic_code = $6,
                finished_at = $7, updated_at = $7
          WHERE storage_provider_attempt_id = $1 AND operation = 'read'
            AND state = 'in_progress'`,
        [
          input.providerAttemptId,
          input.nextState,
          input.diagnostic?.retryable ?? false,
          input.observedByteLength ?? null,
          input.diagnostic?.category ?? null,
          input.diagnostic?.code ?? null,
          now,
        ],
      );
      if (result.rowCount !== 1) {
        throw registryError('duplicate-conflict', 'read-attempt-state-conflict', 409);
      }
    });
  }

  async appendObjectReadEvent(input: {
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
  }): Promise<void> {
    assertSafeJsonObject(input.payload, 'object-read-event-payload');
    await this.#scope.run(async (client) => {
      const managedApp = await client.query<{ id: string }>(
        `SELECT id FROM public.managed_apps WHERE app_id = $1 AND status = 'active'`,
        [input.callerAppId],
      );
      const row = managedApp.rows[0];
      if (row === undefined) throw registryError('unauthorized', 'invalid-caller', 403);
      await this.#insertEvent(client, {
        eventId: input.eventId,
        eventType: input.eventType,
        dedupeKey: input.dedupeKey,
        managedAppId: row.id,
        ...(input.callerServiceId === undefined
          ? {}
          : { callerServiceId: input.callerServiceId }),
        storageObjectId: input.storageObjectId,
        appCorrelationReference: input.appCorrelationReference,
        payload: input.payload,
        ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
        occurredAt: input.occurredAt,
      });
    });
  }

  async #readGrant(
    client: PostgresQueryable,
    objectReadGrantId: string,
  ): Promise<Readonly<ObjectReadGrantSnapshot>> {
    const result = await client.query<ObjectReadGrantRow>(
      `${GRANT_SELECT}
        WHERE grant.object_read_grant_id = $1`,
      [objectReadGrantId],
    );
    const row = result.rows[0];
    if (row === undefined) throw registryError('internal', 'object-read-grant-missing', 500);
    return mapGrantRow(row);
  }

  async #insertEvent(
    client: PostgresQueryable,
    input: {
      eventId?: string;
      dedupeKey: string;
      eventType: string;
      occurredAt: Date;
      managedAppId: string;
      callerServiceId?: string;
      storageObjectId: string;
      appCorrelationReference: string;
      payload: Readonly<Record<string, unknown>>;
      diagnostic?: Readonly<SafeDiagnostic>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO public.storage_operation_events (
         storage_operation_event_id, dedupe_key, event_type, contract_version, occurred_at,
         managed_app_id, caller_service_id, storage_object_id, app_correlation_ref,
         safe_payload, safe_diagnostic_category, safe_diagnostic_code, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        input.eventId ?? this.#createId(),
        input.dedupeKey,
        input.eventType,
        CONTRACT_VERSION,
        input.occurredAt,
        input.managedAppId,
        input.callerServiceId ?? null,
        input.storageObjectId,
        input.appCorrelationReference,
        JSON.stringify(input.payload),
        input.diagnostic?.category ?? null,
        input.diagnostic?.code ?? null,
        this.#now(),
      ],
    );
  }
}

class ObjectReadRegistryError extends Error {
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
    this.name = 'ObjectReadRegistryError';
    this.category = category;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function registryError(
  category: SafeDiagnostic['category'],
  code: string,
  status: number,
  retryable = false,
): ObjectReadRegistryError {
  return new ObjectReadRegistryError(category, code, status, retryable);
}

class ObjectReadHttpError extends Error {
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
    this.name = 'ObjectReadHttpError';
    this.category = category;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (headers !== undefined) this.headers = headers;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(
  value: unknown,
  code: string,
  options: { min?: number; max?: number; pattern?: RegExp; trim?: boolean } = {},
): string {
  if (typeof value !== 'string') throw new ObjectReadHttpError('invalid-request', code, 400);
  const normalized = options.trim === false ? value : value.trim();
  if (
    normalized.length < (options.min ?? 1) ||
    normalized.length > (options.max ?? 256) ||
    (options.pattern !== undefined && !options.pattern.test(normalized))
  ) {
    throw new ObjectReadHttpError('invalid-request', code, 400);
  }
  return normalized;
}

function requireHttpUuid(value: unknown, code: string): string {
  return requireString(value, code, { min: 36, max: 36, pattern: UUID_PATTERN });
}

function parseGrantRequest(value: unknown): Readonly<ObjectReadGrantRequest> {
  if (!isRecord(value)) {
    throw new ObjectReadHttpError('invalid-request', 'invalid-object-read-grant', 400);
  }
  const methods = normalizeAllowedMethods(value.allowedMethods, () => {
    throw new ObjectReadHttpError('invalid-request', 'invalid-allowed-methods', 400);
  });
  if (typeof value.allowRange !== 'boolean') {
    throw new ObjectReadHttpError('invalid-request', 'invalid-allow-range', 400);
  }
  if (value.disposition !== 'inline' && value.disposition !== 'attachment') {
    throw new ObjectReadHttpError('invalid-request', 'invalid-disposition', 400);
  }
  if (
    !Number.isSafeInteger(value.requestedTtlSeconds) ||
    (value.requestedTtlSeconds as number) < 30 ||
    (value.requestedTtlSeconds as number) > 300
  ) {
    throw new ObjectReadHttpError('invalid-request', 'invalid-requested-ttl-seconds', 400);
  }
  const result: ObjectReadGrantRequest = {
    storageObjectId: requireHttpUuid(value.storageObjectId, 'invalid-storage-object-id'),
    purpose: requireString(value.purpose, 'invalid-purpose', {
      max: 128,
      pattern: SAFE_ID_PATTERN,
    }),
    allowedMethods: methods,
    allowRange: value.allowRange,
    disposition: value.disposition,
    requestedTtlSeconds: value.requestedTtlSeconds as number,
    businessAuthorizationReference: requireString(
      value.businessAuthorizationReference,
      'invalid-business-authorization-reference',
      { max: 256, pattern: /^[^\u0000-\u001f\u007f]+$/ },
    ),
  };
  if (value.fileName !== undefined && value.fileName !== null) {
    const fileName = requireString(value.fileName, 'invalid-file-name', {
      max: 180,
      pattern: SAFE_FILE_NAME_PATTERN,
    });
    if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
      throw new ObjectReadHttpError('invalid-request', 'invalid-file-name', 400);
    }
    result.fileName = fileName;
  }
  return Object.freeze(result);
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

function json(
  body: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function requiredHeader(request: Request, name: string, code: string, max = 256): string {
  return requireString(request.headers.get(name), code, { max });
}

function contractVersion(request: Request): ContractVersion {
  const value = requiredHeader(request, 'x-zs-contract-version', 'invalid-contract-version', 16);
  if (!SUPPORTED_CONTRACT_VERSIONS.includes(value as ContractVersion)) {
    throw new ObjectReadHttpError(
      'incompatible-version',
      'unsupported-contract-version',
      409,
    );
  }
  return value as ContractVersion;
}

function bearerToken(request: Request): string {
  const value = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(value);
  if (match?.[1] === undefined || match[1].trim() === '') {
    throw new ObjectReadHttpError('unauthenticated', 'authentication-required', 401);
  }
  return match[1].trim();
}

function normalizeCaller(value: unknown): Readonly<CallerIdentity> {
  if (!isRecord(value)) throw new ObjectReadHttpError('unauthenticated', 'authentication-required', 401);
  const appId = requireString(value.appId, 'invalid-caller', {
    max: 96,
    pattern: SAFE_CALLER_PATTERN,
  });
  if (value.serviceId === undefined || value.serviceId === null) return Object.freeze({ appId });
  return Object.freeze({
    appId,
    serviceId: requireString(value.serviceId, 'invalid-caller', {
      max: 96,
      pattern: SAFE_CALLER_PATTERN,
    }),
  });
}

async function authenticateAndAuthorize(
  request: Request,
  options: StorageRuntimeOptions,
): Promise<Readonly<CallerIdentity>> {
  let caller: Readonly<CallerIdentity>;
  try {
    caller = normalizeCaller(await options.authenticate(bearerToken(request)));
  } catch (error) {
    if (error instanceof ObjectReadHttpError) throw error;
    throw new ObjectReadHttpError('unauthenticated', 'authentication-failed', 401);
  }
  const claimedApp = requiredHeader(request, 'x-zs-caller-app', 'invalid-caller', 96);
  if (claimedApp !== caller.appId) {
    throw new ObjectReadHttpError('unauthorized', 'invalid-caller', 403);
  }
  let allowed = false;
  try {
    allowed = (await options.authorizeCaller(caller)) === true;
  } catch {
    allowed = false;
  }
  if (!allowed) throw new ObjectReadHttpError('unauthorized', 'invalid-caller', 403);
  return caller;
}

function duplicateKey(request: Request): string {
  return requireString(request.headers.get('idempotency-key'), 'invalid-duplicate-protection-key', {
    max: 128,
    pattern: SAFE_ID_PATTERN,
  });
}

function correlationReference(request: Request): string {
  return requireString(
    request.headers.get('x-app-correlation-reference'),
    'invalid-app-correlation-reference',
    { max: 128, pattern: SAFE_ID_PATTERN },
  );
}

function callerScope(caller: Readonly<CallerIdentity>, operation: string): string {
  return `${caller.appId}:${caller.serviceId ?? ''}:${operation}`;
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new ObjectReadHttpError('invalid-request', 'json-content-type-required', 415);
  }
  try {
    return await request.json();
  } catch {
    throw new ObjectReadHttpError('invalid-request', 'invalid-json', 400);
  }
}

function tokenClaimsFromGrant(grant: Readonly<ObjectReadGrantSnapshot>): ObjectReadGrantTokenClaims {
  const claims: ObjectReadGrantTokenClaims = {
    tokenPurpose: OBJECT_READ_GRANT_TOKEN_PURPOSE,
    objectReadGrantId: grant.objectReadGrantId,
    storageObjectId: grant.storageObjectId,
    callerAppId: grant.callerAppId,
    purpose: grant.purpose,
    allowedMethods: grant.allowedMethods,
    allowRange: grant.allowRange,
    contractVersion: CONTRACT_VERSION,
    expiresAt: grant.expiresAt,
  };
  if (grant.callerServiceId !== undefined) claims.callerServiceId = grant.callerServiceId;
  return claims;
}

function exactGrantBinding(
  claims: Readonly<ObjectReadGrantTokenClaims>,
  grant: Readonly<ObjectReadGrantSnapshot>,
): boolean {
  return (
    claims.objectReadGrantId === grant.objectReadGrantId &&
    claims.storageObjectId === grant.storageObjectId &&
    claims.callerAppId === grant.callerAppId &&
    (claims.callerServiceId ?? '') === (grant.callerServiceId ?? '') &&
    claims.purpose === grant.purpose &&
    claims.allowRange === grant.allowRange &&
    claims.contractVersion === CONTRACT_VERSION &&
    claims.expiresAt === grant.expiresAt &&
    claims.allowedMethods.length === grant.allowedMethods.length &&
    claims.allowedMethods.every((method, index) => method === grant.allowedMethods[index])
  );
}

function normalizeExternalError(error: unknown): ObjectReadHttpError {
  if (error instanceof ObjectReadHttpError) return error;
  if (error instanceof ObjectReadGrantTokenError) {
    return new ObjectReadHttpError(error.category, error.code, error.status, error.retryable);
  }
  if (error !== null && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (
      typeof record.category === 'string' &&
      typeof record.code === 'string' &&
      typeof record.status === 'number' &&
      Number.isSafeInteger(record.status) &&
      record.status >= 400 &&
      record.status <= 599 &&
      /^[a-z0-9][a-z0-9-]{0,95}$/.test(record.code)
    ) {
      const category = record.category as SafeDiagnostic['category'];
      const headerEntries = isRecord(record.headers)
        ? Object.entries(record.headers).filter(
            (entry): entry is [string, string] =>
              (entry[0] === 'content-range' || entry[0] === 'accept-ranges') &&
              typeof entry[1] === 'string',
          )
        : [];
      const headers = headerEntries.length === 0
        ? undefined
        : Object.freeze(Object.fromEntries(headerEntries));
      return new ObjectReadHttpError(
        category,
        record.code,
        record.status,
        record.retryable === true,
        headers,
      );
    }
  }
  return new ObjectReadHttpError('internal', 'internal-error', 500);
}

export interface ReadEnabledStorageRuntimeOptions extends StorageRuntimeOptions {
  authorizeObjectReadGrant: (input: {
    caller: Readonly<CallerIdentity>;
    request: Readonly<ObjectReadGrantRequest>;
    appCorrelationReference: string;
  }) => Promise<boolean> | boolean;
  objectReadGrantTokenService: ObjectReadGrantTokenService;
  objectReadGrantRegistry: ObjectReadGrantRegistry;
  objectReadDeliveryService: ObjectReadDeliveryService;
}

export function createReadEnabledHttpStorageRuntime(
  options: ReadEnabledStorageRuntimeOptions,
): HttpStorageRuntime {
  if (typeof options.authorizeObjectReadGrant !== 'function') {
    throw new TypeError('authorizeObjectReadGrant must be a function.');
  }
  if (typeof options.objectReadGrantTokenService?.issue !== 'function') {
    throw new TypeError('objectReadGrantTokenService.issue must be a function.');
  }
  if (typeof options.objectReadGrantRegistry?.execute !== 'function') {
    throw new TypeError('objectReadGrantRegistry.execute must be a function.');
  }
  if (typeof options.objectReadDeliveryService?.deliver !== 'function') {
    throw new TypeError('objectReadDeliveryService.deliver must be a function.');
  }
  const baseRuntime = createHttpStorageRuntime(options);
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;

  async function issueGrant(request: Request): Promise<Response> {
    const version = contractVersion(request);
    const caller = await authenticateAndAuthorize(request, options);
    const key = duplicateKey(request);
    const appCorrelationReference = correlationReference(request);
    const payload = parseGrantRequest(await readJson(request));
    let purposeAllowed = false;
    try {
      purposeAllowed = (await options.authorizeObjectReadGrant({
        caller,
        request: payload,
        appCorrelationReference,
      })) === true;
    } catch {
      purposeAllowed = false;
    }
    if (!purposeAllowed) {
      throw new ObjectReadHttpError('unauthorized', 'object-read-purpose-not-authorized', 403);
    }
    const duplicate = await options.objectReadGrantRegistry.execute({
      scope: callerScope(caller, 'object-read-grant'),
      key,
      fingerprint: fingerprint({ caller, payload }),
      operation: async () => {
        const objectReadGrantId = createId();
        const expiresAt = new Date(now().getTime() + payload.requestedTtlSeconds * 1000);
        const provisional: ObjectReadGrantTokenClaims = {
          tokenPurpose: OBJECT_READ_GRANT_TOKEN_PURPOSE,
          objectReadGrantId,
          storageObjectId: payload.storageObjectId,
          callerAppId: caller.appId,
          purpose: payload.purpose,
          allowedMethods: payload.allowedMethods,
          allowRange: payload.allowRange,
          contractVersion: version,
          expiresAt: expiresAt.toISOString(),
        };
        if (caller.serviceId !== undefined) provisional.callerServiceId = caller.serviceId;
        const token = await options.objectReadGrantTokenService.issue(Object.freeze(provisional));
        return options.objectReadGrantRegistry.createObjectReadGrant({
          objectReadGrantId,
          storageObjectId: payload.storageObjectId,
          callerAppId: caller.appId,
          ...(caller.serviceId === undefined ? {} : { callerServiceId: caller.serviceId }),
          appCorrelationReference,
          businessAuthorizationReference: payload.businessAuthorizationReference,
          purpose: payload.purpose,
          allowedMethods: payload.allowedMethods,
          allowRange: payload.allowRange,
          disposition: payload.disposition,
          ...(payload.fileName === undefined ? {} : { fileName: payload.fileName }),
          tokenDigest: objectReadGrantTokenDigest(token),
          expiresAt,
        });
      },
    });
    const grant = duplicate.value as Readonly<ObjectReadGrantSnapshot>;
    const readGrantToken = await options.objectReadGrantTokenService.issue(
      Object.freeze(tokenClaimsFromGrant(grant)),
    );
    if (objectReadGrantTokenDigest(readGrantToken) !== grant.tokenDigest) {
      throw new ObjectReadHttpError('internal', 'object-read-grant-token-digest-mismatch', 500);
    }
    const result: ObjectReadGrantResult = {
      objectReadGrantId: grant.objectReadGrantId,
      storageObjectId: grant.storageObjectId,
      state: grant.state,
      expiresAt: grant.expiresAt,
      allowedMethods: grant.allowedMethods,
      allowRange: grant.allowRange,
      disposition: grant.disposition,
      readGrantToken,
      duplicateProtection: Object.freeze({ key, replayed: duplicate.replayed }),
    };
    if (grant.fileName !== undefined) result.fileName = grant.fileName;
    return json({
      packageVersion: PACKAGE_VERSION,
      contractVersion: CONTRACT_VERSION,
      appCorrelationReference,
      result: Object.freeze(result),
    });
  }

  async function revokeGrant(request: Request, objectReadGrantId: string): Promise<Response> {
    requireHttpUuid(objectReadGrantId, 'invalid-object-read-grant-id');
    contractVersion(request);
    const caller = await authenticateAndAuthorize(request, options);
    const key = duplicateKey(request);
    const appCorrelationReference = correlationReference(request);
    const duplicate = await options.objectReadGrantRegistry.execute({
      scope: callerScope(caller, 'object-read-grant-revoke'),
      key,
      fingerprint: fingerprint({ caller, objectReadGrantId }),
      operation: () => options.objectReadGrantRegistry.revokeObjectReadGrant({
        objectReadGrantId,
        callerAppId: caller.appId,
        ...(caller.serviceId === undefined ? {} : { callerServiceId: caller.serviceId }),
        appCorrelationReference,
      }),
    });
    const grant = duplicate.value as Readonly<ObjectReadGrantSnapshot>;
    const result: ObjectReadGrantRevocationResult = {
      objectReadGrantId: grant.objectReadGrantId,
      storageObjectId: grant.storageObjectId,
      state: grant.state === 'active' ? 'revoked' : grant.state,
      expiresAt: grant.expiresAt,
      duplicateProtection: Object.freeze({ key, replayed: duplicate.replayed }),
    };
    if (grant.revokedAt !== undefined) result.revokedAt = grant.revokedAt;
    return json({
      packageVersion: PACKAGE_VERSION,
      contractVersion: CONTRACT_VERSION,
      appCorrelationReference,
      result: Object.freeze(result),
    });
  }

  async function deliverContent(
    request: Request,
    storageObjectId: string,
  ): Promise<Response> {
    requireHttpUuid(storageObjectId, 'invalid-storage-object-id');
    const version = contractVersion(request);
    const caller = await authenticateAndAuthorize(request, options);
    const appCorrelationReference = correlationReference(request);
    const token = requiredHeader(
      request,
      'x-zs-read-grant-token',
      'invalid-object-read-grant-token',
      4096,
    );
    const claims = await options.objectReadGrantTokenService.verify(token, {
      storageObjectId,
      callerAppId: caller.appId,
      callerServiceId: caller.serviceId ?? '',
      contractVersion: version,
      now: now(),
    });
    const method = request.method as ObjectReadMethod;
    if (!claims.allowedMethods.includes(method)) {
      throw new ObjectReadHttpError('unauthorized', 'object-read-method-not-allowed', 403);
    }
    const rangeHeader = request.headers.get('range') ?? undefined;
    if (rangeHeader !== undefined && !claims.allowRange) {
      throw new ObjectReadHttpError('unauthorized', 'object-read-range-not-allowed', 403);
    }
    const grant = await options.objectReadGrantRegistry.getObjectReadGrant({
      objectReadGrantId: claims.objectReadGrantId,
      storageObjectId,
      callerAppId: caller.appId,
      ...(caller.serviceId === undefined ? {} : { callerServiceId: caller.serviceId }),
      tokenDigest: objectReadGrantTokenDigest(token),
    });
    if (grant === null || !exactGrantBinding(claims, grant)) {
      throw new ObjectReadHttpError('unauthenticated', 'invalid-object-read-grant-token', 401);
    }
    if (grant.state === 'revoked') {
      throw new ObjectReadHttpError('unauthorized', 'object-read-grant-revoked', 403);
    }
    if (grant.state === 'expired' || new Date(grant.expiresAt) <= now()) {
      throw new ObjectReadHttpError('unauthenticated', 'object-read-grant-expired', 401);
    }
    const delivered = await options.objectReadDeliveryService.deliver({
      grant,
      caller,
      method,
      ...(rangeHeader === undefined ? {} : { rangeHeader }),
      appCorrelationReference,
      requestId: createId(),
      signal: request.signal,
    });
    return new Response(method === 'HEAD' ? null : delivered.body, {
      status: delivered.status,
      headers: delivered.headers,
    });
  }

  async function handle(request: Request): Promise<Response> {
    const correlation = request.headers.get('x-app-correlation-reference') ?? undefined;
    const url = new URL(request.url);
    const issueRoute = url.pathname === '/v1/object-read-grants';
    const revokeRoute = /^\/v1\/object-read-grants\/([^/]+)$/.exec(url.pathname);
    const contentRoute = /^\/v1\/storage-objects\/([^/]+)\/content$/.exec(url.pathname);
    const isReadRoute =
      (request.method === 'POST' && issueRoute) ||
      (request.method === 'DELETE' && revokeRoute?.[1] !== undefined) ||
      ((request.method === 'GET' || request.method === 'HEAD') && contentRoute?.[1] !== undefined);
    if (!isReadRoute) return baseRuntime.handle(request);
    try {
      if (request.method === 'POST') return await issueGrant(request);
      if (request.method === 'DELETE' && revokeRoute?.[1] !== undefined) {
        return await revokeGrant(request, revokeRoute[1]);
      }
      if (
        (request.method === 'GET' || request.method === 'HEAD') &&
        contentRoute?.[1] !== undefined
      ) {
        return await deliverContent(request, contentRoute[1]);
      }
      throw new ObjectReadHttpError('invalid-request', 'route-not-found', 404);
    } catch (error) {
      const normalized = normalizeExternalError(error);
      const diagnostic = createSafeDiagnostic(
        normalized.category,
        normalized.code,
        normalized.retryable,
        correlation,
      );
      return json(
        { contractVersion: CONTRACT_VERSION, error: { diagnostic } },
        normalized.status,
        normalized.headers,
      );
    }
  }

  return Object.freeze({
    handle,
    health: () => baseRuntime.health(),
    readiness: () => baseRuntime.readiness(),
  });
}
