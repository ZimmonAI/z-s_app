import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { HttpStorageRuntime } from './runtime-contract.js';

type NodeRequestInit = RequestInit & { readonly duplex?: 'half' };

function requestUrl(request: IncomingMessage): string {
  const host = request.headers.host ?? '127.0.0.1';
  return `http://${host}${request.url ?? '/'}`;
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

async function requestBody(request: IncomingMessage): Promise<ArrayBuffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const method = request.method ?? 'GET';
  const init: NodeRequestInit = {
    method,
    headers: requestHeaders(request),
  };
  if (method !== 'GET' && method !== 'HEAD') {
    const requestWithBodyInit: NodeRequestInit = {
      ...init,
      body: await requestBody(request),
      duplex: 'half',
    };
    return new Request(requestUrl(request), requestWithBodyInit);
  }
  return new Request(requestUrl(request), init);
}

async function sendResponse(response: Response, output: ServerResponse): Promise<void> {
  output.statusCode = response.status;
  for (const [name, value] of response.headers) {
    output.setHeader(name, value);
  }
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

export function createNodeHttpHandler(runtime: HttpStorageRuntime): RequestListener {
  return (request, response) => {
    void toWebRequest(request).then((webRequest) => runtime.handle(webRequest)).then(
      (runtimeResponse) => sendResponse(runtimeResponse, response),
      () => {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: { diagnostic: { category: 'internal', code: 'internal-error', retryable: false } } }));
      },
    );
  };
}
