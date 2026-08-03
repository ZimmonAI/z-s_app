import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const up = await readFile('db/migrations/0011_z_s_image_derivatives.sql', 'utf8');
const down = await readFile('db/migrations/0011_z_s_image_derivatives.down.sql', 'utf8');

for (const table of [
  'storage_image_derivative_jobs',
  'storage_image_derivative_outputs',
]) {
  assert.match(up, new RegExp(`CREATE TABLE public\\.${table}`));
  assert.match(down, new RegExp(`DROP TABLE public\\.${table}`));
}

for (const invariant of [
  /source_storage_object_id uuid NOT NULL REFERENCES public\.storage_objects/,
  /configuration_image_preset_id uuid NOT NULL/,
  /target_configuration_vault_id uuid NOT NULL/,
  /storage_objects_image_derivative_job_idx/,
  /storage_object_copies_image_derivative_job_idx/,
  /z_s_image_derivative_job_guard/,
  /z_s_image_derivative_output_guard/,
  /source_content_type NOT LIKE 'image\/%'/,
  /copy_state = 'verified'/,
  /rollback blocked: adopted derivative rows exist/,
]) {
  assert.match(`${up}\n${down}`, invariant);
}

assert.doesNotMatch(`${up}\n${down}`, /ALTER\s+(TABLE|FUNCTION).*OWNER\s+TO/i);
assert.match(up, /BEGIN;/);
assert.match(up, /COMMIT;/);
assert.match(down, /BEGIN;/);
assert.match(down, /COMMIT;/);

console.log('0011 image derivative migration contract validated');
