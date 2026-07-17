import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type {
  CallerIdentity,
  ContractVersion,
  ObjectReadGrantRequest,
  SafeDiagnostic,
} from './runtime-contract.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryable,
} from './runtime-storage-registry-types.js';

export const READ_GRANT_TOKEN_PURPOSE = 'z-s-object-read-grant-v1' as const;
export const OBJECT_READ_METHODS = ['HEAD', 'GET'] as const;

export type ObjectReadMethod = (typeof OBJECT_READ_METHODS)[number];
export type ObjectReadDisposition = 'inline' | 'attachment';
export type ObjectReadGrantState = 'active' | 'revoked' | 'expired';
export type ObjectReadProviderRole = 'hot' | 'canonical';

export class ObjectReadGrantError extends Error {
  readonly category: SafeDiagnostic['category'];
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly responseHeaders: Readonly<Record<string, string>> | undefined;

  constructor(
    category: SafeDiagnostic['category'],
    code: string,
    status: number,
    retryable = false,
    responseHeaders?: Readonly<Record<string, string>>,
  ) {
    super(code);
    this.name = 'ObjectReadGrantError';
    this.category = category;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.responseHeaders = responseHeaders;
  }
}

export type { ObjectReadGrantRequest, ObjectReadGrantResult } from './runtime-contract.js';

export interface ObjectReadGrantClaims {
  purpose: typeof READ_GRANT_TOKEN_PURPOSE;
  objectReadGrantId: string;
  storageObjectId: string;
  callerAppId: string;
  callerServiceId?: string;
  grantPurpose: string;
  allowedMethods: readonly ObjectReadMethod[];
  allowRange: boolean;
  disposition: ObjectReadDisposition;
  fileName?: string;
  contractVersion: ContractVersion;
  expiresAt: string;
}

export interface ObjectReadGrantTokenExpectation {
  objectReadGrantId?: string;
  storageObjectId?: string;
  callerAppId?: string;
  callerServiceId?: string;
  method?: ObjectReadMethod;
  rangeRequested?: boolean;
  contractVersion?: ContractVersion;
  now?: Date;
}

export interface ObjectReadGrantTokenService {
  issue(claims: Readonly<ObjectReadGrantClaims>): string;
  verify(
    token: string,
    expectation?: Readonly<ObjectReadGrantTokenExpectation>,
  ): Readonly<ObjectReadGrantClaims>;
  digest(token: string): string;
}

export interface ObjectReadGrantSnapshot {
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

export interface ObjectReadTargetSnapshot {
  storageObjectCopyId: string;
  providerBindingId: string;
  providerRole: ObjectReadProviderRole;
  providerType: string;
  internalLocator: string;
  latestVerifiedAt?: string;
}

export interface ObjectReadObjectSnapshot {
  storageObjectId: string;
  managedAppId: string;
  registryState: 'reserved' | 'active' | 'degraded' | 'delete_pending' | 'deleted';
  objectProtectionStage: string;
  verifiedChecksumSha256: string;
  verifiedByteLength: number;
  verifiedContentType: string;
  targets: Readonly<Partial<Record<ObjectReadProviderRole, Readonly<ObjectReadTargetSnapshot>>>>;
}

export interface IssueObjectReadGrantInput {
  caller: Readonly<CallerIdentity>;
  contractVersion: ContractVersion;
  appCorrelationReference: string;
  duplicateProtectionKey: string;
  requestFingerprint: string;
  request: Readonly<ObjectReadGrantRequest>;
  proposedGrantId: string;
  proposedExpiresAt: Date;
  proposedTokenDigest: string;
}

export interface RevokeObjectReadGrantInput {
  caller: Readonly<CallerIdentity>;
  contractVersion: ContractVersion;
  appCorrelationReference: string;
  duplicateProtectionKey: string;
  requestFingerprint: string;
  objectReadGrantId: string;
}

export interface ObjectReadAttemptInput {
  grant: Readonly<ObjectReadGrantSnapshot>;
  target: Readonly<ObjectReadTargetSnapshot>;
  requestId: string;
  method: ObjectReadMethod;
  rangeRequested: boolean;
  attemptNumber: number;
  expectedChecksumSha256: string;
  expectedByteLength: number;
}

export interface ObjectReadGrantRegistry {
  issue(
    input: Readonly<IssueObjectReadGrantInput>,
  ): Promise<Readonly<{ replayed: boolean; grant: Readonly<ObjectReadGrantSnapshot> }>>;
  revoke(
    input: Readonly<RevokeObjectReadGrantInput>,
  ): Promise<Readonly<{ replayed: boolean; grant: Readonly<ObjectReadGrantSnapshot> }>>;
  getForDelivery(input: {
    objectReadGrantId: string;
    storageObjectId: string;
    caller: Readonly<CallerIdentity>;
    now: Date;
  }): Promise<Readonly<ObjectReadGrantSnapshot> | null>;
  resolveObjectForRead(input: {
    storageObjectId: string;
    managedAppId: string;
  }): Promise<Readonly<ObjectReadObjectSnapshot> | null>;
  beginReadAttempt(input: Readonly<ObjectReadAttemptInput>): Promise<string>;
  completeReadAttempt(input: {
    providerAttemptId: string;
    succeeded: boolean;
    retryable?: boolean;
    safeDiagnostic?: Readonly<SafeDiagnostic>;
    observedChecksumSha256?: string;
    observedByteLength?: number;
  }): Promise<void>;
  appendReadEvent(input: {
    eventId?: string;
    dedupeKey: string;
    eventType: string;
    grant: Readonly<ObjectReadGrantSnapshot>;
    occurredAt: Date;
    payload: Readonly<Record<string, unknown>>;
    diagnostic?: Readonly<SafeDiagnostic>;
  }): Promise<void>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const SAFE_SERVICE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,95}$/;
const SAFE_APP_PATTERN = /^[a-z0-9][a-z0-9_-]{0,95}$/;
const SAFE_EVENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9.-]{0,95}$/;
const SAFE_DEDUPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireUuid(value: unknown, code: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ObjectReadGrantError('invalid-request', code, 400);
  }
  return value;
}

