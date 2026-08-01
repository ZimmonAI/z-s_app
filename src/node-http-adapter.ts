import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { CONTROL_REQUEST_BODY_LIMIT_BYTES } from './control-plane-ui-request.js';
import type { HttpStorageRuntime } from './runtime-contract.js';

type NodeRequestInit = RequestInit & { readonly duplex?: 'half' };

class NodeRequestBodyTooLargeError extends Error {
  constructor() {
    super('request-body-too-large');
    this.name = 'NodeRequestBodyTooLargeError';
  }
}

function requestUrl(request: IncomingMessage): string {
  const host = request.headers.host ?? '127.0.0.1';
  const forwardedProtocol = request.headers['x-forwarded-proto']?.toString().split(',')[0]?.trim();
  const protocol = forwardedProtocol === 'https' ? 'https' : 'http';
  return `${protocol}://${host}${request.url ?? '/'}`;
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

function controlRequestBodyLimit(pathname: string): number | undefined {
  switch (pathname) {
    case '/admin/session':
    case '/admin/storage/plans':
    case '/client/session':
      return CONTROL_REQUEST_BODY_LIMIT_BYTES;
    default:
      return undefined;
  }
}

async function requestBody(
  request: IncomingMessage,
  maximumByteLength?: number,
): Promise<ArrayBuffer> {
  const contentLength = request.headers['content-length'];
  if (
    maximumByteLength !== undefined &&
    contentLength !== undefined &&
    Number(contentLength) > maximumByteLength
  ) {
    request.resume();
    throw new NodeRequestBodyTooLargeError();
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let oversized = false;

    request.on('data', (chunk: Buffer | string) => {
      if (oversized) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.byteLength;
      if (maximumByteLength !== undefined && byteLength > maximumByteLength) {
        oversized = true;
        request.resume();
        reject(new NodeRequestBodyTooLargeError());
        return;
      }
      chunks.push(buffer);
    });
    request.on('end', () => {
      if (oversized) return;
      const body = Buffer.concat(chunks);
      resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    });
    request.on('error', (error: Error) => {
      if (!oversized) reject(error);
    });
  });
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const method = request.method ?? 'GET';
  const url = requestUrl(request);
  const init: NodeRequestInit = {
    method,
    headers: requestHeaders(request),
  };
  if (method !== 'GET' && method !== 'HEAD') {
    const requestWithBodyInit: NodeRequestInit = {
      ...init,
      body: await requestBody(request, controlRequestBodyLimit(new URL(url).pathname)),
      duplex: 'half',
    };
    return new Request(url, requestWithBodyInit);
  }
  return new Request(url, init);
}

async function sendResponse(response: Response, output: ServerResponse): Promise<void> {
  output.statusCode = response.status;
  for (const [name, value] of response.headers) output.setHeader(name, value);
  const body = response.body;
  if (body === null) {
    output.end();
    return;
  }
  const reader = body.getReader();
  let next = await reader.read();
  while (!next.done) {
    output.write(Buffer.from(next.value));
    next = await reader.read();
  }
  output.end();
}

function sendRequestBodyTooLarge(output: ServerResponse): void {
  output.writeHead(413, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  output.end(JSON.stringify({ error: { code: 'request-body-too-large' } }));
}

export function createNodeHttpHandler(runtime: HttpStorageRuntime): RequestListener {
  return (request, response) => {
    void toWebRequest(request).then((webRequest) => runtime.handle(webRequest)).then(
      (runtimeResponse) => sendResponse(runtimeResponse, response),
      (error: unknown) => {
        if (error instanceof NodeRequestBodyTooLargeError) {
          sendRequestBodyTooLarge(response);
          return;
        }
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          error: {
            diagnostic: { category: 'internal', code: 'internal-error', retryable: false },
          },
        }));
      },
    );
  };
}
