import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ContractVersion } from './runtime-contract.js';

export const UPLOAD_COMPLETION_TOKEN_PURPOSE = 'object-upload-completion' as const;

export interface UploadCompletionTokenClaims {
  purpose: typeof UPLOAD_COMPLETION_TOKEN_PURPOSE;
  objectWriteIntentId: string;
  storageObjectId: string;
  callerAppId: string;
  callerServiceId?: string;
  contractVersion: ContractVersion;
  expiresAt: string;
}

export interface UploadCompletionTokenExpectation {
  purpose?: typeof UPLOAD_COMPLETION_TOKEN_PURPOSE;
  objectWriteIntentId?: string;
  storageObjectId?: string;
  callerAppId?: string;
  callerServiceId?: string;
  contractVersion?: ContractVersion;
  now?: Date;
}

export interface UploadCompletionTokenService {
  issue(
    claims: Readonly<UploadCompletionTokenClaims>,
  ): string | Promise<string>;
  verify(
    token: string,
    expected?: Readonly<UploadCompletionTokenExpectation>,
  ):
    | Readonly<UploadCompletionTokenClaims>
    | Promise<Readonly<UploadCompletionTokenClaims>>;
}

export class UploadCompletionTokenError extends Error {
  readonly category = 'unauthenticated' as const;
  readonly status = 401;
  readonly retryable = false;
  readonly code: 'invalid-upload-completion-token' | 'upload-completion-token-expired';

  constructor(code: UploadCompletionTokenError['code']) {
    super(code);
    this.name = 'UploadCompletionTokenError';
    this.code = code;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

function rejectToken(): never {
  throw new UploadCompletionTokenError('invalid-upload-completion-token');
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) rejectToken();
  return value;
}

function requireSafeId(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) rejectToken();
  return value;
}

function requireIso(value: unknown): string {
  if (typeof value !== 'string') rejectToken();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) rejectToken();
  return value;
}

function normalizeClaims(value: unknown): Readonly<UploadCompletionTokenClaims> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) rejectToken();
  const record = value as Record<string, unknown>;
  if (record.purpose !== UPLOAD_COMPLETION_TOKEN_PURPOSE) rejectToken();
  if (record.contractVersion !== '1.0') rejectToken();

  const callerServiceId =
    record.callerServiceId === undefined
      ? undefined
      : requireSafeId(record.callerServiceId);
  const claims: UploadCompletionTokenClaims = {
    purpose: UPLOAD_COMPLETION_TOKEN_PURPOSE,
    objectWriteIntentId: requireUuid(record.objectWriteIntentId),
    storageObjectId: requireUuid(record.storageObjectId),
    callerAppId: requireSafeId(record.callerAppId),
    contractVersion: '1.0',
    expiresAt: requireIso(record.expiresAt),
  };
  if (callerServiceId !== undefined) claims.callerServiceId = callerServiceId;
  return Object.freeze(claims);
}

function encodePayload(claims: Readonly<UploadCompletionTokenClaims>): string {
  const payload = {
    purpose: claims.purpose,
    objectWriteIntentId: claims.objectWriteIntentId,
    storageObjectId: claims.storageObjectId,
    callerAppId: claims.callerAppId,
    ...(claims.callerServiceId === undefined
      ? {}
      : { callerServiceId: claims.callerServiceId }),
    contractVersion: claims.contractVersion,
    expiresAt: claims.expiresAt,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function assertExpected(
  claims: Readonly<UploadCompletionTokenClaims>,
  expected: Readonly<UploadCompletionTokenExpectation>,
): void {
  if ((expected.purpose ?? UPLOAD_COMPLETION_TOKEN_PURPOSE) !== claims.purpose) rejectToken();
  if (
    expected.objectWriteIntentId !== undefined &&
    expected.objectWriteIntentId !== claims.objectWriteIntentId
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

export function createDeterministicUploadCompletionTokenService(options: {
  signingKey: string;
  now?: () => Date;
}): UploadCompletionTokenService {
  if (typeof options.signingKey !== 'string' || options.signingKey.length < 16) {
    throw new TypeError('signingKey must contain at least 16 characters.');
  }
  const now = options.now ?? (() => new Date());

  return Object.freeze({
    issue(claimsInput: Readonly<UploadCompletionTokenClaims>): string {
      const claims = normalizeClaims(claimsInput);
      const payload = encodePayload(claims);
      const signature = createHmac('sha256', options.signingKey)
        .update(payload)
        .digest('base64url');
      return `${payload}.${signature}`;
    },

    verify(
      token: string,
      expected: Readonly<UploadCompletionTokenExpectation> = {},
    ): Readonly<UploadCompletionTokenClaims> {
      if (typeof token !== 'string' || token.length < 32 || token.length > 4096) rejectToken();
      const segments = token.split('.');
      if (segments.length !== 2) rejectToken();
      const payload = segments[0];
      const suppliedSignature = segments[1];
      if (payload === undefined || suppliedSignature === undefined) rejectToken();

      const expectedSignature = createHmac('sha256', options.signingKey)
        .update(payload)
        .digest();
      let suppliedSignatureBytes: Buffer;
      try {
        suppliedSignatureBytes = Buffer.from(suppliedSignature, 'base64url');
      } catch {
        rejectToken();
      }
      if (
        suppliedSignatureBytes.length !== expectedSignature.length ||
        !timingSafeEqual(suppliedSignatureBytes, expectedSignature)
      ) {
        rejectToken();
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      } catch {
        rejectToken();
      }
      const claims = normalizeClaims(parsed);
      assertExpected(claims, expected);
      const verificationTime = expected.now ?? now();
      if (new Date(claims.expiresAt).getTime() <= verificationTime.getTime()) {
        throw new UploadCompletionTokenError('upload-completion-token-expired');
      }
      return claims;
    },
  });
}