function requireSafeString(
  value: unknown,
  code: string,
  options: Readonly<{ min?: number; max?: number; pattern?: RegExp }> = {},
): string {
  if (typeof value !== 'string') {
    throw new ObjectReadGrantError('invalid-request', code, 400);
  }
  const normalized = value.trim();
  const min = options.min ?? 1;
  const max = options.max ?? 256;
  if (
    normalized.length < min ||
    normalized.length > max ||
    /[\u0000-\u001f\u007f]/u.test(normalized) ||
    (options.pattern !== undefined && !options.pattern.test(normalized))
  ) {
    throw new ObjectReadGrantError('invalid-request', code, 400);
  }
  return normalized;
}

function requireIso(value: unknown, code = 'invalid-read-grant-token'): string {
  if (typeof value !== 'string' || value.length > 64) {
    throw new ObjectReadGrantError('unauthenticated', code, 401);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new ObjectReadGrantError('unauthenticated', code, 401);
  }
  return value;
}

export function sanitizeReadFileName(value: unknown): string {
  const fileName = requireSafeString(value, 'invalid-file-name', { max: 180 }).normalize('NFKC');
  if (
    fileName === '.' ||
    fileName === '..' ||
    fileName.startsWith('.') ||
    fileName.endsWith('.') ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('"') ||
    fileName.includes(';') ||
    /\s{2,}/u.test(fileName)
  ) {
    throw new ObjectReadGrantError('invalid-request', 'invalid-file-name', 400);
  }
  return fileName;
}

export function parseObjectReadGrantRequest(value: unknown): Readonly<ObjectReadGrantRequest> {
  if (!isRecord(value)) {
    throw new ObjectReadGrantError('invalid-request', 'invalid-object-read-grant', 400);
  }
  const allowedKeys = new Set([
    'storageObjectId',
    'purpose',
    'allowedMethods',
    'allowRange',
    'disposition',
    'fileName',
    'requestedTtlSeconds',
    'businessAuthorizationReference',
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new ObjectReadGrantError('invalid-request', 'unexpected-read-grant-field', 400);
  }
  const storageObjectId = requireUuid(value.storageObjectId, 'invalid-storage-object-id');
  const purpose = requireSafeString(value.purpose, 'invalid-purpose', {
    max: 96,
    pattern: SAFE_IDENTIFIER_PATTERN,
  });
  if (!Array.isArray(value.allowedMethods) || value.allowedMethods.length === 0) {
    throw new ObjectReadGrantError('invalid-request', 'invalid-allowed-methods', 400);
  }
  const methods = value.allowedMethods.map((entry) => {
    if (entry !== 'HEAD' && entry !== 'GET') {
      throw new ObjectReadGrantError('invalid-request', 'invalid-allowed-methods', 400);
    }
    return entry;
  });
  if (new Set(methods).size !== methods.length) {
    throw new ObjectReadGrantError('invalid-request', 'duplicate-allowed-method', 400);
  }
  const allowedMethods = OBJECT_READ_METHODS.filter((method) => methods.includes(method));
  if (typeof value.allowRange !== 'boolean') {
    throw new ObjectReadGrantError('invalid-request', 'invalid-allow-range', 400);
  }
  if (value.disposition !== 'inline' && value.disposition !== 'attachment') {
    throw new ObjectReadGrantError('invalid-request', 'invalid-disposition', 400);
  }
  if (
    !Number.isSafeInteger(value.requestedTtlSeconds) ||
    (value.requestedTtlSeconds as number) < 30 ||
    (value.requestedTtlSeconds as number) > 300
  ) {
    throw new ObjectReadGrantError('invalid-request', 'invalid-requested-ttl-seconds', 400);
  }
  const result: ObjectReadGrantRequest = {
    storageObjectId,
    purpose,
    allowedMethods: Object.freeze(allowedMethods),
    allowRange: value.allowRange,
    disposition: value.disposition,
    requestedTtlSeconds: value.requestedTtlSeconds as number,
    businessAuthorizationReference: requireSafeString(
      value.businessAuthorizationReference,
      'invalid-business-authorization-reference',
      { max: 256 },
    ),
  };
  if (value.fileName !== undefined && value.fileName !== null) {
    result.fileName = sanitizeReadFileName(value.fileName);
  }
  return Object.freeze(result);
}

function canonicalClaims(claims: Readonly<ObjectReadGrantClaims>): Record<string, unknown> {
  const value: Record<string, unknown> = {
    tp: claims.purpose,
    gid: claims.objectReadGrantId,
    oid: claims.storageObjectId,
    app: claims.callerAppId,
    svc: claims.callerServiceId ?? '',
    p: claims.grantPurpose,
    m: claims.allowedMethods,
    r: claims.allowRange,
    d: claims.disposition,
    cv: claims.contractVersion,
    exp: claims.expiresAt,
  };
  if (claims.fileName !== undefined) value.fn = claims.fileName;
  return value;
}

function parseTokenClaims(value: unknown): Readonly<ObjectReadGrantClaims> {
  if (!isRecord(value) || value.tp !== READ_GRANT_TOKEN_PURPOSE) {
    throw new ObjectReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
  }
  const rawMethods = value.m;
  if (!Array.isArray(rawMethods) || rawMethods.length === 0 || rawMethods.length > 2) {
    throw new ObjectReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
  }
  const methods: ObjectReadMethod[] = [];
  for (const entry of rawMethods) {
    if (entry !== 'HEAD' && entry !== 'GET' || methods.includes(entry)) {
      throw new ObjectReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
    }
    methods.push(entry);
  }
  if (typeof value.r !== 'boolean' || (value.d !== 'inline' && value.d !== 'attachment')) {
    throw new ObjectReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
  }
  const claims: ObjectReadGrantClaims = {
    purpose: READ_GRANT_TOKEN_PURPOSE,
    objectReadGrantId: requireUuid(value.gid, 'invalid-read-grant-token'),
    storageObjectId: requireUuid(value.oid, 'invalid-read-grant-token'),
    callerAppId: requireSafeString(value.app, 'invalid-read-grant-token', {
      max: 96,
      pattern: SAFE_APP_PATTERN,
    }),
    grantPurpose: requireSafeString(value.p, 'invalid-read-grant-token', {
      max: 96,
      pattern: SAFE_IDENTIFIER_PATTERN,
    }),
    allowedMethods: Object.freeze(methods),
    allowRange: value.r,
    disposition: value.d,
    contractVersion: requireSafeString(value.cv, 'invalid-read-grant-token', {
      max: 16,
      pattern: /^[0-9]+\.[0-9]+$/,
    }) as ContractVersion,
    expiresAt: requireIso(value.exp),
  };
  if (value.svc !== '') {
    claims.callerServiceId = requireSafeString(value.svc, 'invalid-read-grant-token', {
      max: 96,
      pattern: SAFE_SERVICE_PATTERN,
    });
  }
  if (value.fn !== undefined) claims.fileName = sanitizeReadFileName(value.fn);
  return Object.freeze(claims);
}

function base64UrlDecode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ObjectReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
  }
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    throw new ObjectReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
  }
}

