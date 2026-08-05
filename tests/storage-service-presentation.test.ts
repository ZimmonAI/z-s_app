import assert from 'node:assert/strict';
import test from 'node:test';
import { storageServiceDetailPage } from '../src/storage-service-presentation.js';
import { completeCapabilities } from '../src/storage-service.js';

test('storage service detail renders lifecycle and dependency state without private provider values', () => {
  const page = storageServiceDetailPage(
    { clientId: 'client-a', displayLabel: 'Client A' },
    {
      id: 'internal-id',
      serviceId: 'r2-main',
      clientId: 'client-a',
      environment: 'dev',
      displayName: 'R2 main',
      providerType: 'cloudflare-r2',
      ownership: 'client-owned',
      status: 'ready',
      safeMetadata: { accountLabel: 'Account' },
      capabilities: completeCapabilities({ objectWrite: true, objectRead: true }),
      lastTestStatus: 'passed',
      lastTestedAt: '2026-08-05T00:00:00.000Z',
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
    },
    {
      draftConfigurationCount: 1,
      activeConfigurationCount: 0,
      vaultCount: 1,
      routeCount: 1,
      objectCopyCount: 0,
      derivativeOutputCount: 0,
    },
  );
  assert.match(page, /storage service management/i);
  assert.match(page, /Create configuration draft/);
  assert.equal(page.includes('test-secret-access-key'), false);
  assert.equal(page.includes('internal-id'), false);
});
