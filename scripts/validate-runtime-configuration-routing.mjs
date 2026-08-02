import { readFile } from 'node:fs/promises';

const up = await readFile('db/migrations/0010_z_s_runtime_configuration_routing.sql', 'utf8');
const down = await readFile('db/migrations/0010_z_s_runtime_configuration_routing.down.sql', 'utf8');
const source = `${up}\n${down}`;
const requirements = [
  /0010 preflight missing required table/i,
  /0010 migration already applied/i,
  /ADD COLUMN storage_control_client_id uuid NULL/i,
  /ADD COLUMN configuration_version_id uuid NULL/i,
  /ADD COLUMN configuration_fingerprint text NULL/i,
  /ADD COLUMN configuration_route_id uuid NULL/i,
  /ADD COLUMN configuration_route_target_id uuid NULL/i,
  /ADD COLUMN configuration_vault_id uuid NULL/i,
  /ADD COLUMN provider_connection_id uuid NULL/i,
  /ADD COLUMN target_role text NULL/i,
  /ADD COLUMN target_order smallint NULL/i,
  /target_role IS NULL OR target_role IN \('primary', 'replica'\)/i,
  /target_role = 'primary' AND target_order = 0/i,
  /target_role = 'replica' AND target_order > 0/i,
  /storage_object_copies_configuration_target_idx/i,
  /z_s_runtime_configuration_copy_guard/i,
  /configuration_fingerprint ~ '\^\[a-f0-9\]\{64\}\$'/i,
  /0010 rollback blocked: configuration-routed runtime rows exist/i,
  /COMMENT ON TABLE public\.object_write_intents[\s\S]*03-online-generic-runtime-routing-coding\.md/i,
  /COMMENT ON TABLE public\.storage_objects[\s\S]*03-online-generic-runtime-routing-coding\.md/i,
  /COMMENT ON TABLE public\.storage_object_copies[\s\S]*03-online-generic-runtime-routing-coding\.md/i,
  /03-online-generic-runtime-routing-coding\.md/i,
];
const errors = requirements.filter((pattern) => !pattern.test(source)).map((pattern) =>
  `missing runtime configuration routing requirement ${pattern}`,
);
if (/CREATE EXTENSION/i.test(source)) errors.push('0010 must not create PostgreSQL extensions');
if (/INSERT INTO public\./i.test(up)) errors.push('0010 must not seed runtime rows');
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('runtime configuration routing migration static validation: passed');
}