export function createObjectReadGrantTokenService(
  secret: Uint8Array = randomBytes(32),
): ObjectReadGrantTokenService {
  const key = Buffer.from(secret);
  if (key.byteLength < 32) throw new TypeError('Read-grant token secret must be at least 32 bytes.');

  function issue(claims: Readonly<ObjectReadGrantClaims>): string {
    const normalized = parseTokenClaims(canonicalClaims(claims));
    const payload = Buffer.from(JSON.stringify(canonicalClaims(normalized))).toString('base64url');
    const signature = createHmac('sha256', key).update(`zsrg1.${payload}`).digest('base64url');
    return `zsrg1.${payload}.${signature}`;
  }

  function verify(
    token: string,
    expectation: Readonly<ObjectReadGrantTokenExpectation> = {},
  ): Readonly<ObjectReadGrantClaims> {
    if (typeof token !== 'string' || token.length < 32 || token.length > 4096) {
      throw new ObjectReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
    }
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'zsrg1' || parts[1] === undefined || parts[2] === undefined) {
      throw new ObjectReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
    }
    const expectedSignature = createHmac('sha256', key)
      .update(`zsrg1.${parts[1]}`)
      .digest();
    const suppliedSignature = base64UrlDecode(parts[2]);
    if (
      expectedSignature.byteLength !== suppliedSignature.byteLength ||
      !timingSafeEqual(expectedSignature, suppliedSignature)
    ) {
      throw new ObjectReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
    } catch {
      throw new ObjectReadGrantError('unauthenticated', 'invalid-read-grant-token', 401);
    }
    const claims = parseTokenClaims(decoded);
    const now = expectation.now ?? new Date();
    if (new Date(claims.expiresAt).getTime() <= now.getTime()) {
      throw new ObjectReadGrantError('unauthenticated', 'read-grant-expired', 401);
    }
    if (
      (expectation.objectReadGrantId !== undefined &&
        claims.objectReadGrantId !== expectation.objectReadGrantId) ||
      (expectation.storageObjectId !== undefined &&
        claims.storageObjectId !== expectation.storageObjectId) ||
      (expectation.callerAppId !== undefined && claims.callerAppId !== expectation.callerAppId) ||
      (expectation.callerServiceId !== undefined &&
        (claims.callerServiceId ?? '') !== expectation.callerServiceId) ||
      (expectation.contractVersion !== undefined &&
        claims.contractVersion !== expectation.contractVersion)
    ) {
      throw new ObjectReadGrantError('unauthorized', 'read-grant-scope-mismatch', 403);
    }
    if (expectation.method !== undefined && !claims.allowedMethods.includes(expectation.method)) {
      throw new ObjectReadGrantError('unauthorized', 'read-grant-method-not-allowed', 403);
    }
    if (expectation.rangeRequested === true && !claims.allowRange) {
      throw new ObjectReadGrantError('unauthorized', 'read-grant-range-not-allowed', 403);
    }
    return claims;
  }

  return Object.freeze({
    issue,
    verify,
    digest(token: string): string {
      return createHash('sha256').update(token).digest('hex');
    },
  });
}

function asIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ObjectReadGrantError('internal', 'invalid-registry-timestamp', 500);
  }
  return date.toISOString();
}

function asPositiveInteger(value: string | number, code: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ObjectReadGrantError('internal', code, 500);
  }
  return parsed;
}

