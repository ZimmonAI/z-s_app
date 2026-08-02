import fs from 'node:fs';
import child_process from 'node:child_process';

const envMap = {};

function loadEnv(filePath) {
  if (fs.existsSync(filePath)) {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const idx = trimmed.indexOf('=');
        if (idx > 0) {
          const key = trimmed.slice(0, idx).trim();
          const val = trimmed.slice(idx + 1).trim();
          envMap[key] = val;
        }
      }
    }
  }
}

loadEnv('D:/zimspace/workspace-os/storage/z_secret/by_entity/apps/z-s_app/.env');
loadEnv('D:/zimspace/workspace-os/storage/z_secret/by_entity/apps/z-s_app/db/.env');

const vmEnvs = {};
const vmEnvPath = 'D:/zimspace/workspace-os/storage/z_secret/by_entity/apps/video-maker_app/.env';
if (fs.existsSync(vmEnvPath)) {
  const lines = fs.readFileSync(vmEnvPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        vmEnvs[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
      }
    }
  }
}

const r2Binding = {
  endpoint: vmEnvs.CLOUDFLARE_R2_ENDPOINT,
  region: 'auto',
  forcePathStyle: false,
  accessKeyId: vmEnvs.CLOUDFLARE_R2_ACCESS_KEY_ID,
  secretAccessKey: vmEnvs.CLOUDFLARE_R2_SECRET_ACCESS_KEY
};

const minioBinding = {
  endpoint: vmEnvs.VM_MINIO_ENDPOINT,
  region: vmEnvs.VM_MINIO_REGION || 'us-east-1',
  forcePathStyle: true,
  accessKeyId: vmEnvs.VM_MINIO_ACCESS_KEY_ID,
  secretAccessKey: vmEnvs.VM_MINIO_SECRET_ACCESS_KEY
};

const bindings = {
  'r2_video_maker_dev_01': r2Binding,
  'credential-binding:r2_video_maker_dev_01': r2Binding,
  'minio_zimspace_local_pc_01': minioBinding,
  'credential-binding:minio_zimspace_local_pc_01': minioBinding
};

const fullEnv = {
  ...process.env,
  ...envMap,
  Z_S_CLIENT_BOOTSTRAP_CREDENTIAL: 'h04-temp-browser-credential-20260802',
  Z_S_PROVIDER_CREDENTIAL_BINDINGS_JSON: JSON.stringify(bindings)
};

// Kill previous runtime
child_process.spawnSync('powershell', ['-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*runtime-main.js*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }']);

const child = child_process.spawn('node', ['--enable-source-maps', 'dist/runtime-main.js'], {
  cwd: 'D:/zimspace/apps/z-s_app',
  env: fullEnv,
  detached: true,
  stdio: 'ignore'
});

child.unref();
console.log('Started runtime with PID:', child.pid);
