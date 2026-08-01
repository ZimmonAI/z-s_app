import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request as nodeRequest } from 'node:http';
import test from 'node:test';
import type {
  ClientCredentialAuthenticationResult,
  ClientCredentialAuthenticator,
} from '../src/client-control-auth.js';
import { createControlPlaneUiRuntime } from '../src/control-plane-ui.js';
import { CONTROL_REQUEST_BODY_LIMIT_BYTES } from '../src/control-plane-ui-request.js';
import { createNodeHttpHandler } from '../src/node-http-adapter.js';
import type { HttpStorageRuntime } from '../src/runtime-contract.js';

const SIGNING_KEY = 'control-session-signing-key-2026';
const ADMIN_PASSWORD = 'operator-passphrase';

const storageRuntime: HttpStorageRuntime = Object.freeze({
  async handle(): Promise<Response> {
    return new Response('not-found', { status: 404 });
  },
  async health() {
    return {
      serviceId: 'z-s' as const,
      packageVersion: '0.5.0' as const,
      contractVersion: '1.0' as const,
      process: 'healthy' as const,
      checkedAt: '2026-08-01T00:00:00.000Z',
    };
  },
  async readiness() {
    return {
      serviceId: 'z-s' as const,
      process: 'healthy' as const,
      controlPlane: { status: 'ready' as const },
      dataPlane: { status: 'ready' as const },
      status: 'ready' as const,
      checkedAt: '2026-08-01T00:00:00.000Z',
    };
  },
});

class RejectingClientAuthenticator implements ClientCredentialAuthenticator {
  readonly configured = true;

  async authenticate(): Promise<Readonly<ClientCredentialAuthenticationResult>> {
    return Object.freeze({ kind: 'invalid' });
  }
}

test('client session rejects oversized login bodies before parsing', async () => {
  const runtime = createControlPlaneUiRuntime(storageRuntime, {
    sessionSigningKey: SIGNING_KEY,
    clientCredentialAuthenticator: new RejectingClientAuthenticator(),
  });
  const response = await runtime.handle(new Request('https://z-s.zimmon.ai/client/session', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `clientId=video-maker_app&clientCredential=${'x'.repeat(CONTROL_REQUEST_BODY_LIMIT_BYTES)}`,
  }));
  assert.equal(response.status, 413);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(await response.text(), /request-body-too-large/);
});

test('Node adapter rejects oversized client session bodies without content-length before runtime dispatch', async () => {
  let dispatchCount = 0;
  const runtime: HttpStorageRuntime = Object.freeze({
    async handle(): Promise<Response> {
      dispatchCount += 1;
      return new Response(null, { status: 204 });
    },
    async health() {
      return {
        serviceId: 'z-s' as const,
        packageVersion: '0.5.0' as const,
        contractVersion: '1.0' as const,
        process: 'healthy' as const,
        checkedAt: '2026-08-01T00:00:00.000Z',
      };
    },
    async readiness() {
      return {
        serviceId: 'z-s' as const,
        process: 'healthy' as const,
        controlPlane: { status: 'ready' as const },
        dataPlane: { status: 'ready' as const },
        status: 'ready' as const,
        checkedAt: '2026-08-01T00:00:00.000Z',
      };
    },
  });
  const server = createServer(createNodeHttpHandler(runtime));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    const result = await new Promise<Readonly<{ status: number; body: string }>>((resolve, reject) => {
      const request = nodeRequest({
        host: '127.0.0.1',
        port: address.port,
        path: '/client/session',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      request.on('error', reject);
      request.write('x'.repeat(9_000));
      request.write('y'.repeat(9_000));
      request.end();
    });
    assert.equal(result.status, 413);
    assert.match(result.body, /request-body-too-large/);
    assert.equal(dispatchCount, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    }));
  }
});

test('client login throttling is separate from operator login throttling', async () => {
  const runtime = createControlPlaneUiRuntime(storageRuntime, {
    adminPassword: ADMIN_PASSWORD,
    sessionSigningKey: SIGNING_KEY,
    clientCredentialAuthenticator: new RejectingClientAuthenticator(),
  });
  for (let index = 0; index < 5; index += 1) {
    const failed = await runtime.handle(new Request('https://z-s.zimmon.ai/client/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.10',
      },
      body: JSON.stringify({ clientId: 'video-maker_app', clientCredential: `wrong-${index}` }),
    }));
    assert.equal(failed.status, 401);
  }
  const limited = await runtime.handle(new Request('https://z-s.zimmon.ai/client/session', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.10',
    },
    body: JSON.stringify({ clientId: 'video-maker_app', clientCredential: 'wrong-final' }),
  }));
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: { code: 'client-login-rate-limited' } });

  const operator = await runtime.handle(new Request('https://z-s.zimmon.ai/admin/session', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.10',
    },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  }));
  assert.equal(operator.status, 204);
  assert.ok(operator.headers.get('set-cookie')?.startsWith('zs_control_session='));
});