interface GrantRow extends Record<string, unknown> {
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

function mapGrantRow(row: GrantRow): Readonly<ObjectReadGrantSnapshot> {
  if (
    !UUID_PATTERN.test(row.object_read_grant_id) ||
    !UUID_PATTERN.test(row.storage_object_id) ||
    !UUID_PATTERN.test(row.managed_app_id) ||
    !Array.isArray(row.allowed_methods) ||
    row.allowed_methods.length === 0 ||
    !SHA256_PATTERN.test(row.read_grant_token_digest) ||
    row.token_purpose !== READ_GRANT_TOKEN_PURPOSE
  ) {
    throw new ObjectReadGrantError('internal', 'invalid-read-grant-registry-row', 500);
  }
  const methods = row.allowed_methods.map((method) => {
    if (method !== 'HEAD' && method !== 'GET') {
      throw new ObjectReadGrantError('internal', 'invalid-read-grant-registry-row', 500);
    }
    return method;
  });
  const result: ObjectReadGrantSnapshot = {
    objectReadGrantId: row.object_read_grant_id,
    storageObjectId: row.storage_object_id,
    managedAppId: row.managed_app_id,
    callerAppId: row.caller_app_id,
    appCorrelationReference: row.app_correlation_ref,
    businessAuthorizationReference: row.business_authorization_ref,
    purpose: row.purpose,
    allowedMethods: Object.freeze(methods),
    allowRange: row.range_allowed,
    disposition: row.disposition,
    tokenDigest: row.read_grant_token_digest,
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

async function transaction<T>(pool: PostgresPoolLike, operation: (client: PostgresClientLike) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original bounded error.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function selectGrant(
  client: PostgresQueryable,
  objectReadGrantId: string,
): Promise<Readonly<ObjectReadGrantSnapshot> | null> {
  const result = await client.query<GrantRow>(
    `SELECT read_grant.object_read_grant_id,
            read_grant.storage_object_id,
            read_grant.managed_app_id,
            app.app_id AS caller_app_id,
            read_grant.caller_service_id,
            read_grant.app_correlation_ref,
            read_grant.business_authorization_ref,
            read_grant.purpose,
            read_grant.allowed_methods,
            read_grant.range_allowed,
            read_grant.disposition,
            read_grant.safe_file_name,
            read_grant.read_grant_token_digest,
            read_grant.token_purpose,
            read_grant.state,
            read_grant.expires_at,
            read_grant.revoked_at,
            read_grant.created_at,
            read_grant.updated_at,
            read_grant.row_version
       FROM public.object_read_grants AS read_grant
       JOIN public.managed_apps AS app ON app.id = read_grant.managed_app_id
      WHERE read_grant.object_read_grant_id = $1`,
    [objectReadGrantId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapGrantRow(row);
}

export interface PostgresObjectReadGrantRegistryOptions {
  pool: PostgresPoolLike;
  now?: () => Date;
  createId?: () => string;
  idempotencyTtlMs?: number;
}

export class PostgresObjectReadGrantRegistry implements ObjectReadGrantRegistry {
  readonly #pool: PostgresPoolLike;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #idempotencyTtlMs: number;

  constructor(options: Readonly<PostgresObjectReadGrantRegistryOptions>) {
    if (typeof options.pool?.connect !== 'function') throw new TypeError('pool.connect must be a function.');
    this.#pool = options.pool;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#idempotencyTtlMs = options.idempotencyTtlMs ?? 86_400_000;
    if (!Number.isSafeInteger(this.#idempotencyTtlMs) || this.#idempotencyTtlMs < 300_000) {
      throw new TypeError('idempotencyTtlMs must be at least 300000.');
    }
  }

  async issue(
    input: Readonly<IssueObjectReadGrantInput>,
  ): Promise<Readonly<{ replayed: boolean; grant: Readonly<ObjectReadGrantSnapshot> }>> {
    requireUuid(input.proposedGrantId, 'invalid-object-read-grant-id');
    if (!SHA256_PATTERN.test(input.proposedTokenDigest) || !SHA256_PATTERN.test(input.requestFingerprint)) {
      throw new ObjectReadGrantError('invalid-request', 'invalid-read-grant-digest', 400);
    }
    const callerServiceId = input.caller.serviceId ?? '';
    const now = this.#now();
    return transaction(this.#pool, async (client) => {
      const authority = await client.query<{
        managed_app_id: string;
        registry_state: string;
        verified_checksum_sha256: string | null;
        verified_byte_length: string | number | null;
        expected_content_type: string;
        profile_status: string;
        verified_copy_count: string;
      }>(
        `SELECT object_record.managed_app_id,
                object_record.registry_state,
                object_record.verified_checksum_sha256,
                object_record.verified_byte_length,
                object_record.expected_content_type,
                profile.status AS profile_status,
                (SELECT count(*)::text
                   FROM public.storage_object_copies AS copy
                  WHERE copy.storage_object_id = object_record.storage_object_id
                    AND copy.copy_state = 'verified') AS verified_copy_count
           FROM public.storage_objects AS object_record
           JOIN public.managed_apps AS app
             ON app.id = object_record.managed_app_id
            AND app.app_id = $2
            AND app.status = 'active'
           JOIN public.storage_profiles AS profile
             ON profile.id = object_record.storage_profile_id
          WHERE object_record.storage_object_id = $1
          FOR SHARE OF object_record, app, profile`,
        [input.request.storageObjectId, input.caller.appId],
      );
      const authorityRow = authority.rows[0];
      if (authorityRow === undefined) {
        throw new ObjectReadGrantError('not-ready', 'storage-object-not-readable', 404);
      }
      if (
        (authorityRow.registry_state !== 'active' && authorityRow.registry_state !== 'degraded') ||
        authorityRow.profile_status !== 'active' ||
        authorityRow.verified_checksum_sha256 === null ||
        authorityRow.verified_byte_length === null ||
        Number(authorityRow.verified_copy_count) < 1
      ) {
        throw new ObjectReadGrantError('not-ready', 'storage-object-not-readable', 409);
      }

      const recordId = this.#createId();
      const idempotencyExpiry = new Date(now.getTime() + this.#idempotencyTtlMs);
      const inserted = await client.query(
        `INSERT INTO public.storage_idempotency_records
           (id, caller_app_id, caller_service_id, operation_scope, idempotency_key,
            request_fingerprint, state, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'object-read-grant-issue', $4, $5, 'in_progress', $6, $7, $7)
         ON CONFLICT (caller_app_id, caller_service_id, operation_scope, idempotency_key)
         DO NOTHING`,
        [
          recordId,
          input.caller.appId,
          callerServiceId,
          input.duplicateProtectionKey,
          input.requestFingerprint,
          idempotencyExpiry,
          now,
        ],
      );
      const idempotency = await client.query<{
        request_fingerprint: string;
        state: string;
        result_kind: string | null;
        result_reference_id: string | null;
      }>(
        `SELECT request_fingerprint, state, result_kind, result_reference_id
           FROM public.storage_idempotency_records
          WHERE caller_app_id = $1
            AND caller_service_id = $2
            AND operation_scope = 'object-read-grant-issue'
            AND idempotency_key = $3
          FOR UPDATE`,
        [input.caller.appId, callerServiceId, input.duplicateProtectionKey],
      );
      const idempotencyRow = idempotency.rows[0];
      if (idempotencyRow === undefined) {
        throw new ObjectReadGrantError('internal', 'read-grant-idempotency-missing', 500);
      }
      if (idempotencyRow.request_fingerprint !== input.requestFingerprint) {
        throw new ObjectReadGrantError('duplicate-conflict', 'idempotency-key-reused', 409);
      }
      if (inserted.rowCount === 0) {
        if (
          idempotencyRow.state !== 'succeeded' ||
          idempotencyRow.result_kind !== 'object-read-grant' ||
          idempotencyRow.result_reference_id === null
        ) {
          throw new ObjectReadGrantError(
            'dependency-unavailable',
            'read-grant-idempotency-in-progress',
            503,
            true,
          );
        }
        const replayedGrant = await selectGrant(client, idempotencyRow.result_reference_id);
        if (replayedGrant === null) {
          throw new ObjectReadGrantError('internal', 'read-grant-idempotency-result-missing', 500);
        }
        return Object.freeze({ replayed: true, grant: replayedGrant });
      }

      await client.query(
        `INSERT INTO public.object_read_grants
           (object_read_grant_id, storage_object_id, managed_app_id, caller_service_id,
            app_correlation_ref, business_authorization_ref, purpose, allowed_methods,
            range_allowed, disposition, safe_file_name, read_grant_token_digest,
            token_purpose, state, expires_at, revoked_at, created_at, updated_at, row_version)
         VALUES ($1, $2, $3, NULLIF($4, ''), $5, $6, $7, $8::text[], $9, $10, $11,
                 $12, $13, 'active', $14, NULL, $15, $15, 1)`,
        [
          input.proposedGrantId,
          input.request.storageObjectId,
          authorityRow.managed_app_id,
          callerServiceId,
          input.appCorrelationReference,
          input.request.businessAuthorizationReference,
          input.request.purpose,
          input.request.allowedMethods,
          input.request.allowRange,
          input.request.disposition,
          input.request.fileName ?? null,
          input.proposedTokenDigest,
          READ_GRANT_TOKEN_PURPOSE,
          input.proposedExpiresAt,
          now,
        ],
      );
      await client.query(
        `UPDATE public.storage_idempotency_records
            SET state = 'succeeded',
                result_kind = 'object-read-grant',
                result_reference_id = $1,
                result_storage_object_id = $2,
                updated_at = $3
          WHERE id = $4`,
        [input.proposedGrantId, input.request.storageObjectId, now, recordId],
      );
      const grant = await selectGrant(client, input.proposedGrantId);
      if (grant === null) throw new ObjectReadGrantError('internal', 'read-grant-create-missing', 500);
      await this.#appendEvent(client, {
        dedupeKey: `read-grant-issued:${grant.objectReadGrantId}`,
        eventType: 'object-read-grant.issued',
        grant,
        occurredAt: now,
        payload: Object.freeze({
          objectReadGrantId: grant.objectReadGrantId,
          purpose: grant.purpose,
          allowedMethods: grant.allowedMethods,
          rangeAllowed: grant.allowRange,
          state: grant.state,
          expiresAt: grant.expiresAt,
        }),
      });
      return Object.freeze({ replayed: false, grant });
    });
  }

  async revoke(
    input: Readonly<RevokeObjectReadGrantInput>,
  ): Promise<Readonly<{ replayed: boolean; grant: Readonly<ObjectReadGrantSnapshot> }>> {
    requireUuid(input.objectReadGrantId, 'invalid-object-read-grant-id');
    if (!SHA256_PATTERN.test(input.requestFingerprint)) {
      throw new ObjectReadGrantError('invalid-request', 'invalid-request-fingerprint', 400);
    }
    const callerServiceId = input.caller.serviceId ?? '';
    const now = this.#now();
    return transaction(this.#pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO public.storage_idempotency_records
           (id, caller_app_id, caller_service_id, operation_scope, idempotency_key,
            request_fingerprint, state, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'object-read-grant-revoke', $4, $5, 'in_progress', $6, $7, $7)
         ON CONFLICT (caller_app_id, caller_service_id, operation_scope, idempotency_key)
         DO NOTHING`,
        [
          this.#createId(),
          input.caller.appId,
          callerServiceId,
          input.duplicateProtectionKey,
          input.requestFingerprint,
          new Date(now.getTime() + this.#idempotencyTtlMs),
          now,
        ],
      );
      const idempotency = await client.query<{
        id: string;
        request_fingerprint: string;
        state: string;
        result_kind: string | null;
        result_reference_id: string | null;
      }>(
        `SELECT id, request_fingerprint, state, result_kind, result_reference_id
           FROM public.storage_idempotency_records
          WHERE caller_app_id = $1
            AND caller_service_id = $2
            AND operation_scope = 'object-read-grant-revoke'
            AND idempotency_key = $3
          FOR UPDATE`,
        [input.caller.appId, callerServiceId, input.duplicateProtectionKey],
      );
      const idempotencyRow = idempotency.rows[0];
      if (idempotencyRow === undefined) {
        throw new ObjectReadGrantError('internal', 'read-grant-idempotency-missing', 500);
      }
      if (idempotencyRow.request_fingerprint !== input.requestFingerprint) {
        throw new ObjectReadGrantError('duplicate-conflict', 'idempotency-key-reused', 409);
      }
      if (inserted.rowCount === 0) {
        if (
          idempotencyRow.state !== 'succeeded' ||
          idempotencyRow.result_kind !== 'object-read-grant-revoke' ||
          idempotencyRow.result_reference_id === null
        ) {
          throw new ObjectReadGrantError(
            'dependency-unavailable',
            'read-grant-idempotency-in-progress',
            503,
            true,
          );
        }
        const replayed = await selectGrant(client, idempotencyRow.result_reference_id);
        if (replayed === null) {
          throw new ObjectReadGrantError('internal', 'read-grant-idempotency-result-missing', 500);
        }
        return Object.freeze({ replayed: true, grant: replayed });
      }

      const locked = await client.query<GrantRow>(
        `SELECT read_grant.object_read_grant_id,
                read_grant.storage_object_id,
                read_grant.managed_app_id,
                app.app_id AS caller_app_id,
                read_grant.caller_service_id,
                read_grant.app_correlation_ref,
                read_grant.business_authorization_ref,
                read_grant.purpose,
                read_grant.allowed_methods,
                read_grant.range_allowed,
                read_grant.disposition,
                read_grant.safe_file_name,
                read_grant.read_grant_token_digest,
                read_grant.token_purpose,
                read_grant.state,
                read_grant.expires_at,
                read_grant.revoked_at,
                read_grant.created_at,
                read_grant.updated_at,
                read_grant.row_version
           FROM public.object_read_grants AS read_grant
           JOIN public.managed_apps AS app
             ON app.id = read_grant.managed_app_id
            AND app.app_id = $2
          WHERE read_grant.object_read_grant_id = $1
            AND COALESCE(read_grant.caller_service_id, '') = $3
          FOR UPDATE OF read_grant`,
        [input.objectReadGrantId, input.caller.appId, callerServiceId],
      );
      const row = locked.rows[0];
      if (row === undefined) {
        throw new ObjectReadGrantError('not-ready', 'object-read-grant-not-found', 404);
      }
      const current = mapGrantRow(row);
      let nextState = current.state;
      if (current.state === 'active') {
        nextState = new Date(current.expiresAt).getTime() <= now.getTime() ? 'expired' : 'revoked';
        const updated = await client.query(
          `UPDATE public.object_read_grants
              SET state = $2,
                  revoked_at = CASE WHEN $2 = 'revoked' THEN $3 ELSE NULL END,
                  updated_at = $3,
                  row_version = row_version + 1
            WHERE object_read_grant_id = $1
              AND state = 'active'
              AND row_version = $4`,
          [current.objectReadGrantId, nextState, now, current.rowVersion],
        );
        if (updated.rowCount !== 1) {
          throw new ObjectReadGrantError('duplicate-conflict', 'read-grant-state-conflict', 409);
        }
      }
      const grant = await selectGrant(client, current.objectReadGrantId);
      if (grant === null) throw new ObjectReadGrantError('internal', 'read-grant-revoke-missing', 500);
      await client.query(
        `UPDATE public.storage_idempotency_records
            SET state = 'succeeded',
                result_kind = 'object-read-grant-revoke',
                result_reference_id = $1,
                result_storage_object_id = $2,
                updated_at = $3
          WHERE id = $4`,
        [grant.objectReadGrantId, grant.storageObjectId, now, idempotencyRow.id],
      );
      await this.#appendEvent(client, {
        dedupeKey: `read-grant-revoked:${grant.objectReadGrantId}`,
        eventType: 'object-read-grant.revoked',
        grant,
        occurredAt: now,
        payload: Object.freeze({
          objectReadGrantId: grant.objectReadGrantId,
          state: grant.state,
        }),
      });
      return Object.freeze({ replayed: false, grant });
    });
  }

  async getForDelivery(input: {
    objectReadGrantId: string;
    storageObjectId: string;
    caller: Readonly<CallerIdentity>;
    now: Date;
  }): Promise<Readonly<ObjectReadGrantSnapshot> | null> {
    requireUuid(input.objectReadGrantId, 'invalid-object-read-grant-id');
    requireUuid(input.storageObjectId, 'invalid-storage-object-id');
    return transaction(this.#pool, async (client) => {
      const result = await client.query<GrantRow>(
        `SELECT read_grant.object_read_grant_id,
                read_grant.storage_object_id,
                read_grant.managed_app_id,
                app.app_id AS caller_app_id,
                read_grant.caller_service_id,
                read_grant.app_correlation_ref,
                read_grant.business_authorization_ref,
                read_grant.purpose,
                read_grant.allowed_methods,
                read_grant.range_allowed,
                read_grant.disposition,
                read_grant.safe_file_name,
                read_grant.read_grant_token_digest,
                read_grant.token_purpose,
                read_grant.state,
                read_grant.expires_at,
                read_grant.revoked_at,
                read_grant.created_at,
                read_grant.updated_at,
                read_grant.row_version
           FROM public.object_read_grants AS read_grant
           JOIN public.managed_apps AS app
             ON app.id = read_grant.managed_app_id
            AND app.app_id = $3
          WHERE read_grant.object_read_grant_id = $1
            AND read_grant.storage_object_id = $2
            AND COALESCE(read_grant.caller_service_id, '') = $4
          FOR UPDATE OF read_grant`,
        [input.objectReadGrantId, input.storageObjectId, input.caller.appId, input.caller.serviceId ?? ''],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      let grant = mapGrantRow(row);
      if (grant.state === 'active' && new Date(grant.expiresAt).getTime() <= input.now.getTime()) {
        await client.query(
          `UPDATE public.object_read_grants
              SET state = 'expired', updated_at = $2, row_version = row_version + 1
            WHERE object_read_grant_id = $1 AND state = 'active' AND row_version = $3`,
          [grant.objectReadGrantId, input.now, grant.rowVersion],
        );
        const expired = await selectGrant(client, grant.objectReadGrantId);
        if (expired === null) throw new ObjectReadGrantError('internal', 'read-grant-expiry-missing', 500);
        grant = expired;
      }
      return grant;
    });
  }

  async resolveObjectForRead(input: {
    storageObjectId: string;
    managedAppId: string;
  }): Promise<Readonly<ObjectReadObjectSnapshot> | null> {
    requireUuid(input.storageObjectId, 'invalid-storage-object-id');
    requireUuid(input.managedAppId, 'invalid-managed-app-id');
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await client.query<{
        storage_object_id: string;
        managed_app_id: string;
        registry_state: ObjectReadObjectSnapshot['registryState'];
        object_protection_stage: string;
        verified_checksum_sha256: string | null;
        verified_byte_length: string | number | null;
        expected_content_type: string;
        storage_object_copy_id: string | null;
        storage_profile_provider_binding_id: string | null;
        provider_role: ObjectReadProviderRole | null;
        provider_type: string | null;
        internal_locator: string | null;
        copy_state: string | null;
        observed_checksum_sha256: string | null;
        observed_byte_length: string | number | null;
        latest_verified_at: Date | string | null;
      }>(
        `SELECT object_record.storage_object_id,
                object_record.managed_app_id,
                object_record.registry_state,
                object_record.object_protection_stage,
                object_record.verified_checksum_sha256,
                object_record.verified_byte_length,
                object_record.expected_content_type,
                copy.storage_object_copy_id,
                copy.storage_profile_provider_binding_id,
                copy.provider_role,
                provider.provider_type,
                copy.internal_locator,
                copy.copy_state,
                copy.observed_checksum_sha256,
                copy.observed_byte_length,
                copy.latest_verified_at
           FROM public.storage_objects AS object_record
           LEFT JOIN public.storage_object_copies AS copy
             ON copy.storage_object_id = object_record.storage_object_id
           LEFT JOIN public.storage_profile_provider_bindings AS binding
             ON binding.id = copy.storage_profile_provider_binding_id
           LEFT JOIN public.storage_providers AS provider
             ON provider.id = binding.storage_provider_id
          WHERE object_record.storage_object_id = $1
            AND object_record.managed_app_id = $2
          ORDER BY copy.provider_role`,
        [input.storageObjectId, input.managedAppId],
      );
      const first = result.rows[0];
      if (first === undefined) {
        await client.query('COMMIT');
        return null;
      }
      if (
        first.verified_checksum_sha256 === null ||
        first.verified_byte_length === null ||
        !SHA256_PATTERN.test(first.verified_checksum_sha256)
      ) {
        throw new ObjectReadGrantError('not-ready', 'storage-object-unverified', 409);
      }
      const verifiedByteLength = asPositiveInteger(
        first.verified_byte_length,
        'invalid-verified-byte-length',
      );
      const targets: Partial<Record<ObjectReadProviderRole, Readonly<ObjectReadTargetSnapshot>>> = {};
      for (const row of result.rows) {
        if (
          row.storage_object_copy_id === null ||
          row.storage_profile_provider_binding_id === null ||
          row.provider_role === null ||
          row.provider_type === null ||
          row.internal_locator === null ||
          row.copy_state !== 'verified' ||
          row.observed_checksum_sha256 !== first.verified_checksum_sha256 ||
          row.observed_byte_length === null ||
          asPositiveInteger(row.observed_byte_length, 'invalid-observed-byte-length') !==
            verifiedByteLength
        ) {
          continue;
        }
        const target: ObjectReadTargetSnapshot = {
          storageObjectCopyId: row.storage_object_copy_id,
          providerBindingId: row.storage_profile_provider_binding_id,
          providerRole: row.provider_role,
          providerType: row.provider_type,
          internalLocator: row.internal_locator,
        };
        if (row.latest_verified_at !== null) target.latestVerifiedAt = asIso(row.latest_verified_at);
        targets[row.provider_role] = Object.freeze(target);
      }
      await client.query('COMMIT');
      return Object.freeze({
        storageObjectId: first.storage_object_id,
        managedAppId: first.managed_app_id,
        registryState: first.registry_state,
        objectProtectionStage: first.object_protection_stage,
        verifiedChecksumSha256: first.verified_checksum_sha256,
        verifiedByteLength,
        verifiedContentType: first.expected_content_type,
        targets: Object.freeze(targets),
      });
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original bounded error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async beginReadAttempt(input: Readonly<ObjectReadAttemptInput>): Promise<string> {
    const providerAttemptId = this.#createId();
    const now = this.#now();
    const operationReference = `read:${input.grant.objectReadGrantId}:${input.requestId}`;
    requireSafeString(operationReference, 'invalid-read-operation-reference', { max: 128 });
    await transaction(this.#pool, async (client) => {
      await client.query(
        `INSERT INTO public.storage_provider_attempts
           (storage_provider_attempt_id, storage_object_copy_id, storage_object_id,
            operation, operation_reference, attempt_number, state, retryable,
            expected_checksum_sha256, expected_byte_length, started_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'read', $4, $5, 'in_progress', false, $6, $7, $8, $8, $8)`,
        [
          providerAttemptId,
          input.target.storageObjectCopyId,
          input.grant.storageObjectId,
          operationReference,
          input.attemptNumber,
          input.expectedChecksumSha256,
          input.expectedByteLength,
          now,
        ],
      );
    });
    return providerAttemptId;
  }

  async completeReadAttempt(input: {
    providerAttemptId: string;
    succeeded: boolean;
    retryable?: boolean;
    safeDiagnostic?: Readonly<SafeDiagnostic>;
    observedChecksumSha256?: string;
    observedByteLength?: number;
  }): Promise<void> {
    requireUuid(input.providerAttemptId, 'invalid-provider-attempt-id');
    const now = this.#now();
    await transaction(this.#pool, async (client) => {
      const result = await client.query(
        `UPDATE public.storage_provider_attempts
            SET state = $2,
                retryable = $3,
                observed_checksum_sha256 = $4,
                observed_byte_length = $5,
                safe_diagnostic_category = $6,
                safe_diagnostic_code = $7,
                finished_at = $8,
                verified_at = CASE WHEN $2 = 'succeeded' THEN $8 ELSE NULL END,
                updated_at = $8
          WHERE storage_provider_attempt_id = $1
            AND operation = 'read'
            AND state = 'in_progress'`,
        [
          input.providerAttemptId,
          input.succeeded ? 'succeeded' : 'failed',
          input.retryable === true,
          input.observedChecksumSha256 ?? null,
          input.observedByteLength ?? null,
          input.safeDiagnostic?.category ?? null,
          input.safeDiagnostic?.code ?? null,
          now,
        ],
      );
      if (result.rowCount !== 1) {
        throw new ObjectReadGrantError('duplicate-conflict', 'read-attempt-state-conflict', 409);
      }
    });
  }

  async appendReadEvent(input: {
    eventId?: string;
    dedupeKey: string;
    eventType: string;
    grant: Readonly<ObjectReadGrantSnapshot>;
    occurredAt: Date;
    payload: Readonly<Record<string, unknown>>;
    diagnostic?: Readonly<SafeDiagnostic>;
  }): Promise<void> {
    await transaction(this.#pool, async (client) => this.#appendEvent(client, input));
  }

  async #appendEvent(
    client: PostgresQueryable,
    input: {
      eventId?: string;
      dedupeKey: string;
      eventType: string;
      grant: Readonly<ObjectReadGrantSnapshot>;
      occurredAt: Date;
      payload: Readonly<Record<string, unknown>>;
      diagnostic?: Readonly<SafeDiagnostic>;
    },
  ): Promise<void> {
    if (!SAFE_DEDUPE_PATTERN.test(input.dedupeKey) || !SAFE_EVENT_TYPE_PATTERN.test(input.eventType)) {
      throw new ObjectReadGrantError('internal', 'invalid-read-event-envelope', 500);
    }
    const serialized = JSON.stringify(input.payload);
    if (serialized.length > 8192 || /token|credential|secret|endpoint|bucket|locator|object_key|signed_url/i.test(serialized)) {
      throw new ObjectReadGrantError('internal', 'unsafe-read-event-payload', 500);
    }
    await client.query(
      `INSERT INTO public.storage_operation_events
         (storage_operation_event_id, dedupe_key, event_type, contract_version, occurred_at,
          managed_app_id, caller_service_id, storage_object_id, app_correlation_ref,
          safe_payload, safe_diagnostic_category, safe_diagnostic_code, created_at)
       VALUES ($1, $2, $3, '1.0', $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $4)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        input.eventId ?? this.#createId(),
        input.dedupeKey,
        input.eventType,
        input.occurredAt,
        input.grant.managedAppId,
        input.grant.callerServiceId ?? null,
        input.grant.storageObjectId,
        input.grant.appCorrelationReference,
        serialized,
        input.diagnostic?.category ?? null,
        input.diagnostic?.code ?? null,
      ],
    );
  }
}

export function createObjectReadGrantClaims(input: {
  grant: Readonly<ObjectReadGrantSnapshot>;
  contractVersion: ContractVersion;
}): Readonly<ObjectReadGrantClaims> {
  const claims: ObjectReadGrantClaims = {
    purpose: READ_GRANT_TOKEN_PURPOSE,
    objectReadGrantId: input.grant.objectReadGrantId,
    storageObjectId: input.grant.storageObjectId,
    callerAppId: input.grant.callerAppId,
    grantPurpose: input.grant.purpose,
    allowedMethods: input.grant.allowedMethods,
    allowRange: input.grant.allowRange,
    disposition: input.grant.disposition,
    contractVersion: input.contractVersion,
    expiresAt: input.grant.expiresAt,
  };
  if (input.grant.callerServiceId !== undefined) claims.callerServiceId = input.grant.callerServiceId;
  if (input.grant.fileName !== undefined) claims.fileName = input.grant.fileName;
  return Object.freeze(claims);
}
