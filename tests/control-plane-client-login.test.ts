import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type {
  ClientCredentialAuthenticationResult,
  ClientCredentialAuthenticator,
} from '../src/client-control-auth.js';
import { createControlPlaneUiRuntime } from '../src/control-plane-ui.js';
import type { HttpStorageRuntime } from '../src/runtime-contract.js';
import { createVideoMakerControlRuntimeComposition } from '../src/runtime-control-composition.js';

const CLIENT_CREDENTIAL = 'fixture-browser-credential';
const ADMIN_PASSPHRASE = 'operator-passphrase';
const SIGNING_KEY = 'control-session-signing-key-2026';
const NOW = new Date('2026-08-01T00:00:00.000Z');

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

class FakeClientAuthenticator implements ClientCredentialAuthenticator {
  readonly configured = true;

  async authenticate(input: Readonly<{
    clientId: string;
    clientCredential: string;
    now: Date;
  }>): Promise<Readonly<ClientCredentialAuthenticationResult>> {
    if (
      input.clientId === 'video-maker_app' &&
      input.clientCredential === CLIENT_CREDENTIAL
    ) {
      return Object.freeze({
        kind: 'authenticated',
        clientId: 'video-maker_app',
        displayLabel: 'Video Maker',
      });
    }
    return Object.freeze({ kind: 'invalid' });
  }
}

function runtime(): HttpStorageRuntime {
  return createControlPlaneUiRuntime(storageRuntime, {
    adminPassword: ADMIN_PASSPHRASE,
    sessionSigningKey: SIGNING_KEY,
    clientCredentialAuthenticator: new FakeClientAuthenticator(),
    now: () => NOW,
  });
}

function requestCookie(setCookie: string): string {
  return setCookie.split(';')[0] ?? '';
}

test('client login renders configured video-maker account form', async () => {
  const response = await runtime().handle(new Request('https://z-s.zimmon.ai/client/login'));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Client login/);
  assert.match(body, /name="clientId"/);
  assert.match(body, /name="clientCredential"/);
  assert.doesNotMatch(body, /operatorPassphrase|operator-passphrase/);
});

test('client login form parse errors stay on the client login surface', async () => {
  const response = await runtime().handle(new Request('https://z-s.zimmon.ai/client/session', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ clientId: 'video-maker_app' }),
  }));
  assert.equal(response.status, 400);
  const body = await response.text();
  assert.match(body, /invalid-client-credential/);
  assert.doesNotMatch(body, /Operator passphrase|operatorPassphrase|\/admin\/session/);
});

test('client login authenticates video-maker_app and renders client storage page', async () => {
  const ui = runtime();
  const session = await ui.handle(new Request('https://z-s.zimmon.ai/client/session', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      clientId: 'video-maker_app',
      clientCredential: CLIENT_CREDENTIAL,
    }),
  }));
  assert.equal(session.status, 302);
  assert.equal(session.headers.get('location'), '/client/storage');
  const setCookie = session.headers.get('set-cookie');
  assert.ok(setCookie !== null);
  assert.ok(setCookie.startsWith('zs_client_session='));

  const storage = await ui.handle(new Request('https://z-s.zimmon.ai/client/storage', {
    headers: { cookie: requestCookie(setCookie) },
  }));
  assert.equal(storage.status, 200);
  const body = await storage.text();
  assert.match(body, /Video Maker/);
  assert.match(body, /video-maker_app/);
});

test('client session cannot authorize admin storage and operator session cannot authorize client storage', async () => {
  const ui = runtime();
  const clientSession = await ui.handle(new Request('https://z-s.zimmon.ai/client/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'video-maker_app', clientCredential: CLIENT_CREDENTIAL }),
  }));
  const clientCookie = clientSession.headers.get('set-cookie');
  assert.ok(clientCookie !== null);

  const operatorSession = await ui.handle(new Request('https://z-s.zimmon.ai/admin/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSPHRASE }),
  }));
  const operatorCookie = operatorSession.headers.get('set-cookie');
  assert.ok(operatorCookie !== null);

  const adminWithClient = await ui.handle(new Request('https://z-s.zimmon.ai/admin/storage', {
    headers: { cookie: requestCookie(clientCookie) },
  }));
  assert.equal(adminWithClient.status, 302);
  assert.equal(adminWithClient.headers.get('location'), '/login');

  const clientWithOperator = await ui.handle(new Request('https://z-s.zimmon.ai/client/storage', {
    headers: { cookie: requestCookie(operatorCookie) },
  }));
  assert.equal(clientWithOperator.status, 302);
  assert.equal(clientWithOperator.headers.get('location'), '/client/login');
});

test('invalid client credential does not reveal whether the client exists', async () => {
  const response = await runtime().handle(new Request('https://z-s.zimmon.ai/client/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'unknown-client', clientCredential: 'wrong-fixture' }),
  }));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), { error: { code: 'invalid-client-credential' } });
});

test('client login shows not-configured when no client authenticator is wired', async () => {
  const composition = createVideoMakerControlRuntimeComposition({
    Z_S_CONTROL_SESSION_SIGNING_KEY: SIGNING_KEY,
  });
  try {
    const response = await composition.runtime.handle(
      new Request('https://z-s.zimmon.ai/client/login'),
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /client-login-not-configured/);
    assert.match(body, /<button[^>]+disabled/);
  } finally {
    await composition.close();
  }
});

test('client login bootstrap script contains no raw credential fixture', async () => {
  const script = await readFile('scripts/bootstrap-client-login.mjs', 'utf8');
  assert.match(script, /Z_S_CLIENT_BOOTSTRAP_CREDENTIAL/);
  assert.match(script, /createHash\('sha256'\)/);
  assert.doesNotMatch(script, /video-maker-secret|password|must-not-return/);
});
