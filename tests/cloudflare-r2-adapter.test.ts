import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { CloudflareR2Adapter } from '../src/cloudflare-r2-adapter.js';

const credentials = Object.freeze({
  accountId: '0123456789abcdef0123456789abcdef',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-access-key',
  bucket: 'test-bucket',
});

test('R2 manifest is provider-neutral and connection test stays inside one exact prefix', async () => {
  const commands: unknown[] = [];
  const adapter = new CloudflareR2Adapter({
    nonce: () => 'fixed-nonce',
    now: () => new Date('2026-08-05T00:00:00Z'),
    createClient: () => ({
      async send(command: unknown): Promise<Record<string, unknown>> {
        commands.push(command);
        return command instanceof HeadObjectCommand ? { ContentLength: 1 } : {};
      },
    }),
  });
  const manifest = adapter.getProviderManifest();
  assert.equal(manifest.providerType, 'cloudflare-r2');
  assert.equal(manifest.capabilities.rangeRead, true);
  assert.equal(manifest.forbiddenOutputs.includes('rawCredential'), true);

  const result = await adapter.testConnection({
    clientId: 'client-a',
    environment: 'dev',
    serviceId: 'r2-main',
    credentials,
    testScope: { prefix: 'client-a/tests' },
  });
  assert.equal(result.connected, true);
  assert.equal(commands.length, 3);
  assert.ok(commands[0] instanceof PutObjectCommand);
  assert.ok(commands[1] instanceof HeadObjectCommand);
  assert.ok(commands[2] instanceof DeleteObjectCommand);
});

test('R2 provider errors normalize without credential or endpoint leakage', async () => {
  const adapter = new CloudflareR2Adapter({
    createClient: () => ({
      async send(): Promise<Record<string, unknown>> {
        throw { $metadata: { httpStatusCode: 403 }, message: 'contains-private-provider-detail' };
      },
    }),
  });
  const result = await adapter.testConnection({
    clientId: 'client-a',
    environment: 'dev',
    serviceId: 'r2-main',
    credentials,
    testScope: { prefix: 'bounded' },
  });
  assert.equal(result.connected, false);
  assert.equal(result.diagnosticCode, 'r2-authentication-failed');
  assert.equal(JSON.stringify(result).includes('private-provider-detail'), false);
});
