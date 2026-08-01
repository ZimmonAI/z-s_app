import assert from 'node:assert/strict';
import test from 'node:test';
import { createVideoMakerControlRuntimeComposition } from '../src/runtime-control-composition.js';

const CONTROL_PASSPHRASE = 'operator-passphrase';
const CONTROL_SIGNING_KEY = 'control-session-signing-key-2026';
const REDACTED_FIXTURE_VALUE = 'must-not-return';

function controlEnv(): Readonly<Record<string, string>> {
  return Object.freeze({
    Z_S_CONTROL_ADMIN_PASSWORD: CONTROL_PASSPHRASE,
    Z_S_CONTROL_SESSION_SIGNING_KEY: CONTROL_SIGNING_KEY,
  });
}

test('public control surface logs in and renders storage vault planner', async () => {
  const composition = createVideoMakerControlRuntimeComposition(controlEnv());
  try {
    const login = await composition.runtime.handle(new Request('https://z-s.zimmon.ai/login'));
    assert.equal(login.status, 200);
    const loginBody = await login.text();
    assert.match(loginBody, /Z-s storage control/);
    assert.match(loginBody, /name="operatorPassphrase"/);
    assert.match(loginBody, /id="operator-passphrase"/);
    assert.match(loginBody, /autocomplete="new-password"/);
    assert.doesNotMatch(loginBody, /name="password"/);
    assert.doesNotMatch(loginBody, /id="password"/);
    assert.doesNotMatch(loginBody, /current-password/);

    const blocked = await composition.runtime.handle(new Request('https://z-s.zimmon.ai/admin/storage'));
    assert.equal(blocked.status, 302);
    assert.equal(blocked.headers.get('location'), '/login');

    const formSession = await composition.runtime.handle(new Request('https://z-s.zimmon.ai/admin/session', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ operatorPassphrase: CONTROL_PASSPHRASE }),
    }));
    assert.equal(formSession.status, 302);
    assert.equal(formSession.headers.get('location'), '/admin/storage');
    const formCookie = formSession.headers.get('set-cookie');
    assert.ok(formCookie !== null);
    assert.ok(formCookie.startsWith('zs_control_session='));

    const session = await composition.runtime.handle(new Request('https://z-s.zimmon.ai/admin/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: CONTROL_PASSPHRASE }),
    }));
    assert.equal(session.status, 204);
    const cookie = session.headers.get('set-cookie');
    assert.ok(cookie !== null);
    assert.ok(cookie.startsWith('zs_control_session='));

    const storage = await composition.runtime.handle(new Request('https://z-s.zimmon.ai/admin/storage', {
      headers: { cookie },
    }));
    assert.equal(storage.status, 200);
    assert.match(await storage.text(), /Storage vault planner/);

    const plan = await composition.runtime.handle(new Request('https://z-s.zimmon.ai/admin/storage/plans', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        clientId: 'video-maker_app',
        tokenPurpose: 'storage-runtime-client',
        vaults: [
          {
            vaultId: 'raw-minio-permanent',
            driveLabel: 'Video Maker raw originals',
            providerType: 'minio',
            bucketLabel: 'zs-dev-app-video-maker-canon',
            secretReferenceId: 'credential-binding:minio_zimspace_local_pc_01',
            retentionPolicy: 'permanent',
            role: 'canonical',
            endpoint: 'https://minio.private.invalid',
            accessKeyId: REDACTED_FIXTURE_VALUE,
            secretAccessKey: REDACTED_FIXTURE_VALUE,
          },
          {
            vaultId: 'raw-r2-hot-seven-day',
            driveLabel: 'Video Maker hot cache',
            providerType: 'r2',
            bucketLabel: 'video-maker-hot',
            secretReferenceId: 'credential-binding:r2_video_maker_dev_01',
            retentionPolicy: 'hot-cache-short',
            deleteAfterDays: 7,
            role: 'hot',
          },
          {
            vaultId: 'image-r2-derivatives',
            driveLabel: 'Video Maker resized images',
            providerType: 'r2',
            bucketLabel: 'video-maker-image-derivatives',
            secretReferenceId: 'credential-binding:r2_video_maker_image_derivatives_01',
            retentionPolicy: 'permanent',
            role: 'derivative',
          },
        ],
        routes: [
          {
            assetClass: 'raw-video',
            primaryVaultId: 'raw-minio-permanent',
            replicaVaultId: 'raw-r2-hot-seven-day',
          },
          {
            assetClass: 'raw-image',
            primaryVaultId: 'raw-minio-permanent',
            replicaVaultId: 'raw-r2-hot-seven-day',
            derivativeVaultId: 'image-r2-derivatives',
          },
        ],
        imageDerivatives: [
          {
            derivativeId: 'image-web-resize',
            sourceVaultId: 'raw-minio-permanent',
            targetVaultId: 'image-r2-derivatives',
            widths: [512, 1024, 1600],
            format: 'webp',
          },
        ],
      }),
    }));
    assert.equal(plan.status, 200);
    const planBody = JSON.stringify(await plan.json());
    assert.match(planBody, /image-web-resize/);
    assert.match(planBody, /"derivativeVaultId":"image-r2-derivatives"/);
    assert.match(planBody, /hot-cache-short/);
    assert.match(planBody, /"deleteAfterDays":7/);
    assert.doesNotMatch(planBody, /must-not-return|minio\.private|secretAccessKey|accessKeyId|endpoint/);
  } finally {
    await composition.close();
  }
});

