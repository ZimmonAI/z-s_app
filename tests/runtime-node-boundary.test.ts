import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createVideoMakerNodeRuntimeServer } from '../src/runtime-node-server.js';

async function withRuntimeServer(
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const runtimeServer = createVideoMakerNodeRuntimeServer({
    Z_S_CONTROL_SESSION_SIGNING_KEY: 'tcp-boundary-session-signing-key-2026',
  });
  try {
    await new Promise<void>((resolve, reject) => {
      runtimeServer.server.once('error', reject);
      runtimeServer.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = runtimeServer.server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await runtimeServer.close();
  }
}

test('production Node runtime serves client routes and delegates unknown routes', async () => {
  await withRuntimeServer(async (origin) => {
    const login = await fetch(`${origin}/client/login`);
    assert.equal(login.status, 200);
    const loginBody = await login.text();
    assert.match(loginBody, /name="clientId"/);
    assert.match(loginBody, /name="clientCredential"/);
    assert.match(loginBody, /client-login-not-configured/);
    assert.doesNotMatch(loginBody, /Operator passphrase|operatorPassphrase|\/admin\/session/);

    const client = await fetch(`${origin}/client`, { redirect: 'manual' });
    assert.equal(client.status, 302);
    assert.equal(client.headers.get('location'), '/client/login');

    const unknown = await fetch(`${origin}/not-a-control-route`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), {
      error: {
        diagnostic: {
          category: 'invalid-request',
          code: 'route-not-found',
          retryable: false,
        },
      },
    });
  });
});
