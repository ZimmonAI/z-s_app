import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStorageControlPlan, storageControlPlanErrorCode } from '../src/storage-control-plan.js';

const nonImageAssetClasses = Object.freeze(['raw-video', 'image-derivative', 'document']);

function planWithRoute(assetClass: string): unknown {
  return Object.freeze({
    clientId: 'video-maker_app',
    tokenPurpose: 'storage-runtime-client',
    vaults: Object.freeze([
      Object.freeze({
        vaultId: 'raw-minio-permanent',
        driveLabel: 'Video Maker raw originals',
        providerType: 'minio',
        bucketLabel: 'zs-dev-app-video-maker-canon',
        secretReferenceId: 'credential-binding:minio_zimspace_local_pc_01',
        retentionPolicy: 'permanent',
        role: 'canonical',
      }),
      Object.freeze({
        vaultId: 'image-r2-derivatives',
        driveLabel: 'Video Maker resized images',
        providerType: 'r2',
        bucketLabel: 'video-maker-image-derivatives',
        secretReferenceId: 'credential-binding:r2_video_maker_image_derivatives_01',
        retentionPolicy: 'permanent',
        role: 'derivative',
      }),
    ]),
    routes: Object.freeze([
      Object.freeze({
        assetClass,
        primaryVaultId: 'raw-minio-permanent',
        derivativeVaultId: 'image-r2-derivatives',
      }),
    ]),
    imageDerivatives: Object.freeze([]),
  });
}

test('storage control plan rejects derivative vaults on non-image routes', () => {
  for (const assetClass of nonImageAssetClasses) {
    try {
      buildStorageControlPlan(planWithRoute(assetClass));
      assert.fail(`expected ${assetClass} derivative route to fail`);
    } catch (error) {
      assert.equal(storageControlPlanErrorCode(error), 'invalid-derivativeVaultId');
    }
  }
});
