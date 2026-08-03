import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [contract, processor, worker, store, queue, output, up, down, documentation] = await Promise.all([
  readFile('src/image-derivative-contract.ts', 'utf8'),
  readFile('src/image-derivative-png.ts', 'utf8'),
  readFile('src/image-derivative-worker.ts', 'utf8'),
  readFile('src/image-derivative-postgres.ts', 'utf8'),
  readFile('src/image-derivative-postgres-queue.ts', 'utf8'),
  readFile('src/image-derivative-postgres-output.ts', 'utf8'),
  readFile('db/migrations/0011_z_s_image_derivatives.sql', 'utf8'),
  readFile('db/migrations/0011_z_s_image_derivatives.down.sql', 'utf8'),
  readFile('docs/image-derivatives.md', 'utf8'),
]);

const source = contract + processor + worker;
for (const value of [
  'maximumSourceByteLength: 32 * 1024 * 1024',
  'maximumDecodedPixels: 40_000_000',
  'maximumWorkingMemoryByteLength: 256 * 1024 * 1024',
  'maximumAttempts: 3',
  'maximumStatusRows: 50',
  'image-signature-mime-mismatch',
  'image-output-verification-mismatch',
]) assert.match(source, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

assert.match(queue, /FOR UPDATE SKIP LOCKED/);
assert.match(queue, /ON CONFLICT \([\s\S]*source_storage_object_id/);
assert.match(output, /storage_image_derivative_outputs/);
assert.match(store, /PostgresImageDerivativeStore/);
assert.match(up, /storage_image_derivative_jobs/);
assert.match(up, /storage_image_derivative_outputs/);
assert.match(up, /0011 migration already applied/);
assert.match(down, /0011 rollback blocked: adopted image derivative rows exist/);
assert.match(documentation, /Integration bearer tokens are rejected/);
assert.doesNotMatch(source + store + queue + output, /console\.(log|error)|process\.env/);

console.log('image derivative validation: passed');
