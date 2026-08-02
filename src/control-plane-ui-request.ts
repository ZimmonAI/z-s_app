import { storageControlPlanInputFromForm } from './storage-control-form.js';

export const CONTROL_REQUEST_BODY_LIMIT_BYTES = 16 * 1024;

export class ControlPlaneUiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = 'ControlPlaneUiError';
    this.status = status;
    this.code = code;
  }
}

export interface ClientCredentialInput {
  readonly clientId: string;
  readonly clientCredential: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function wantsJson(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json');
}

async function readBoundedText(request: Request): Promise<string> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > CONTROL_REQUEST_BODY_LIMIT_BYTES) {
      throw new ControlPlaneUiError(413, 'request-body-too-large');
    }
  }
  const reader = request.body?.getReader();
  if (reader === undefined) return '';
  const decoder = new TextDecoder();
  let byteLength = 0;
  let result = '';
  let next = await reader.read();
  while (!next.done) {
    byteLength += next.value.byteLength;
    if (byteLength > CONTROL_REQUEST_BODY_LIMIT_BYTES) {
      await reader.cancel();
      throw new ControlPlaneUiError(413, 'request-body-too-large');
    }
    result += decoder.decode(next.value, { stream: true });
    next = await reader.read();
  }
  return result + decoder.decode();
}

async function readJson(request: Request): Promise<unknown> {
  const text = await readBoundedText(request);
  try {
    const payload: unknown = JSON.parse(text);
    return payload;
  } catch (error) {
    if (error instanceof SyntaxError) throw new ControlPlaneUiError(400, 'invalid-json');
    throw error;
  }
}

export async function readControlJsonPayload(request: Request): Promise<unknown> {
  if (!wantsJson(request)) throw new ControlPlaneUiError(415, 'json-content-type-required');
  return readJson(request);
}

export async function readPassword(request: Request): Promise<string> {
  if (wantsJson(request)) {
    const payload = await readJson(request);
    if (isRecord(payload) && typeof payload.password === 'string') return payload.password;
    throw new ControlPlaneUiError(400, 'invalid-password');
  }
  const params = new URLSearchParams(await readBoundedText(request));
  const password = params.get('operatorPassphrase');
  if (password === null) throw new ControlPlaneUiError(400, 'invalid-password');
  return password;
}

export async function readClientCredential(
  request: Request,
): Promise<Readonly<ClientCredentialInput>> {
  if (wantsJson(request)) {
    const payload = await readJson(request);
    if (
      isRecord(payload) &&
      typeof payload.clientId === 'string' &&
      typeof payload.clientCredential === 'string'
    ) {
      return Object.freeze({
        clientId: payload.clientId,
        clientCredential: payload.clientCredential,
      });
    }
    throw new ControlPlaneUiError(400, 'invalid-client-credential');
  }
  const params = new URLSearchParams(await readBoundedText(request));
  const clientId = params.get('clientId');
  const clientCredential = params.get('clientCredential');
  if (clientId === null || clientCredential === null) {
    throw new ControlPlaneUiError(400, 'invalid-client-credential');
  }
  return Object.freeze({ clientId, clientCredential });
}

export async function readPlanPayload(request: Request): Promise<unknown> {
  if (wantsJson(request)) return readJson(request);
  const params = new URLSearchParams(await readBoundedText(request));
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
