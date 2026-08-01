import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface SignedSessionOptions {
  readonly cookieName: string;
  readonly subject: string;
  readonly ttlSeconds: number;
  readonly signingKey: string;
}

export interface SignedSessionClaims {
  readonly subject: string;
  readonly expiresAtMilliseconds: number;
}

export type SignedSessionVerificationOptions = Readonly<
  Pick<SignedSessionOptions, 'cookieName' | 'signingKey'>
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sign(payload: string, signingKey: string): string {
  return createHmac('sha256', signingKey).update(payload, 'utf8').digest('base64url');
}

function cookieValue(request: Request, cookieName: string): string | undefined {
  const raw = request.headers.get('cookie');
  if (raw === null) return undefined;
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    if (trimmed.slice(0, separator) === cookieName) return trimmed.slice(separator + 1);
  }
  return undefined;
}

export function safeEquals(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function issueSignedSession(
  options: Readonly<SignedSessionOptions>,
  now: Date,
): string {
  const claims = {
    sub: options.subject,
    exp: now.getTime() + options.ttlSeconds * 1000,
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, options.signingKey)}`;
}

export function readSignedSessionClaims(
  request: Request,
  options: SignedSessionVerificationOptions,
  now: Date,
): Readonly<SignedSessionClaims> | null {
  const token = cookieValue(request, options.cookieName);
  if (token === undefined) return null;
  const parts = token.split('.');
  const payload = parts[0];
  const signature = parts[1];
  if (payload === undefined || signature === undefined || parts.length !== 2) return null;
  if (!safeEquals(sign(payload, options.signingKey), signature)) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!isRecord(claims)) return null;
    const subject = claims.sub;
    const expiresAtMilliseconds = claims.exp;
    if (
      typeof subject !== 'string' ||
      typeof expiresAtMilliseconds !== 'number' ||
      !Number.isSafeInteger(expiresAtMilliseconds) ||
      expiresAtMilliseconds <= now.getTime()
    ) {
      return null;
    }
    return Object.freeze({ subject, expiresAtMilliseconds });
  } catch {
    return null;
  }
}

export function validSignedSession(
  request: Request,
  options: Readonly<SignedSessionOptions>,
  now: Date,
): boolean {
  const claims = readSignedSessionClaims(request, options, now);
  return claims !== null && claims.subject === options.subject;
}

export function sessionCookie(
  request: Request,
  cookieName: string,
  value: string,
  maxAgeSeconds: number,
): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${cookieName}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure}`;
}
