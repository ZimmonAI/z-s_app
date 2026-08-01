import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { HttpStorageRuntime } from './runtime-contract.js';
import { storageControlFormErrorCode, storageControlPlanInputFromForm } from './storage-control-form.js';
import { buildStorageControlPlan, storageControlPlanErrorCode } from './storage-control-plan.js';
import { loginPage, storagePlannerPage, storagePlanResultPage } from './storage-control-pages.js';

const SESSION_COOKIE = 'zs_control_session';
const SESSION_SUBJECT = 'z-s-control';
const SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface ControlPlaneUiOptions {
  readonly adminPassword?: string;
  readonly sessionSigningKey?: string;
  readonly now?: () => Date;
}

class ControlPlaneUiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = 'ControlPlaneUiError';
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function configured(options: Readonly<ControlPlaneUiOptions>): boolean {
  return options.adminPassword !== undefined && options.sessionSigningKey !== undefined;
}

function html(body: string, status = 200, headers?: HeadersInit): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...(headers ?? {}),
    },
  });
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(headers ?? {}),
    },
  });
}

function wantsJson(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json');
}

function redirect(location: string, headers?: HeadersInit): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      'cache-control': 'no-store',
      ...(headers ?? {}),
    },
  });
}

function safeEquals(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function sign(payload: string, signingKey: string): string {
  return createHmac('sha256', signingKey).update(payload, 'utf8').digest('base64url');
}

function issueSession(signingKey: string, now: Date): string {
  const claims = {
    sub: SESSION_SUBJECT,
    exp: now.getTime() + SESSION_TTL_SECONDS * 1000,
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, signingKey)}`;
}

function cookieValue(request: Request): string | undefined {
  const raw = request.headers.get('cookie');
  if (raw === null) return undefined;
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const name = trimmed.slice(0, separator);
    if (name === SESSION_COOKIE) return trimmed.slice(separator + 1);
  }
  return undefined;
}

function sessionCookie(request: Request, value: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

function validSession(
  request: Request,
  options: Readonly<ControlPlaneUiOptions>,
  now: Date,
): boolean {
  if (options.sessionSigningKey === undefined) return false;
  const token = cookieValue(request);
  if (token === undefined) return false;
  const parts = token.split('.');
  const payload = parts[0];
  const signature = parts[1];
  if (payload === undefined || signature === undefined || parts.length !== 2) return false;
  if (!safeEquals(sign(payload, options.sessionSigningKey), signature)) return false;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!isRecord(claims)) return false;
    const expiresAt = claims.exp;
    return (
      claims.sub === SESSION_SUBJECT &&
      typeof expiresAt === 'number' &&
      Number.isSafeInteger(expiresAt) &&
      expiresAt > now.getTime()
    );
  } catch (error) {
    if (error instanceof Error) return false;
    return false;
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      throw new ControlPlaneUiError(400, 'invalid-json');
    }
    throw error;
  }
}

async function readPassword(request: Request): Promise<string> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.toLowerCase().startsWith('application/json')) {
    const payload = await readJson(request);
    if (isRecord(payload) && typeof payload.password === 'string') return payload.password;
    throw new ControlPlaneUiError(400, 'invalid-password');
  }
  const params = new URLSearchParams(await request.text());
  const password = params.get('operatorPassphrase');
  if (password === null) throw new ControlPlaneUiError(400, 'invalid-password');
  return password;
}

async function readPlanPayload(request: Request): Promise<unknown> {
  if (wantsJson(request)) return readJson(request);
  const params = new URLSearchParams(await request.text());
  const payload = params.get('payload');
  if (payload === null) return storageControlPlanInputFromForm(params);
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) throw new ControlPlaneUiError(400, 'invalid-json');
    throw error;
  }
}

function authenticated(request: Request, options: Readonly<ControlPlaneUiOptions>, now: Date): boolean {
  return configured(options) && validSession(request, options, now);
}

export function createControlPlaneUiRuntime(
  storageRuntime: HttpStorageRuntime,
  options: ControlPlaneUiOptions = {},
): HttpStorageRuntime {
  const now = options.now ?? (() => new Date());

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const snapshot = now();
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        return redirect(authenticated(request, options, snapshot) ? '/admin/storage' : '/login');
      }
      if (request.method === 'GET' && url.pathname === '/login') {
        return html(loginPage(configured(options)));
      }
      if (request.method === 'GET' && url.pathname === '/favicon.ico') {
        return new Response(null, { status: 204, headers: { 'cache-control': 'public, max-age=86400' } });
      }
      if (request.method === 'POST' && url.pathname === '/admin/session') {
        if (!configured(options)) throw new ControlPlaneUiError(503, 'control-login-not-configured');
        const password = await readPassword(request);
        if (!safeEquals(password, options.adminPassword ?? '')) {
          throw new ControlPlaneUiError(401, 'invalid-control-password');
        }
        const token = issueSession(options.sessionSigningKey ?? '', snapshot);
        const cookie = sessionCookie(request, token, SESSION_TTL_SECONDS);
        if (wantsJson(request)) {
          return new Response(null, { status: 204, headers: { 'set-cookie': cookie } });
        }
        return redirect('/admin/storage', { 'set-cookie': cookie });
      }
      if (request.method === 'DELETE' && url.pathname === '/admin/session') {
        return new Response(null, {
          status: 204,
          headers: { 'set-cookie': sessionCookie(request, '', 0) },
        });
      }
      if (request.method === 'GET' && url.pathname === '/admin/storage') {
        if (!authenticated(request, options, snapshot)) return redirect('/login');
        return html(storagePlannerPage());
      }
      if (request.method === 'POST' && url.pathname === '/admin/storage/plans') {
        if (!authenticated(request, options, snapshot)) return json({ error: { code: 'login-required' } }, 401);
        const plan = buildStorageControlPlan(await readPlanPayload(request));
        if (wantsJson(request)) {
          return json({ result: plan });
        }
        return html(storagePlanResultPage(plan));
      }
      return storageRuntime.handle(request);
    } catch (error) {
      if (error instanceof ControlPlaneUiError) {
        if (wantsJson(request)) {
          return json({ error: { code: error.code } }, error.status);
        }
        if (url.pathname === '/admin/storage/plans') {
          return html(storagePlannerPage(error.code), error.status);
        }
        return html(loginPage(configured(options), error.code), error.status);
      }
      const formCode = storageControlFormErrorCode(error);
      const code = formCode === 'internal-error' ? storageControlPlanErrorCode(error) : formCode;
      if (code !== 'internal-error') {
        if (wantsJson(request)) return json({ error: { code } }, 400);
        if (url.pathname === '/admin/storage/plans') return html(storagePlannerPage(code), 400);
        return json({ error: { code } }, 400);
      }
      throw error;
    }
  }

  return Object.freeze({
    handle,
    health: () => storageRuntime.health(),
    readiness: () => storageRuntime.readiness(),
  });
}
