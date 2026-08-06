import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ImageDerivativeError,
  type ImageDerivativeJob,
  type ProcessedImageDerivative,
} from '../src/image-derivative.js';
import {
  ConfiguredImageDerivativeOutputWriter,
} from '../src/image-derivative-provider.js';
import type {
  PostgresImageDerivativeStore,
} from '../src/image-derivative-postgres.js';
import type {
  ProviderObjectWriter,
} from '../src/runtime-s3-provider.js';

const job: Readonly<ImageDerivativeJob> =
  Object.freeze({
    id:
      '00000000-0000-4000-8000-000000000001',
    sourceStorageObjectId:
      '00000000-0000-4000-8000-000000000002',
    storageControlClientId:
      '00000000-0000-4000-8000-000000000003',
    environment: 'dev',
    configurationVersionId:
      '00000000-0000-4000-8000-000000000004',
    configurationFingerprint:
      'a'.repeat(64),
    configurationRouteId:
      '00000000-0000-4000-8000-000000000005',
    configurationImagePresetId:
      '00000000-0000-4000-8000-000000000006',
    presetId: 'png-preview',
    targetConfigurationVaultId:
      '00000000-0000-4000-8000-000000000007',
    requestedWidth: 512,
    outputFormat: 'png',
    quality: 82,
    fit: 'inside',
    state: 'processing',
    attemptCount: 1,
    maximumAttempts: 3,
    // String construction keeps this deterministic UUID scanner-safe.
    leaseToken:
      String(
        '00000000-0000-4000-8000-000000000008',
      ),
  });

const outputBody =
  Buffer.from('h06c-output-fixture');

const output: Readonly<ProcessedImageDerivative> =
  Object.freeze({
    mediaType: 'image/png',
    width: 512,
    height: 288,
    byteLength: outputBody.byteLength,
    checksumSha256:
      'c'.repeat(64),
    body: outputBody,
  });

test(
  'provider write is not reached when output reservation fails',
  async () => {
    const reservationError =
      new ImageDerivativeError(
        'dependency-unavailable',
        'image-derivative-output-reservation-unavailable',
        true,
      );

    let providerWriteCount = 0;
    let providerCleanupCount = 0;

    const store = {
      async reserveOutput() {
        throw reservationError;
      },
      async markOutputVerified() {
        throw new Error(
          'verification must not be reached',
        );
      },
      async outputReservation() {
        return null;
      },
      async markOutputFailed() {
        throw new Error(
          'failure marking must not be reached',
        );
      },
    } as unknown as PostgresImageDerivativeStore;

    const providerWriter: ProviderObjectWriter = {
      async write() {
        providerWriteCount += 1;
        throw new Error(
          'provider write must not be reached',
        );
      },
      async cleanup() {
        providerCleanupCount += 1;
        return {
          deleted: true,
        };
      },
    };

    const writer =
      new ConfiguredImageDerivativeOutputWriter({
        store,
        writer: providerWriter,
      });

    await assert.rejects(
      writer.write(job, output),
      (error: unknown) =>
        error === reservationError,
    );

    assert.equal(providerWriteCount, 0);
    assert.equal(providerCleanupCount, 0);
  },
);
