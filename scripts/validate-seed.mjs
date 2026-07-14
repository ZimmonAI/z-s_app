import { readFile } from 'node:fs/promises';

const sql = await readFile('db/seeds/0001_video_maker_dev_profiles.sql', 'utf8');
const required = [
  'video-maker_app',
  'r2_video_maker_dev_01',
  'minio_zimspace_local_pc_01',
  'video-maker-dev-default',
  'video-maker-hot',
  'zs-dev-app-video-maker-canon',
  'video-maker-user-resource',
  'video-maker/user-resources/*',
  'video-maker-capability-probe',
  'video-maker/user-resources/capability/*',
  'video-maker-dev-private',
  'zs-dev-app-video-maker-private',
];
const errors = [];
for (const value of required) {
  if (!sql.includes(value)) errors.push(`missing seed value ${value}`);
}
const inserts = [...sql.matchAll(/INSERT INTO public\.[a-z_]+/gi)].length;
const conflictClauses = [...sql.matchAll(/ON CONFLICT/gi)].length;
if (inserts === 0 || inserts !== conflictClauses) {
  errors.push(`idempotency mismatch: ${inserts} inserts and ${conflictClauses} conflict clauses`);
}
if (/INSERT INTO public\.storage_capability_results/i.test(sql)) {
  errors.push('seed must not create capability readiness');
}
if (/https?:\/\//i.test(sql)) errors.push('seed contains endpoint-like value');
if (/AKIA[0-9A-Z]{16}/.test(sql)) errors.push('seed contains access-key-like value');

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('seed idempotency validation: passed');
}