test('planner form parse errors stay on authenticated planner surface', async () => {
  const composition = createVideoMakerControlRuntimeComposition(controlEnv());
  try {
    const session = await composition.runtime.handle(new Request('https://z-s.zimmon.ai/admin/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: CONTROL_PASSPHRASE }),
    }));
    const cookie = session.headers.get('set-cookie');
    assert.ok(cookie !== null);

    const response = await composition.runtime.handle(new Request('https://z-s.zimmon.ai/admin/storage/plans', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ payload: '{"clientId":"video-maker_app","vaults":[' }),
    }));
    assert.equal(response.status, 400);
    const body = await response.text();
    assert.match(body, /invalid-json/);
    assert.doesNotMatch(body, /Operator passphrase|name="password"|\/admin\/session/);
  } finally {
    await composition.close();
  }
});

test('storage planner exposes human form controls for vault routing', async () => {
  const composition = createVideoMakerControlRuntimeComposition(controlEnv());
  try {
    const session = await composition.runtime.handle(new Request('https://z-s.zimmon.ai/admin/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: CONTROL_PASSPHRASE }),
    }));
    const cookie = session.headers.get('set-cookie');
    assert.ok(cookie !== null);

    const response = await composition.runtime.handle(new Request('https://z-s.zimmon.ai/admin/storage', {
      headers: { cookie },
    }));
    const body = await response.text();
    assert.match(body, /name="vault0ProviderType"/);
    assert.match(body, /name="vault1RetentionPolicy"/);
    assert.match(body, /name="route1DerivativeVaultId"/);
    assert.match(body, /name="derivative0Widths"/);
    assert.doesNotMatch(body, /Storage plan JSON|<textarea/);
  } finally {
    await composition.close();
  }
});

test('human storage planner form submits a safe vault plan', async () => {
  const composition = createVideoMakerControlRuntimeComposition(controlEnv());
  try {
    const session = await composition.runtime.handle(new Request('https://z-s.zimmon.ai/admin/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: CONTROL_PASSPHRASE }),
    }));
    const cookie = session.headers.get('set-cookie');
    assert.ok(cookie !== null);

    const response = await composition.runtime.handle(new Request('https://z-s.zimmon.ai/admin/storage/plans', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        clientId: 'video-maker_app',
        tokenPurpose: 'storage-runtime-client',
        vault0VaultId: 'raw-minio-permanent',
        vault0DriveLabel: 'Video Maker raw originals',
        vault0ProviderType: 'minio',
        vault0BucketLabel: 'zs-dev-app-video-maker-canon',
        vault0SecretReferenceId: 'credential-binding:minio_zimspace_local_pc_01',
        vault0RetentionPolicy: 'permanent',
        vault0Role: 'canonical',
        vault1VaultId: 'raw-r2-hot-seven-day',
        vault1DriveLabel: 'Video Maker hot cache',
        vault1ProviderType: 'r2',
        vault1BucketLabel: 'video-maker-hot',
        vault1SecretReferenceId: 'credential-binding:r2_video_maker_dev_01',
        vault1RetentionPolicy: 'hot-cache-short',
        vault1DeleteAfterDays: '7',
        vault1Role: 'hot',
        vault2VaultId: 'image-r2-derivatives',
        vault2DriveLabel: 'Video Maker resized images',
        vault2ProviderType: 'r2',
        vault2BucketLabel: 'video-maker-image-derivatives',
        vault2SecretReferenceId: 'credential-binding:r2_video_maker_image_derivatives_01',
        vault2RetentionPolicy: 'permanent',
        vault2Role: 'derivative',
        route0AssetClass: 'raw-video',
        route0PrimaryVaultId: 'raw-minio-permanent',
        route0ReplicaVaultId: 'raw-r2-hot-seven-day',
        route0DerivativeVaultId: '',
        route1AssetClass: 'raw-image',
        route1PrimaryVaultId: 'raw-minio-permanent',
        route1ReplicaVaultId: 'raw-r2-hot-seven-day',
        route1DerivativeVaultId: 'image-r2-derivatives',
        route2AssetClass: 'document',
        route2PrimaryVaultId: 'raw-minio-permanent',
        route2ReplicaVaultId: 'raw-r2-hot-seven-day',
        route2DerivativeVaultId: '',
        enableImageDerivative: 'on',
        derivative0DerivativeId: 'image-web-resize',
        derivative0SourceVaultId: 'raw-minio-permanent',
        derivative0TargetVaultId: 'image-r2-derivatives',
        derivative0Widths: '512,1024,1600',
        derivative0Format: 'avif',
      }),
    }));
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Storage vault plan result/);
    assert.match(body, /&quot;format&quot;: &quot;avif&quot;/);
    assert.match(body, /&quot;deleteAfterDays&quot;: 7/);
    assert.match(body, /&quot;tokenStorage&quot;: &quot;digest-only&quot;/);
    assert.doesNotMatch(body, /accessKeyId|secretAccessKey|minio\.private|Operator passphrase/);
  } finally {
    await composition.close();
  }
});
