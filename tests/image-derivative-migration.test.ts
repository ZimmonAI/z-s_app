import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationPath = 'db/migrations/0011_z_s_image_derivatives.sql';
const rollbackPath = 'db/migrations/0011_z_s_image_derivatives.down.sql';

test('0011 creates durable jobs, outputs, immutable preset guards, and normal object lineage', async () => {
  const sql = await readFile(migrationPath, 'utf8');
  assert.match(sql, /CREATE TABLE public\.storage_image_derivative_jobs/);
  assert.match(sql, /CREATE TABLE public\.storage_image_derivative_outputs/);
  assert.match(sql, /source_storage_object_id uuid NOT NULL REFERENCES public\.storage_objects/);
  assert.match(sql, /configuration_image_preset_id uuid NOT NULL/);
  assert.match(sql, /target_configuration_vault_id uuid NOT NULL/);
  assert.match(sql, /CREATE FUNCTION public\.z_s_image_derivative_job_guard/);
  assert.match(sql, /source_content_type NOT LIKE 'image\/%'/);
  assert.match(sql, /objects\.image_derivative_job_id/);
  assert.match(sql, /copies\.image_derivative_job_id/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED|storage_image_derivative_jobs_claim_idx/);
  assert.doesNotMatch(sql, /ALTER\s+(TABLE|FUNCTION).*OWNER\s+TO/i);
});

test('0011 rollback refuses adopted derivative data and restores H03 copy authority', async () => {
  const sql = await readFile(rollbackPath, 'utf8');
  assert.match(sql, /rollback blocked: adopted derivative rows exist/);
  assert.match(sql, /DROP TABLE public\.storage_image_derivative_outputs/);
  assert.match(sql, /DROP TABLE public\.storage_image_derivative_jobs/);
  assert.match(sql, /CREATE FUNCTION public\.z_s_runtime_configuration_copy_guard/);
  assert.match(sql, /storage_object_copies_authority_exclusive_check/);
});
