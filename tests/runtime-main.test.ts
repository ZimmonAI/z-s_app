import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { createHttpStorageRuntime } from '../src/index.js';
import { createNodeHttpHandler } from '../src/node-http-adapter.js';

test('operator command and Zimspace manifest expose the local Z-s runtime', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
    readonly scripts?: Record<string, string>;
  };
  const manifest = JSON.parse(await readFile('zimspace.app.json', 'utf8')) as {
    readonly projects?: readonly {
      readonly apps?: readonly {
        readonly id?: string;
        readonly port?: number;
        readonly startCommand?: string;
        readonly healthCheckUrl?: string;
        readonly publicUrl?: string;
        readonly actionsEnabled?: boolean;
      }[];
    }[];
  };

  const runtimeApp = manifest.projects
    ?.flatMap((project) => project.apps ?? [])
    .find((app) => app.id === 'z-s-runtime-api');

  assert.equal(packageJson.scripts?.['local:start'], 'npm run build && node --enable-source-maps dist/runtime-main.js');
  assert.equal(runtimeApp?.port, 4310);
  assert.equal(runtimeApp?.startCommand, 'npm run local:start');
  assert.equal(runtimeApp?.healthCheckUrl, 'http://127.0.0.1:4310/healthz');
  assert.equal(runtimeApp?.publicUrl, 'https://z-s.zimmon.ai');
  assert.equal(runtimeApp?.actionsEnabled, true);
});

test('Node HTTP adapter serves health and preserves auth failures', async () => {
  const runtime = createHttpStorageRuntime({
    authenticate: () => null,
    authorizeCaller: () => false,
    resolveStorageProfile: () => {
      throw new Error('not used');
    },
    createObjectWriteIntent: () => {
      throw new Error('not used');
    },
    controlPlaneReadiness: () => ({ status: 'ready' }),
    dataPlaneReadiness: () => ({ status: 'ready' }),
  });
  const server = createServer(createNodeHttpHandler(runtime));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(typeof address === 'object' && address !== null);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    const healthBody = await health.json() as Record<string, unknown>;
    assert.equal(healthBody.serviceId, 'z-s');

    const protectedResponse = await fetch(`${baseUrl}/v1/object-write-intents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-zs-contract-version': '1.0',
      },
      body: '{}',
    });
    assert.equal(protectedResponse.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve();
      });
    });
  }
});
