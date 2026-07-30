# Storage Vault Routing and Image Resize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Z-s vault control plane so storage profiles can route one asset class to one vault or many vaults, preview image-resize derivative placement, and stop hardcoding Video Maker hot/canonical write/read assumptions.

**Architecture:** Add vault/rule/derivative schema in migration `0004`, then build one pure route planner that is shared by admin preview and runtime write planning. Keep contract `1.0` backward-compatible by preserving legacy hot/canonical response fields while storing new copy authority on vault bindings. Serve the first internal admin UI from the Node runtime with vanilla HTML/CSS/JS and server-side admin APIs; actual image processing execution remains disabled in this slice.

**Tech Stack:** Node 22, TypeScript ESM, `node:test`, `pg`, SQL migrations, vanilla browser UI served by the existing Node HTTP adapter.

---

## Scope and hard constraints

- Follow `z-kn/vault-rule.md`: do not scan every vault or broad storage tree. Use only the scoped Z-s docs, `apps/z-s_app`, and explicit DB test fixtures.
- Do not apply migration `0004` to the live database in this plan. Use `TEST_DATABASE_URL` for integration tests only.
- Do not store or echo credentials, endpoints, signed URLs, bearer tokens, object keys, internal locators, full env paths, prompts, user names, project titles, or scene titles in admin API responses, audit events, docs, or UI state.
- Use **vault** as the client-facing term. Do not use “clone” for multi-placement; write “store one asset to one vault or many vaults.”
- R2 may be permanent only when a vault explicitly has `retention_mode = 'permanent'`. Temporary hot vaults are provider-neutral: R2, MinIO, or approved S3-compatible providers.
- Image resize execution is outside this slice. This plan adds schema, validation, UI configuration, preview, and provenance tables only. The UI must label derivative execution as “configured for preview, not executing.”
- Existing oversized source files (`runtime-local-composition.ts`, `runtime-read-delivery.ts`, `runtime-service.ts`) are pre-existing. Do not add substantial logic to them. New logic lives in focused files; existing files only delegate.

## File structure

### Create

- `db/migrations/0004_storage_vault_routes_and_derivatives.sql` — Adds vault, route, derivative, and provenance tables; extends `storage_objects` and `storage_object_copies`; backfills Video Maker-compatible vault rows from existing provider bindings.
- `db/migrations/0004_storage_vault_routes_and_derivatives.down.sql` — Rollback that refuses to run after adopted vault/runtime rows exist.
- `src/storage-vault-types.ts` — Shared readonly domain types for vaults, asset classes, route rules, derivative rules, preview plans, and admin DTOs.
- `src/storage-vault-route-planner.ts` — Pure planner and readiness validator. No DB, HTTP, provider SDK, or filesystem access.
- `src/storage-vault-control-plane.ts` — Postgres repository for admin list/create/update and preview reads. Emits audit rows through `storage_profile_audit_events`.
- `src/storage-vault-admin-api.ts` — Secret-safe admin API runtime for `/admin/storage/api/*`.
- `src/storage-vault-admin-ui.ts` — Vanilla HTML/CSS/JS assets served by the runtime for `/admin/storage`.
- `src/storage-vault-runtime.ts` — Runtime adapter that resolves vault route plans into write-intent copy inputs and read-priority snapshots.
- `tests/storage-vault-migration.integration.test.ts` — Migration `0004` integration checks.
- `tests/storage-vault-route-planner.test.ts` — Pure planner tests for one-to-one, one-to-many, temporary-only rejection, capability warnings, and derivative validation.
- `tests/storage-vault-admin-api.test.ts` — Admin API tests for secret-safe responses and preview validation.
- `tests/storage-vault-runtime.integration.test.ts` — Registry/runtime integration tests for N placement write intents.
- `tests/storage-vault-read-delivery.test.ts` — Vault read-priority selection tests.
- `tests/storage-vault-admin-ui.test.ts` — UI asset smoke tests using the admin runtime without a browser.
- `scripts/admin-ui-smoke.mjs` — Manual-QA driver that starts the local runtime, loads the UI, calls preview endpoints, and verifies no prohibited strings are exposed.
- `DESIGN.md` — Operational design system for the internal Z-s storage admin UI.

### Modify

- `package.json` — Include migration `0004` in package files, add focused scripts for vault tests and admin UI smoke.
- `scripts/validate-migration.mjs` — Validate `0004` tables, comments, indexes, rollback guard, and prohibited column names.
- `src/runtime-storage-registry-types.ts` — Add vault-aware copy types while preserving hot/canonical compatibility fields.
- `src/runtime-storage-registry-object.ts` — Create N planned copies from vault route plans instead of exactly two copies when vault inputs are present.
- `src/runtime-storage-registry.ts` — Export new vault-aware methods from the composed registry class.
- `src/runtime-ingest.ts` — Accept resolved vault write plans and pass them to the registry/adapter.
- `src/runtime-read-grant.ts` — Query vault-aware read snapshots ordered by vault binding `read_priority` with legacy fallback.
- `src/runtime-read-delivery.ts` — Delegate copy selection to `storage-vault-runtime.ts`; keep legacy hot/canonical headers for old objects.
- `src/runtime-local-composition.ts` — Resolve Video Maker authority from vault rules, compose admin UI/API routes before write/read runtime fallback, and keep existing dev auth.
- `README.md` and `docs/runtime-contract.md` — Document vault admin preview and runtime compatibility.

## Cross-cutting acceptance criteria

- `npm run validate:migration` prints `migration static validation: passed`.
- `npm run test:vault` passes with `TEST_DATABASE_URL` configured.
- `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` exit 0.
- `npm run smoke:admin-ui` proves the internal UI and preview API surface no prohibited secret/private strings.
- Manual QA uses the UI/API to configure the Video Maker example:
  - raw production image/video/document -> MinIO permanent vault, required;
  - raw production image/video/document -> optional provider-neutral 7-day hot vault, backed by R2 or MinIO;
  - production image -> image resize derivative -> R2 permanent resize vault, required for the derivative object;
  - bad resize rule on video is rejected;
  - readiness/preview API exposes no credentials, provider-private locators, or internal locator values.

---

### Task 1: Migration 0004 schema and static validation

**Files:**
- Create: `db/migrations/0004_storage_vault_routes_and_derivatives.sql`
- Create: `db/migrations/0004_storage_vault_routes_and_derivatives.down.sql`
- Modify: `scripts/validate-migration.mjs`
- Modify: `package.json`
- Test: `tests/storage-vault-migration.integration.test.ts`

- [ ] **Step 1: Write the failing integration test for migration 0004**

Add `tests/storage-vault-migration.integration.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationTest = databaseUrl === undefined ? test.skip : test;

async function apply(pool: Pool, file: string): Promise<void> {
  await pool.query(await readFile(file, 'utf8'));
}

integrationTest('0004 adds vault control-plane schema, documents every column, rejects reapply, and rolls down before adoption', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await apply(pool, 'db/migrations/0001_z_s_control_plane_foundation.sql');
    await apply(pool, 'db/migrations/0002_z_s_runtime_registry.sql');
    await apply(pool, 'db/migrations/0003_z_s_read_delivery.sql');
    await apply(pool, 'db/migrations/0004_storage_vault_routes_and_derivatives.sql');

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [[
        'storage_asset_classes',
        'storage_derivative_rules',
        'storage_object_derivations',
        'storage_profile_vault_bindings',
        'storage_route_rules',
        'storage_vaults',
      ]],
    );
    assert.deepEqual(tables.rows.map((row) => row.table_name), [
      'storage_asset_classes',
      'storage_derivative_rules',
      'storage_object_derivations',
      'storage_profile_vault_bindings',
      'storage_route_rules',
      'storage_vaults',
    ]);

    const copyColumns = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'storage_object_copies'
          AND column_name = ANY($1::text[])
        ORDER BY column_name`,
      [[
        'placement_intent',
        'storage_profile_vault_binding_id',
        'storage_route_rule_id',
        'storage_vault_id',
      ]],
    );
    assert.deepEqual(copyColumns.rows.map((row) => row.column_name), [
      'placement_intent',
      'storage_profile_vault_binding_id',
      'storage_route_rule_id',
      'storage_vault_id',
    ]);

    const objectColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'storage_objects'
          AND column_name = ANY($1::text[])
        ORDER BY column_name`,
      [['asset_class_id', 'origin_kind', 'source_storage_object_id']],
    );
    assert.deepEqual(objectColumns.rows.map((row) => row.column_name), [
      'asset_class_id',
      'origin_kind',
      'source_storage_object_id',
    ]);

    const missingComments = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM information_schema.columns AS column_info
         JOIN pg_catalog.pg_class AS relation
           ON relation.relname = column_info.table_name
         JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace
          AND namespace.nspname = column_info.table_schema
         JOIN pg_catalog.pg_attribute AS attribute
           ON attribute.attrelid = relation.oid
          AND attribute.attname = column_info.column_name
        WHERE column_info.table_schema = 'public'
          AND column_info.table_name = ANY($1::text[])
          AND COALESCE(col_description(relation.oid, attribute.attnum), '') NOT LIKE '%storage-vault-routing-and-image-resize-design.md%'`,
      [[
        'storage_asset_classes',
        'storage_derivative_rules',
        'storage_object_derivations',
        'storage_object_copies',
        'storage_objects',
        'storage_profile_vault_bindings',
        'storage_route_rules',
        'storage_vaults',
      ]],
    );
    assert.equal(missingComments.rows[0]?.count, '0');

    await assert.rejects(
      pool.query(await readFile('db/migrations/0004_storage_vault_routes_and_derivatives.sql', 'utf8')),
      /0004 migration already applied/,
    );
    await pool.query('ROLLBACK');

    await apply(pool, 'db/migrations/0004_storage_vault_routes_and_derivatives.down.sql');
    const afterRollback = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])`,
      [['storage_vaults', 'storage_route_rules', 'storage_derivative_rules']],
    );
    assert.deepEqual(afterRollback.rows, []);
  } finally {
    await pool.end();
  }
});
```

- [ ] **Step 2: Run the migration test to verify RED**

Run: `npm run test:compile && node --test .test-dist/tests/storage-vault-migration.integration.test.js`

Expected: FAIL with `ENOENT: no such file or directory, open 'db/migrations/0004_storage_vault_routes_and_derivatives.sql'`.

- [ ] **Step 3: Create migration 0004 up file**

Create `db/migrations/0004_storage_vault_routes_and_derivatives.sql` with this structure and these exact compatibility choices:

```sql
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  expected_table text;
BEGIN
  FOREACH expected_table IN ARRAY ARRAY[
    'managed_apps',
    'storage_providers',
    'storage_profiles',
    'storage_profile_provider_bindings',
    'storage_prefix_classes',
    'storage_capability_results',
    'storage_profile_audit_events',
    'storage_objects',
    'object_write_intents',
    'storage_object_copies',
    'object_read_grants'
  ]
  LOOP
    IF to_regclass(format('public.%I', expected_table)) IS NULL THEN
      RAISE EXCEPTION '0004 preflight missing table public.%', expected_table;
    END IF;
  END LOOP;

  IF to_regclass('public.storage_vaults') IS NOT NULL THEN
    RAISE EXCEPTION '0004 migration already applied: public.storage_vaults exists';
  END IF;
END
$$;

CREATE TABLE public.storage_vaults (
  id uuid PRIMARY KEY,
  managed_app_id uuid NOT NULL REFERENCES public.managed_apps(id) ON DELETE RESTRICT,
  vault_key text NOT NULL CHECK (vault_key ~ '^[a-z0-9][a-z0-9_-]{0,95}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  storage_provider_id uuid NOT NULL REFERENCES public.storage_providers(id) ON DELETE RESTRICT,
  bucket_label text NOT NULL CHECK (bucket_label ~ '^[a-z0-9][a-z0-9.-]{0,127}$'),
  base_prefix_pattern text NOT NULL CHECK (
    char_length(base_prefix_pattern) BETWEEN 1 AND 512
    AND base_prefix_pattern !~ '^/'
    AND base_prefix_pattern !~ '\.\.'
    AND base_prefix_pattern !~ '\\'
    AND base_prefix_pattern !~ '://'
  ),
  vault_kind text NOT NULL CHECK (vault_kind IN ('canonical', 'hot', 'derivative', 'archive', 'temporary')),
  retention_policy_id text NOT NULL CHECK (retention_policy_id ~ '^[a-z0-9][a-z0-9_-]{0,95}$'),
  retention_mode text NOT NULL CHECK (retention_mode IN ('permanent', 'ttl', 'until-app-delete', 'legal-hold')),
  ttl_seconds integer NULL CHECK (ttl_seconds IS NULL OR ttl_seconds > 0),
  access_mode text NOT NULL CHECK (access_mode IN ('private', 'signed-read', 'public-approved')),
  status text NOT NULL CHECK (status IN ('draft', 'active', 'disabled')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (managed_app_id, vault_key),
  CHECK ((retention_mode = 'ttl') = (ttl_seconds IS NOT NULL)),
  CHECK (retention_mode <> 'permanent' OR ttl_seconds IS NULL),
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.storage_profile_vault_bindings (
  id uuid PRIMARY KEY,
  storage_profile_id uuid NOT NULL REFERENCES public.storage_profiles(id) ON DELETE RESTRICT,
  storage_vault_id uuid NOT NULL REFERENCES public.storage_vaults(id) ON DELETE RESTRICT,
  storage_prefix_class_id uuid NOT NULL REFERENCES public.storage_prefix_classes(id) ON DELETE RESTRICT,
  binding_key text NOT NULL CHECK (binding_key ~ '^[a-z0-9][a-z0-9_-]{0,95}$'),
  required boolean NOT NULL DEFAULT true,
  write_order integer NOT NULL CHECK (write_order > 0),
  read_priority integer NULL CHECK (read_priority IS NULL OR read_priority > 0),
  status text NOT NULL CHECK (status IN ('draft', 'active', 'disabled')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (storage_profile_id, binding_key),
  UNIQUE (storage_profile_id, storage_vault_id, storage_prefix_class_id),
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.storage_asset_classes (
  id uuid PRIMARY KEY,
  managed_app_id uuid NOT NULL REFERENCES public.managed_apps(id) ON DELETE RESTRICT,
  asset_class_key text NOT NULL CHECK (asset_class_key ~ '^[a-z0-9][a-z0-9_-]{0,95}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  media_family text NOT NULL CHECK (media_family IN ('image', 'video', 'document', 'binary', 'any')),
  allowed_mime_types text[] NOT NULL CHECK (cardinality(allowed_mime_types) > 0),
  max_byte_length bigint NULL CHECK (max_byte_length IS NULL OR max_byte_length > 0),
  status text NOT NULL CHECK (status IN ('draft', 'active', 'disabled')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (managed_app_id, asset_class_key),
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.storage_route_rules (
  id uuid PRIMARY KEY,
  storage_profile_id uuid NOT NULL REFERENCES public.storage_profiles(id) ON DELETE RESTRICT,
  asset_class_id uuid NOT NULL REFERENCES public.storage_asset_classes(id) ON DELETE RESTRICT,
  route_key text NOT NULL CHECK (route_key ~ '^[a-z0-9][a-z0-9_-]{0,95}$'),
  operation_class text NOT NULL CHECK (operation_class ~ '^[a-z0-9][a-z0-9_-]{0,95}$'),
  destination_vault_binding_id uuid NOT NULL REFERENCES public.storage_profile_vault_bindings(id) ON DELETE RESTRICT,
  placement_intent text NOT NULL CHECK (placement_intent IN ('primary', 'additional', 'cache', 'archive')),
  required boolean NOT NULL,
  failure_policy text NOT NULL CHECK (failure_policy IN ('fail-write', 'allow-degraded', 'retry-background')),
  status text NOT NULL CHECK (status IN ('draft', 'active', 'disabled')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (storage_profile_id, route_key),
  CHECK (required OR failure_policy <> 'fail-write'),
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.storage_derivative_rules (
  id uuid PRIMARY KEY,
  storage_profile_id uuid NOT NULL REFERENCES public.storage_profiles(id) ON DELETE RESTRICT,
  source_asset_class_id uuid NOT NULL REFERENCES public.storage_asset_classes(id) ON DELETE RESTRICT,
  derivative_asset_class_id uuid NOT NULL REFERENCES public.storage_asset_classes(id) ON DELETE RESTRICT,
  derivative_key text NOT NULL CHECK (derivative_key ~ '^[a-z0-9][a-z0-9_-]{0,95}$'),
  processor text NOT NULL CHECK (processor IN ('image-resize')),
  processor_config jsonb NOT NULL CHECK (jsonb_typeof(processor_config) = 'object'),
  destination_vault_binding_id uuid NOT NULL REFERENCES public.storage_profile_vault_bindings(id) ON DELETE RESTRICT,
  trigger_mode text NOT NULL CHECK (trigger_mode IN ('on-upload-complete', 'manual', 'job')),
  required boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('draft', 'active', 'disabled')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (storage_profile_id, derivative_key),
  CHECK (processor_config ? 'width' OR processor_config ? 'height' OR processor_config ? 'preset'),
  CHECK (octet_length(processor_config::text) <= 4096),
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.storage_object_derivations (
  id uuid PRIMARY KEY,
  source_storage_object_id uuid NOT NULL REFERENCES public.storage_objects(storage_object_id) ON DELETE RESTRICT,
  derived_storage_object_id uuid NOT NULL REFERENCES public.storage_objects(storage_object_id) ON DELETE RESTRICT,
  derivative_rule_id uuid NOT NULL REFERENCES public.storage_derivative_rules(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('planned', 'processing', 'completed', 'failed', 'cancelled')),
  safe_diagnostic_category text NULL CHECK (safe_diagnostic_category IS NULL OR safe_diagnostic_category IN ('invalid-request', 'unauthenticated', 'unauthorized', 'incompatible-version', 'duplicate-conflict', 'not-ready', 'dependency-unavailable', 'internal')),
  safe_diagnostic_code text NULL CHECK (safe_diagnostic_code IS NULL OR safe_diagnostic_code ~ '^[a-z0-9][a-z0-9-]{0,95}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (derived_storage_object_id),
  UNIQUE (source_storage_object_id, derivative_rule_id, derived_storage_object_id),
  CHECK (source_storage_object_id <> derived_storage_object_id),
  CHECK (updated_at >= created_at)
);

ALTER TABLE public.storage_objects
  ADD COLUMN asset_class_id uuid NULL REFERENCES public.storage_asset_classes(id) ON DELETE RESTRICT,
  ADD COLUMN source_storage_object_id uuid NULL REFERENCES public.storage_objects(storage_object_id) ON DELETE RESTRICT,
  ADD COLUMN origin_kind text NOT NULL DEFAULT 'upload' CHECK (origin_kind IN ('upload', 'derivative', 'external-import', 'system-generated'));

ALTER TABLE public.storage_object_copies
  ADD COLUMN storage_vault_id uuid NULL REFERENCES public.storage_vaults(id) ON DELETE RESTRICT,
  ADD COLUMN storage_profile_vault_binding_id uuid NULL REFERENCES public.storage_profile_vault_bindings(id) ON DELETE RESTRICT,
  ADD COLUMN storage_route_rule_id uuid NULL REFERENCES public.storage_route_rules(id) ON DELETE RESTRICT,
  ADD COLUMN placement_intent text NULL CHECK (placement_intent IS NULL OR placement_intent IN ('primary', 'additional', 'cache', 'archive'));

ALTER TABLE public.storage_object_copies
  ALTER COLUMN storage_profile_provider_binding_id DROP NOT NULL;

ALTER TABLE public.storage_object_copies
  DROP CONSTRAINT storage_object_copies_storage_object_id_provider_role_key;

CREATE UNIQUE INDEX storage_object_copies_legacy_object_role_idx
  ON public.storage_object_copies (storage_object_id, provider_role)
  WHERE storage_vault_id IS NULL;

CREATE UNIQUE INDEX storage_object_copies_vault_route_idx
  ON public.storage_object_copies (storage_object_id, storage_route_rule_id, storage_vault_id)
  WHERE storage_vault_id IS NOT NULL AND storage_route_rule_id IS NOT NULL;

CREATE INDEX storage_vaults_profile_lookup_idx
  ON public.storage_vaults (managed_app_id, status, vault_key);
CREATE INDEX storage_profile_vault_bindings_profile_order_idx
  ON public.storage_profile_vault_bindings (storage_profile_id, status, write_order);
CREATE INDEX storage_profile_vault_bindings_read_priority_idx
  ON public.storage_profile_vault_bindings (storage_profile_id, read_priority)
  WHERE read_priority IS NOT NULL;
CREATE INDEX storage_route_rules_profile_asset_idx
  ON public.storage_route_rules (storage_profile_id, asset_class_id, status);
CREATE INDEX storage_derivative_rules_profile_source_idx
  ON public.storage_derivative_rules (storage_profile_id, source_asset_class_id, status);
CREATE INDEX storage_object_copies_vault_state_idx
  ON public.storage_object_copies (storage_vault_id, copy_state, updated_at);
CREATE INDEX storage_objects_asset_origin_idx
  ON public.storage_objects (asset_class_id, origin_kind, created_at DESC);

COMMENT ON TABLE public.storage_vaults IS 'Client-facing storage vault destinations. Ref: apps/z-s_app/docs/superpowers/specs/2026-07-30-storage-vault-routing-and-image-resize-design.md';
COMMENT ON TABLE public.storage_profile_vault_bindings IS 'Profile-version bindings from prefix classes to storage vaults. Ref: apps/z-s_app/docs/superpowers/specs/2026-07-30-storage-vault-routing-and-image-resize-design.md';
COMMENT ON TABLE public.storage_asset_classes IS 'Client-configurable asset classes used by vault route planning. Ref: apps/z-s_app/docs/superpowers/specs/2026-07-30-storage-vault-routing-and-image-resize-design.md';
COMMENT ON TABLE public.storage_route_rules IS 'Original-upload route rules that place one asset in one vault or many vaults. Ref: apps/z-s_app/docs/superpowers/specs/2026-07-30-storage-vault-routing-and-image-resize-design.md';
COMMENT ON TABLE public.storage_derivative_rules IS 'Preview-time derivative rules such as image resize. Execution is disabled in this slice. Ref: apps/z-s_app/docs/superpowers/specs/2026-07-30-storage-vault-routing-and-image-resize-design.md';
COMMENT ON TABLE public.storage_object_derivations IS 'Source-to-derived storage object provenance. Ref: apps/z-s_app/docs/superpowers/specs/2026-07-30-storage-vault-routing-and-image-resize-design.md';

DO $$
DECLARE
  column_record record;
  reference constant text := 'Ref: apps/z-s_app/docs/superpowers/specs/2026-07-30-storage-vault-routing-and-image-resize-design.md';
BEGIN
  FOR column_record IN
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY(ARRAY[
         'storage_asset_classes',
         'storage_derivative_rules',
         'storage_object_derivations',
         'storage_object_copies',
         'storage_objects',
         'storage_profile_vault_bindings',
         'storage_route_rules',
         'storage_vaults'
       ])
  LOOP
    EXECUTE format(
      'COMMENT ON COLUMN public.%I.%I IS %L',
      column_record.table_name,
      column_record.column_name,
      format('Z-s vault routing field. %s', reference)
    );
  END LOOP;
END
$$;

COMMIT;
```

- [ ] **Step 4: Create migration 0004 down file**

Create `db/migrations/0004_storage_vault_routes_and_derivatives.down.sql`:

```sql
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  row_total bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM public.storage_object_copies WHERE storage_vault_id IS NOT NULL)
    + (SELECT count(*) FROM public.storage_object_derivations)
    INTO row_total;

  IF row_total <> 0 THEN
    RAISE EXCEPTION '0004 rollback blocked: vault runtime rows exist';
  END IF;
END
$$;

DROP INDEX IF EXISTS public.storage_objects_asset_origin_idx;
DROP INDEX IF EXISTS public.storage_object_copies_vault_state_idx;
DROP INDEX IF EXISTS public.storage_derivative_rules_profile_source_idx;
DROP INDEX IF EXISTS public.storage_route_rules_profile_asset_idx;
DROP INDEX IF EXISTS public.storage_profile_vault_bindings_read_priority_idx;
DROP INDEX IF EXISTS public.storage_profile_vault_bindings_profile_order_idx;
DROP INDEX IF EXISTS public.storage_vaults_profile_lookup_idx;
DROP INDEX IF EXISTS public.storage_object_copies_vault_route_idx;
DROP INDEX IF EXISTS public.storage_object_copies_legacy_object_role_idx;

ALTER TABLE public.storage_object_copies
  ADD CONSTRAINT storage_object_copies_storage_object_id_provider_role_key UNIQUE (storage_object_id, provider_role);

ALTER TABLE public.storage_object_copies
  ALTER COLUMN storage_profile_provider_binding_id SET NOT NULL,
  DROP COLUMN placement_intent,
  DROP COLUMN storage_route_rule_id,
  DROP COLUMN storage_profile_vault_binding_id,
  DROP COLUMN storage_vault_id;

ALTER TABLE public.storage_objects
  DROP COLUMN origin_kind,
  DROP COLUMN source_storage_object_id,
  DROP COLUMN asset_class_id;

DROP TABLE public.storage_object_derivations;
DROP TABLE public.storage_derivative_rules;
DROP TABLE public.storage_route_rules;
DROP TABLE public.storage_asset_classes;
DROP TABLE public.storage_profile_vault_bindings;
DROP TABLE public.storage_vaults;

COMMIT;
```

- [ ] **Step 5: Update static migration validation**

Modify `scripts/validate-migration.mjs`:

```javascript
const vaultFile = 'db/migrations/0004_storage_vault_routes_and_derivatives.sql';
const vaultRollbackFile = 'db/migrations/0004_storage_vault_routes_and_derivatives.down.sql';
const vaultSql = await readFile(vaultFile, 'utf8');
const vaultRollbackSql = await readFile(vaultRollbackFile, 'utf8');
const vaultReference =
  'apps/z-s_app/docs/superpowers/specs/2026-07-30-storage-vault-routing-and-image-resize-design.md';

const vaultTables = [
  'storage_asset_classes',
  'storage_derivative_rules',
  'storage_object_derivations',
  'storage_profile_vault_bindings',
  'storage_route_rules',
  'storage_vaults',
];
for (const table of vaultTables) {
  if (!new RegExp(`CREATE TABLE public\\.${table}\\s*\\(`, 'i').test(vaultSql)) {
    errors.push(`missing vault table ${table}`);
  }
  const tableComment = vaultSql.match(
    new RegExp(`COMMENT ON TABLE public\\.${table} IS '([^']*)'`, 'i'),
  );
  if (!tableComment) errors.push(`missing vault table comment ${table}`);
  else if (!tableComment[1]?.includes(vaultReference)) {
    errors.push(`vault table comment missing reference ${table}`);
  }
  if (!new RegExp(`DROP TABLE public\\.${table};`, 'i').test(vaultRollbackSql)) {
    errors.push(`rollback missing vault table ${table}`);
  }
}

const requiredVaultPatterns = [
  /SET LOCAL lock_timeout = '5s'/i,
  /SET LOCAL statement_timeout = '60s'/i,
  /0004 preflight missing table/i,
  /vault_kind IN \('canonical', 'hot', 'derivative', 'archive', 'temporary'\)/i,
  /retention_mode IN \('permanent', 'ttl', 'until-app-delete', 'legal-hold'\)/i,
  /CHECK \(\(retention_mode = 'ttl'\) = \(ttl_seconds IS NOT NULL\)\)/i,
  /ALTER COLUMN storage_profile_provider_binding_id DROP NOT NULL/i,
  /DROP CONSTRAINT storage_object_copies_storage_object_id_provider_role_key/i,
  /storage_object_copies_vault_route_idx/i,
  /COMMENT ON COLUMN public\.%I\.%I/i,
  /0004 rollback blocked/i,
];
for (const pattern of requiredVaultPatterns) {
  if (!pattern.test(`${vaultSql}\n${vaultRollbackSql}`)) {
    errors.push(`missing vault migration requirement ${pattern}`);
  }
}

if (/CREATE EXTENSION/i.test(vaultSql)) {
  errors.push('vault migration must not add PostgreSQL extensions');
}
if (/credential|endpoint|signed_url|bearer_token|object_key|prompt|user_name|project_title|scene_title/i.test(vaultSql)) {
  errors.push('vault migration contains prohibited private field wording');
}
```

Then extend the existing prohibited-column scan to include `vaultSql`:

```javascript
if (new RegExp(`^\\s*${prohibited}\\s+`, 'im').test(`${runtimeSql}\n${readSql}\n${vaultSql}`)) {
  errors.push(`prohibited runtime column ${prohibited}`);
}
```

- [ ] **Step 6: Update package scripts and package files**

Modify `package.json`:

```json
{
  "files": [
    "dist",
    "README.md",
    "docs/runtime-contract.md",
    "db/migrations/0002_z_s_runtime_registry.sql",
    "db/migrations/0002_z_s_runtime_registry.down.sql",
    "db/migrations/0003_z_s_read_delivery.sql",
    "db/migrations/0003_z_s_read_delivery.down.sql",
    "db/migrations/0004_storage_vault_routes_and_derivatives.sql",
    "db/migrations/0004_storage_vault_routes_and_derivatives.down.sql"
  ],
  "scripts": {
    "test:vault": "npm run test:compile && node --test .test-dist/tests/storage-vault-*.test.js",
    "smoke:admin-ui": "npm run build && node scripts/admin-ui-smoke.mjs"
  }
}
```

Preserve every existing script and dependency entry. Add only the two new scripts and the two migration files.

- [ ] **Step 7: Run Task 1 verification**

Run:

```bash
npm run validate:migration
npm run test:compile && node --test .test-dist/tests/storage-vault-migration.integration.test.js
```

Expected:

```text
migration static validation: passed
```

and the migration integration test passes when `TEST_DATABASE_URL` is configured. Without `TEST_DATABASE_URL`, the integration test is skipped by `node:test`.

- [ ] **Step 8: Commit Task 1**

```bash
git add package.json scripts/validate-migration.mjs db/migrations/0004_storage_vault_routes_and_derivatives.sql db/migrations/0004_storage_vault_routes_and_derivatives.down.sql tests/storage-vault-migration.integration.test.ts
git commit -m "feat: add storage vault routing schema"
```

---

### Task 2: Pure route planner

**Files:**
- Create: `src/storage-vault-types.ts`
- Create: `src/storage-vault-route-planner.ts`
- Test: `tests/storage-vault-route-planner.test.ts`

- [ ] **Step 1: Write failing planner tests**

Create `tests/storage-vault-route-planner.test.ts`:

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  StorageVaultRoutePlannerError,
  planStorageRoute,
} from '../src/storage-vault-route-planner.js';
import type { StorageRoutePlanningInput } from '../src/storage-vault-types.js';

const baseInput: StorageRoutePlanningInput = Object.freeze({
  storageProfileId: 'profile-01',
  mediaType: 'image/png',
  byteLength: 1024,
  assetClass: Object.freeze({
    id: 'asset-image',
    key: 'raw-production-image',
    mediaFamily: 'image',
    allowedMimeTypes: Object.freeze(['image/png', 'image/jpeg']),
    maxByteLength: 10_000_000,
  }),
  vaultBindings: Object.freeze([
    Object.freeze({
      id: 'binding-minio-permanent',
      bindingKey: 'raw-minio-permanent',
      storageProfileId: 'profile-01',
      storagePrefixClassId: 'prefix-raw',
      required: true,
      writeOrder: 1,
      readPriority: 20,
      status: 'active',
      vault: Object.freeze({
        id: 'vault-minio-permanent',
        key: 'raw-production-permanent',
        displayName: 'Raw Production Permanent',
        providerId: 'minio-provider',
        providerType: 'minio',
        bucketLabel: 'raw-production',
        basePrefixPattern: 'video-maker/raw/*',
        vaultKind: 'canonical',
        retentionPolicyId: 'permanent',
        retentionMode: 'permanent',
        accessMode: 'private',
        status: 'active',
      }),
    }),
    Object.freeze({
      id: 'binding-hot-ttl',
      bindingKey: 'raw-hot-7-days',
      storageProfileId: 'profile-01',
      storagePrefixClassId: 'prefix-raw',
      required: false,
      writeOrder: 2,
      readPriority: 10,
      status: 'active',
      vault: Object.freeze({
        id: 'vault-hot-ttl',
        key: 'raw-hot-7-days',
        displayName: 'Raw Hot 7 Days',
        providerId: 'r2-provider',
        providerType: 'r2',
        bucketLabel: 'raw-hot',
        basePrefixPattern: 'video-maker/hot/*',
        vaultKind: 'temporary',
        retentionPolicyId: 'ttl-7-days',
        retentionMode: 'ttl',
        ttlSeconds: 604_800,
        accessMode: 'signed-read',
        status: 'active',
      }),
    }),
  ]),
  routeRules: Object.freeze([
    Object.freeze({
      id: 'route-minio',
      routeKey: 'raw-image-minio',
      storageProfileId: 'profile-01',
      assetClassId: 'asset-image',
      operationClass: 'user-upload',
      destinationVaultBindingId: 'binding-minio-permanent',
      placementIntent: 'primary',
      required: true,
      failurePolicy: 'fail-write',
      status: 'active',
    }),
    Object.freeze({
      id: 'route-hot',
      routeKey: 'raw-image-hot',
      storageProfileId: 'profile-01',
      assetClassId: 'asset-image',
      operationClass: 'user-upload',
      destinationVaultBindingId: 'binding-hot-ttl',
      placementIntent: 'cache',
      required: false,
      failurePolicy: 'allow-degraded',
      status: 'active',
    }),
  ]),
  derivativeRules: Object.freeze([
    Object.freeze({
      id: 'derivative-preview',
      storageProfileId: 'profile-01',
      sourceAssetClassId: 'asset-image',
      derivativeAssetClassId: 'asset-image-resize',
      derivativeKey: 'web-1280',
      processor: 'image-resize',
      processorConfig: Object.freeze({ width: 1280, fit: 'inside', format: 'webp', quality: 82 }),
      destinationVaultBindingId: 'binding-minio-permanent',
      triggerMode: 'on-upload-complete',
      required: false,
      status: 'active',
      executionEnabled: false,
    }),
  ]),
  capabilityEvidence: Object.freeze([
    Object.freeze({
      storageProfileId: 'profile-01',
      providerId: 'minio-provider',
      bucketLabel: 'raw-production',
      storagePrefixClassId: 'prefix-raw',
      capability: 'write-object',
      result: 'passed',
    }),
    Object.freeze({
      storageProfileId: 'profile-01',
      providerId: 'r2-provider',
      bucketLabel: 'raw-hot',
      storagePrefixClassId: 'prefix-raw',
      capability: 'write-object',
      result: 'passed',
    }),
  ]),
});

test('plans one asset to many vaults when permanent required and temporary hot is optional', () => {
  const plan = planStorageRoute(baseInput);

  assert.equal(plan.assetClassKey, 'raw-production-image');
  assert.deepEqual(plan.placements.map((placement) => placement.vaultKey), [
    'raw-production-permanent',
    'raw-hot-7-days',
  ]);
  assert.deepEqual(plan.placements.map((placement) => placement.required), [true, false]);
  assert.deepEqual(plan.placements.map((placement) => placement.retentionMode), ['permanent', 'ttl']);
  assert.equal(plan.derivatives.length, 1);
  assert.equal(plan.derivatives[0]?.executionEnabled, false);
});

test('rejects durable uploads with only temporary vault routes', () => {
  const input: StorageRoutePlanningInput = Object.freeze({
    ...baseInput,
    vaultBindings: Object.freeze([baseInput.vaultBindings[1]]),
    routeRules: Object.freeze([baseInput.routeRules[1]]),
  });

  assert.throws(
    () => planStorageRoute(input),
    (error: unknown) =>
      error instanceof StorageVaultRoutePlannerError && error.code === 'temporary-only-durable-route',
  );
});

test('rejects image resize derivatives for non-image source asset classes', () => {
  const input: StorageRoutePlanningInput = Object.freeze({
    ...baseInput,
    mediaType: 'video/mp4',
    assetClass: Object.freeze({
      id: 'asset-video',
      key: 'raw-production-video',
      mediaFamily: 'video',
      allowedMimeTypes: Object.freeze(['video/mp4']),
    }),
    routeRules: Object.freeze([
      Object.freeze({ ...baseInput.routeRules[0], assetClassId: 'asset-video' }),
    ]),
    derivativeRules: Object.freeze([
      Object.freeze({ ...baseInput.derivativeRules[0], sourceAssetClassId: 'asset-video' }),
    ]),
  });

  assert.throws(
    () => planStorageRoute(input),
    (error: unknown) =>
      error instanceof StorageVaultRoutePlannerError && error.code === 'image-derivative-source-required',
  );
});
```

- [ ] **Step 2: Run planner tests to verify RED**

Run: `npm run test:compile && node --test .test-dist/tests/storage-vault-route-planner.test.js`

Expected: FAIL because `../src/storage-vault-route-planner.js` does not exist.

- [ ] **Step 3: Add shared vault types**

Create `src/storage-vault-types.ts`:

```typescript
export type StorageProviderType = 'minio' | 'r2' | 's3-compatible';
export type StorageVaultKind = 'canonical' | 'hot' | 'derivative' | 'archive' | 'temporary';
export type StorageRetentionMode = 'permanent' | 'ttl' | 'until-app-delete' | 'legal-hold';
export type StorageAccessMode = 'private' | 'signed-read' | 'public-approved';
export type StorageConfigStatus = 'draft' | 'active' | 'disabled';
export type StorageAssetMediaFamily = 'image' | 'video' | 'document' | 'binary' | 'any';
export type StoragePlacementIntent = 'primary' | 'additional' | 'cache' | 'archive';
export type StorageFailurePolicy = 'fail-write' | 'allow-degraded' | 'retry-background';
export type StorageDerivativeProcessor = 'image-resize';
export type StorageDerivativeTriggerMode = 'on-upload-complete' | 'manual' | 'job';

export interface StorageVaultSummary {
  readonly id: string;
  readonly key: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly providerType: StorageProviderType;
  readonly bucketLabel: string;
  readonly basePrefixPattern: string;
  readonly vaultKind: StorageVaultKind;
  readonly retentionPolicyId: string;
  readonly retentionMode: StorageRetentionMode;
  readonly ttlSeconds?: number;
  readonly accessMode: StorageAccessMode;
  readonly status: StorageConfigStatus;
}

export interface StorageProfileVaultBindingSummary {
  readonly id: string;
  readonly bindingKey: string;
  readonly storageProfileId: string;
  readonly storagePrefixClassId: string;
  readonly required: boolean;
  readonly writeOrder: number;
  readonly readPriority?: number;
  readonly status: StorageConfigStatus;
  readonly vault: Readonly<StorageVaultSummary>;
}

export interface StorageAssetClassSummary {
  readonly id: string;
  readonly key: string;
  readonly mediaFamily: StorageAssetMediaFamily;
  readonly allowedMimeTypes: readonly string[];
  readonly maxByteLength?: number;
}

export interface StorageRouteRuleSummary {
  readonly id: string;
  readonly routeKey: string;
  readonly storageProfileId: string;
  readonly assetClassId: string;
  readonly operationClass: string;
  readonly destinationVaultBindingId: string;
  readonly placementIntent: StoragePlacementIntent;
  readonly required: boolean;
  readonly failurePolicy: StorageFailurePolicy;
  readonly status: StorageConfigStatus;
}

export interface StorageDerivativeRuleSummary {
  readonly id: string;
  readonly storageProfileId: string;
  readonly sourceAssetClassId: string;
  readonly derivativeAssetClassId: string;
  readonly derivativeKey: string;
  readonly processor: StorageDerivativeProcessor;
  readonly processorConfig: Readonly<Record<string, string | number | boolean>>;
  readonly destinationVaultBindingId: string;
  readonly triggerMode: StorageDerivativeTriggerMode;
  readonly required: boolean;
  readonly status: StorageConfigStatus;
  readonly executionEnabled: false;
}

export interface StorageCapabilityEvidenceSummary {
  readonly storageProfileId: string;
  readonly providerId: string;
  readonly bucketLabel: string;
  readonly storagePrefixClassId: string;
  readonly capability: 'write-object' | 'read-object' | 'delete-object' | 'list-prefix';
  readonly result: 'passed' | 'failed' | 'unknown';
}

export interface StorageRoutePlanningInput {
  readonly storageProfileId: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly assetClass: Readonly<StorageAssetClassSummary>;
  readonly vaultBindings: readonly Readonly<StorageProfileVaultBindingSummary>[];
  readonly routeRules: readonly Readonly<StorageRouteRuleSummary>[];
  readonly derivativeRules: readonly Readonly<StorageDerivativeRuleSummary>[];
  readonly capabilityEvidence: readonly Readonly<StorageCapabilityEvidenceSummary>[];
}

export interface StorageRoutePlanPlacement {
  readonly routeRuleId: string;
  readonly routeKey: string;
  readonly vaultBindingId: string;
  readonly vaultId: string;
  readonly vaultKey: string;
  readonly vaultKind: StorageVaultKind;
  readonly providerId: string;
  readonly providerType: StorageProviderType;
  readonly bucketLabel: string;
  readonly basePrefixPattern: string;
  readonly storagePrefixClassId: string;
  readonly placementIntent: StoragePlacementIntent;
  readonly required: boolean;
  readonly failurePolicy: StorageFailurePolicy;
  readonly retentionMode: StorageRetentionMode;
  readonly ttlSeconds?: number;
  readonly writeOrder: number;
  readonly readPriority?: number;
  readonly capabilityReady: boolean;
}

export interface StorageDerivativePlanPreview {
  readonly derivativeRuleId: string;
  readonly derivativeKey: string;
  readonly processor: StorageDerivativeProcessor;
  readonly processorConfig: Readonly<Record<string, string | number | boolean>>;
  readonly destinationVaultBindingId: string;
  readonly destinationVaultKey: string;
  readonly triggerMode: StorageDerivativeTriggerMode;
  readonly required: boolean;
  readonly executionEnabled: false;
}

export interface StorageRoutePlanWarning {
  readonly code: 'capability-evidence-missing' | 'temporary-copy-expires' | 'derivative-execution-disabled';
  readonly message: string;
}

export interface StorageRoutePlan {
  readonly storageProfileId: string;
  readonly assetClassId: string;
  readonly assetClassKey: string;
  readonly mediaType: string;
  readonly placements: readonly Readonly<StorageRoutePlanPlacement>[];
  readonly derivatives: readonly Readonly<StorageDerivativePlanPreview>[];
  readonly warnings: readonly Readonly<StorageRoutePlanWarning>[];
}
```

- [ ] **Step 4: Implement the pure planner**

Create `src/storage-vault-route-planner.ts`:

```typescript
import type {
  StorageCapabilityEvidenceSummary,
  StorageDerivativePlanPreview,
  StorageProfileVaultBindingSummary,
  StorageRoutePlan,
  StorageRoutePlanPlacement,
  StorageRoutePlanWarning,
  StorageRoutePlanningInput,
} from './storage-vault-types.js';

export class StorageVaultRoutePlannerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'StorageVaultRoutePlannerError';
    this.code = code;
  }
}

function isImageAsset(input: StorageRoutePlanningInput): boolean {
  if (input.assetClass.mediaFamily === 'image') return true;
  if (input.assetClass.mediaFamily !== 'any') return false;
  return input.assetClass.allowedMimeTypes.every((mimeType) => mimeType.startsWith('image/'));
}

function activeBindingById(
  bindings: readonly Readonly<StorageProfileVaultBindingSummary>[],
): ReadonlyMap<string, Readonly<StorageProfileVaultBindingSummary>> {
  return new Map(
    bindings
      .filter((binding) => binding.status === 'active' && binding.vault.status === 'active')
      .map((binding) => [binding.id, binding]),
  );
}

function capabilityReady(
  evidence: readonly Readonly<StorageCapabilityEvidenceSummary>[],
  binding: Readonly<StorageProfileVaultBindingSummary>,
): boolean {
  return evidence.some((entry) =>
    entry.storageProfileId === binding.storageProfileId &&
    entry.providerId === binding.vault.providerId &&
    entry.bucketLabel === binding.vault.bucketLabel &&
    entry.storagePrefixClassId === binding.storagePrefixClassId &&
    entry.capability === 'write-object' &&
    entry.result === 'passed',
  );
}

function durableRequired(placement: Readonly<StorageRoutePlanPlacement>): boolean {
  return placement.required && (
    placement.retentionMode === 'permanent' ||
    placement.retentionMode === 'until-app-delete' ||
    placement.retentionMode === 'legal-hold'
  );
}

function warningForTemporaryCopy(
  placement: Readonly<StorageRoutePlanPlacement>,
): StorageRoutePlanWarning | null {
  if (placement.retentionMode !== 'ttl') return null;
  return Object.freeze({
    code: 'temporary-copy-expires',
    message: `${placement.vaultKey} expires after ${placement.ttlSeconds ?? 0} seconds`,
  });
}

export function planStorageRoute(input: Readonly<StorageRoutePlanningInput>): Readonly<StorageRoutePlan> {
  if (!input.assetClass.allowedMimeTypes.includes(input.mediaType)) {
    throw new StorageVaultRoutePlannerError('media-type-not-allowed');
  }
  if (input.assetClass.maxByteLength !== undefined && input.byteLength > input.assetClass.maxByteLength) {
    throw new StorageVaultRoutePlannerError('byte-length-exceeds-asset-class-limit');
  }

  const bindings = activeBindingById(input.vaultBindings);
  const placements: StorageRoutePlanPlacement[] = input.routeRules
    .filter((rule) =>
      rule.status === 'active' &&
      rule.storageProfileId === input.storageProfileId &&
      rule.assetClassId === input.assetClass.id,
    )
    .map((rule) => {
      const binding = bindings.get(rule.destinationVaultBindingId);
      if (binding === undefined) {
        throw new StorageVaultRoutePlannerError('route-destination-binding-inactive');
      }
      const ready = capabilityReady(input.capabilityEvidence, binding);
      const placement: StorageRoutePlanPlacement = {
        routeRuleId: rule.id,
        routeKey: rule.routeKey,
        vaultBindingId: binding.id,
        vaultId: binding.vault.id,
        vaultKey: binding.vault.key,
        vaultKind: binding.vault.vaultKind,
        providerId: binding.vault.providerId,
        providerType: binding.vault.providerType,
        bucketLabel: binding.vault.bucketLabel,
        basePrefixPattern: binding.vault.basePrefixPattern,
        storagePrefixClassId: binding.storagePrefixClassId,
        placementIntent: rule.placementIntent,
        required: rule.required,
        failurePolicy: rule.failurePolicy,
        retentionMode: binding.vault.retentionMode,
        ...(binding.vault.ttlSeconds === undefined ? {} : { ttlSeconds: binding.vault.ttlSeconds }),
        writeOrder: binding.writeOrder,
        ...(binding.readPriority === undefined ? {} : { readPriority: binding.readPriority }),
        capabilityReady: ready,
      };
      return Object.freeze(placement);
    })
    .sort((left, right) => left.writeOrder - right.writeOrder || left.routeKey.localeCompare(right.routeKey));

  if (placements.length === 0) {
    throw new StorageVaultRoutePlannerError('route-plan-empty');
  }
  if (!placements.some(durableRequired)) {
    throw new StorageVaultRoutePlannerError('temporary-only-durable-route');
  }

  const derivatives: StorageDerivativePlanPreview[] = input.derivativeRules
    .filter((rule) =>
      rule.status === 'active' &&
      rule.storageProfileId === input.storageProfileId &&
      rule.sourceAssetClassId === input.assetClass.id,
    )
    .map((rule) => {
      if (rule.processor === 'image-resize' && !isImageAsset(input)) {
        throw new StorageVaultRoutePlannerError('image-derivative-source-required');
      }
      const binding = bindings.get(rule.destinationVaultBindingId);
      if (binding === undefined) {
        throw new StorageVaultRoutePlannerError('derivative-destination-binding-inactive');
      }
      return Object.freeze({
        derivativeRuleId: rule.id,
        derivativeKey: rule.derivativeKey,
        processor: rule.processor,
        processorConfig: rule.processorConfig,
        destinationVaultBindingId: binding.id,
        destinationVaultKey: binding.vault.key,
        triggerMode: rule.triggerMode,
        required: rule.required,
        executionEnabled: false,
      });
    });

  const warnings = placements.flatMap((placement) => {
    const values: StorageRoutePlanWarning[] = [];
    if (!placement.capabilityReady) {
      values.push(Object.freeze({
        code: 'capability-evidence-missing',
        message: `${placement.vaultKey} lacks current write-object capability evidence`,
      }));
    }
    const temporaryWarning = warningForTemporaryCopy(placement);
    if (temporaryWarning !== null) values.push(temporaryWarning);
    return values;
  });
  if (derivatives.length > 0) {
    warnings.push(Object.freeze({
      code: 'derivative-execution-disabled',
      message: 'Image resize rules are configured for preview but execution is disabled',
    }));
  }

  return Object.freeze({
    storageProfileId: input.storageProfileId,
    assetClassId: input.assetClass.id,
    assetClassKey: input.assetClass.key,
    mediaType: input.mediaType,
    placements: Object.freeze(placements),
    derivatives: Object.freeze(derivatives),
    warnings: Object.freeze(warnings),
  });
}
```

- [ ] **Step 5: Run planner verification**

Run:

```bash
npm run test:compile && node --test .test-dist/tests/storage-vault-route-planner.test.js
npm run typecheck
```

Expected: all planner tests pass; typecheck exits 0.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/storage-vault-types.ts src/storage-vault-route-planner.ts tests/storage-vault-route-planner.test.ts
git commit -m "feat: add vault route planner"
```

---

### Task 3: Postgres control-plane repository

**Files:**
- Create: `src/storage-vault-control-plane.ts`
- Test: `tests/storage-vault-admin-api.test.ts`

- [ ] **Step 1: Write failing repository/API fixture tests**

Start `tests/storage-vault-admin-api.test.ts` with repository-level assertions before HTTP routing:

```typescript
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { PostgresStorageVaultControlPlane } from '../src/storage-vault-control-plane.js';
import type { PostgresClientLike, PostgresPoolLike } from '../src/runtime-storage-registry.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationTest = databaseUrl === undefined ? test.skip : test;

function adaptClient(client: PoolClient): PostgresClientLike {
  return {
    query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
      const result = await client.query<Row>(text, values as unknown[] | undefined);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    release: () => client.release(),
  };
}

function adaptPool(pool: Pool): PostgresPoolLike {
  return { connect: async () => adaptClient(await pool.connect()) };
}

async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  for (const file of [
    'db/migrations/0001_z_s_control_plane_foundation.sql',
    'db/migrations/0002_z_s_runtime_registry.sql',
    'db/migrations/0003_z_s_read_delivery.sql',
    'db/migrations/0004_storage_vault_routes_and_derivatives.sql',
  ]) {
    await pool.query(await readFile(file, 'utf8'));
  }
}

integrationTest('control plane creates secret-safe providers, vaults, asset classes, route rules, derivative rules, and preview plans', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    await resetDatabase(pool);
    const controlPlane = new PostgresStorageVaultControlPlane({
      pool: adaptPool(pool),
      now: () => new Date('2026-07-30T00:00:00.000Z'),
      createId: (() => {
        let next = 1;
        return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`;
      })(),
    });

    const provider = await controlPlane.createProvider({
      providerId: 'r2-video-maker-dev',
      providerType: 'r2',
      runtimeBindingLabel: 'r2-video-maker-dev-binding',
      status: 'active',
      actor: { role: 'admin-api', reference: 'manual-qa' },
    });
    assert.deepEqual(Object.keys(provider).sort(), [
      'createdAt',
      'id',
      'providerId',
      'providerType',
      'runtimeBindingConfigured',
      'runtimeBindingLabel',
      'status',
      'updatedAt',
    ]);
    assert.equal(provider.runtimeBindingLabel, 'r2-video-maker-dev-binding');

    const preview = await controlPlane.previewRoutePlan({
      storageProfileId: '00000000-0000-4000-8000-000000000004',
      assetClassKey: 'raw-production-image',
      mediaType: 'image/png',
      byteLength: 1024,
    });
    assert.equal(preview.placements.length >= 1, true);
    assert.equal(JSON.stringify(preview).includes('credential'), false);
    assert.equal(JSON.stringify(preview).includes('secret'), false);
    assert.equal(JSON.stringify(preview).includes('://'), false);
  } finally {
    await pool.end();
  }
});
```

- [ ] **Step 2: Run repository test to verify RED**

Run: `npm run test:compile && node --test .test-dist/tests/storage-vault-admin-api.test.js`

Expected: FAIL because `../src/storage-vault-control-plane.js` does not exist.

- [ ] **Step 3: Implement repository DTOs and constructor**

Create `src/storage-vault-control-plane.ts` with public DTOs:

```typescript
import { randomUUID } from 'node:crypto';
import type { PostgresPoolLike, PostgresQueryable } from './runtime-storage-registry-types.js';
import { planStorageRoute } from './storage-vault-route-planner.js';
import type {
  StorageProviderType,
  StorageRoutePlan,
  StorageRoutePlanningInput,
  StorageConfigStatus,
} from './storage-vault-types.js';

export interface StorageVaultControlPlaneOptions {
  readonly pool: PostgresPoolLike;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export interface StorageAdminActor {
  readonly role: 'admin-api' | 'admin-ui' | 'runtime-seed';
  readonly reference: string;
}

export interface ProviderAdminInput {
  readonly providerId: string;
  readonly providerType: StorageProviderType;
  readonly runtimeBindingLabel: string;
  readonly status: StorageConfigStatus;
  readonly actor: Readonly<StorageAdminActor>;
}

export interface ProviderAdminSummary {
  readonly id: string;
  readonly providerId: string;
  readonly providerType: StorageProviderType;
  readonly status: StorageConfigStatus;
  readonly runtimeBindingLabel: string;
  readonly runtimeBindingConfigured: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PreviewRoutePlanInput {
  readonly storageProfileId: string;
  readonly assetClassKey: string;
  readonly mediaType: string;
  readonly byteLength: number;
}

interface ProviderRow extends Record<string, unknown> {
  readonly id: string;
  readonly provider_id: string;
  readonly provider_type: StorageProviderType;
  readonly status: StorageConfigStatus;
  readonly secret_reference_id: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

export class StorageVaultControlPlaneError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'StorageVaultControlPlaneError';
    this.code = code;
    this.status = status;
  }
}
```

- [ ] **Step 4: Implement provider create/list and audit emission**

Add methods to `PostgresStorageVaultControlPlane`:

```typescript
export class PostgresStorageVaultControlPlane {
  readonly #pool: PostgresPoolLike;
  readonly #now: () => Date;
  readonly #createId: () => string;

  constructor(options: StorageVaultControlPlaneOptions) {
    this.#pool = options.pool;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  async createProvider(input: Readonly<ProviderAdminInput>): Promise<Readonly<ProviderAdminSummary>> {
    const client = await this.#pool.connect();
    try {
      const now = this.#now();
      const id = this.#createId();
      const result = await client.query<ProviderRow>(
        `INSERT INTO public.storage_providers
           (id, provider_id, provider_type, status, secret_reference_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         RETURNING id, provider_id, provider_type, status, secret_reference_id, created_at, updated_at`,
        [id, input.providerId, input.providerType, input.status, input.runtimeBindingLabel, now],
      );
      await this.#appendAudit(client, {
        eventType: 'storage-provider-created',
        profileId: 'provider-admin',
        profileVersion: 1,
        actor: input.actor,
        summary: { providerId: input.providerId, providerType: input.providerType, status: input.status },
      });
      const row = result.rows[0];
      if (row === undefined) throw new StorageVaultControlPlaneError('provider-create-failed', 500);
      return mapProvider(row);
    } finally {
      client.release();
    }
  }

  async listProviders(): Promise<readonly Readonly<ProviderAdminSummary>[]> {
    const client = await this.#pool.connect();
    try {
      const result = await client.query<ProviderRow>(
        `SELECT id, provider_id, provider_type, status, secret_reference_id, created_at, updated_at
           FROM public.storage_providers
          ORDER BY provider_id`,
      );
      return Object.freeze(result.rows.map(mapProvider));
    } finally {
      client.release();
    }
  }

  async #appendAudit(
    client: PostgresQueryable,
    input: Readonly<{
      eventType: string;
      profileId: string;
      profileVersion: number;
      actor: Readonly<StorageAdminActor>;
      summary: Readonly<Record<string, string | number | boolean>>;
    }>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO public.storage_profile_audit_events
         (id, event_type, profile_id, profile_version, actor_role, safe_change_summary, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        this.#createId(),
        input.eventType,
        input.profileId,
        input.profileVersion,
        input.actor.role,
        JSON.stringify(input.summary),
        this.#now(),
      ],
    );
  }
}

function mapProvider(row: ProviderRow): Readonly<ProviderAdminSummary> {
  return Object.freeze({
    id: row.id,
    providerId: row.provider_id,
    providerType: row.provider_type,
    status: row.status,
    runtimeBindingLabel: row.secret_reference_id,
    runtimeBindingConfigured: row.secret_reference_id.length > 0,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}
```

- [ ] **Step 5: Implement preview read model**

Add `previewRoutePlan()` that queries asset class, vault bindings, route rules, derivative rules, and capability evidence, maps them to `StorageRoutePlanningInput`, then calls `planStorageRoute(input)`. The method must not include `secret_reference_id`, provider endpoints, bucket internals beyond `bucketLabel`, or internal object locators in its returned plan.

Use this method signature:

```typescript
async previewRoutePlan(input: Readonly<PreviewRoutePlanInput>): Promise<Readonly<StorageRoutePlan>>
```

Use exactly these error codes:

- `asset-class-not-found` with status 404.
- `route-plan-unavailable` with status 503 for unexpected query failures.
- Planner error code with status 409 for `StorageVaultRoutePlannerError`.

- [ ] **Step 6: Run Task 3 verification**

Run:

```bash
npm run test:compile && node --test .test-dist/tests/storage-vault-admin-api.test.js
npm run typecheck
```

Expected: repository test passes and typecheck exits 0.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/storage-vault-control-plane.ts tests/storage-vault-admin-api.test.ts
git commit -m "feat: add vault control-plane repository"
```

---

### Task 4: Secret-safe admin API runtime

**Files:**
- Create: `src/storage-vault-admin-api.ts`
- Modify: `tests/storage-vault-admin-api.test.ts`
- Modify: `src/runtime-local-composition.ts`

- [ ] **Step 1: Add failing HTTP admin API tests**

Extend `tests/storage-vault-admin-api.test.ts`:

```typescript
import { createStorageVaultAdminRuntime } from '../src/storage-vault-admin-api.js';

test('admin API rejects unauthenticated requests and returns secret-safe provider responses', async () => {
  const calls: string[] = [];
  const runtime = createStorageVaultAdminRuntime({
    authenticate: (token) => token === 'admin-token' ? { appId: 'video-maker_app', serviceId: 'api' } : null,
    authorizeCaller: (caller) => caller.appId === 'video-maker_app' && caller.serviceId === 'api',
    controlPlane: {
      listProviders: async () => [Object.freeze({
        id: 'provider-row',
        providerId: 'r2-video-maker-dev',
        providerType: 'r2',
        status: 'active',
        runtimeBindingLabel: 'r2-video-maker-dev-binding',
        runtimeBindingConfigured: true,
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:00.000Z',
      })],
      createProvider: async () => {
        calls.push('createProvider');
        throw new Error('not used in this test');
      },
      previewRoutePlan: async () => {
        throw new Error('not used in this test');
      },
    },
  });

  const denied = await runtime.handle(new Request('http://local/admin/storage/api/providers'));
  assert.equal(denied.status, 401);

  const response = await runtime.handle(new Request('http://local/admin/storage/api/providers', {
    headers: {
      authorization: 'Bearer admin-token',
      'x-zs-caller-app': 'video-maker_app',
    },
  }));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes('secret'), false);
  assert.equal(text.includes('endpoint'), false);
  assert.equal(text.includes('signed_url'), false);
  assert.equal(calls.length, 0);
});
```

- [ ] **Step 2: Run API test to verify RED**

Run: `npm run test:compile && node --test .test-dist/tests/storage-vault-admin-api.test.js`

Expected: FAIL because `createStorageVaultAdminRuntime` is not exported.

- [ ] **Step 3: Implement admin API runtime interfaces and routing**

Create `src/storage-vault-admin-api.ts`:

```typescript
import type { CallerIdentity, HttpStorageRuntime, SafeDiagnostic } from './runtime-contract.js';
import type {
  PostgresStorageVaultControlPlane,
  PreviewRoutePlanInput,
  ProviderAdminInput,
  ProviderAdminSummary,
} from './storage-vault-control-plane.js';

interface StorageVaultAdminControlPlane {
  listProviders(): Promise<readonly Readonly<ProviderAdminSummary>[]>;
  createProvider(input: Readonly<ProviderAdminInput>): Promise<Readonly<ProviderAdminSummary>>;
  previewRoutePlan(input: Readonly<PreviewRoutePlanInput>): Promise<unknown>;
}

export interface StorageVaultAdminRuntimeOptions {
  readonly authenticate: (bearerToken: string) => Promise<CallerIdentity | null> | CallerIdentity | null;
  readonly authorizeCaller: (caller: Readonly<CallerIdentity>) => Promise<boolean> | boolean;
  readonly controlPlane: StorageVaultAdminControlPlane | PostgresStorageVaultControlPlane;
}

class StorageVaultAdminApiError extends Error {
  readonly diagnostic: SafeDiagnostic;
  readonly status: number;

  constructor(status: number, code: string, category: SafeDiagnostic['category'] = 'invalid-request') {
    super(code);
    this.name = 'StorageVaultAdminApiError';
    this.status = status;
    this.diagnostic = Object.freeze({ category, code, retryable: false });
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.freeze({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    }),
  });
}
```

Implement `createStorageVaultAdminRuntime(options)` with these route rules:

- `GET /admin/storage/api/providers` -> `controlPlane.listProviders()`.
- `POST /admin/storage/api/providers` -> parse JSON to `ProviderAdminInput` and call `createProvider()`.
- `POST /admin/storage/api/preview-route` -> parse JSON to `PreviewRoutePlanInput` and call `previewRoutePlan()`.
- Unknown `/admin/storage/api/*` -> 404 with diagnostic code `admin-route-not-found`.
- Non-admin URL -> 404 with diagnostic code `route-not-found` so existing route composition can fall through.

Boundary parsers must accept only these provider fields:

```typescript
{
  readonly providerId: string;
  readonly providerType: 'minio' | 'r2' | 's3-compatible';
  readonly runtimeBindingLabel: string;
  readonly status: 'draft' | 'active' | 'disabled';
}
```

Reject payloads that contain these keys at any depth: `credential`, `secret`, `endpoint`, `signed_url`, `bearer`, `object_key`, `locator`, `prompt`, `user_name`, `project_title`, `scene_title`.

- [ ] **Step 4: Compose admin runtime before write/read fallback**

In `src/runtime-local-composition.ts`, create the admin runtime next to `writeRuntime` and `readRuntime`:

```typescript
const vaultControlPlane = new PostgresStorageVaultControlPlane({ pool });
const adminRuntime = createStorageVaultAdminRuntime({
  authenticate: authenticateCaller,
  authorizeCaller,
  controlPlane: vaultControlPlane,
});
const runtime = composeStorageRuntimeRoutes(
  adminRuntime,
  composeStorageRuntimeRoutes(writeRuntime, readRuntime),
);
```

Keep the existing `composeStorageRuntimeRoutes` behavior: only a `route-not-found` body falls through.

- [ ] **Step 5: Run Task 4 verification**

Run:

```bash
npm run test:compile && node --test .test-dist/tests/storage-vault-admin-api.test.js
npm run typecheck
```

Expected: admin API tests pass and typecheck exits 0.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/storage-vault-admin-api.ts src/runtime-local-composition.ts tests/storage-vault-admin-api.test.ts
git commit -m "feat: add vault admin API"
```

---

### Task 5: Internal admin UI and design system

**Files:**
- Create: `DESIGN.md`
- Create: `src/storage-vault-admin-ui.ts`
- Create: `tests/storage-vault-admin-ui.test.ts`
- Create: `scripts/admin-ui-smoke.mjs`
- Modify: `src/runtime-local-composition.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the UI design system first**

Create `DESIGN.md` with this content:

```markdown
# Z-s Storage Admin Design System

## 1. Product surface

Internal Z-s admin control surface for configuring storage providers, vaults, asset classes, route rules, image-resize preview rules, and route readiness. It is operational and data-dense, not a marketing surface.

## 2. Visual direction

Atmosphere: quiet infrastructure console with high legibility, low ornament, and clear risk states. Signature material: layered white panels on a cool gray canvas with a single blue focus rail for the active workflow. Color story: neutral gray foundation, blue action states, amber warnings, red blocking errors, green readiness.

## 3. Tokens

- `color.canvas`: `#f8fafc`
- `color.panel`: `#ffffff`
- `color.panelSubtle`: `#f1f5f9`
- `color.text`: `#0f172a`
- `color.textMuted`: `#475569`
- `color.border`: `#cbd5e1`
- `color.action`: `#2563eb`
- `color.actionHover`: `#1d4ed8`
- `color.ready`: `#15803d`
- `color.warning`: `#b45309`
- `color.danger`: `#b91c1c`
- `space.1`: `4px`
- `space.2`: `8px`
- `space.3`: `12px`
- `space.4`: `16px`
- `space.6`: `24px`
- `space.8`: `32px`
- `radius.panel`: `14px`
- `radius.control`: `10px`
- `shadow.panel`: `0 18px 45px rgba(15, 23, 42, 0.08)`

## 4. Typography

Use system UI fonts. Page title: 24px/32px, semibold. Section title: 16px/24px, semibold. Body: 14px/22px. Code and keys: 13px/20px with `ui-monospace, SFMono-Regular, Consolas, monospace`.

## 5. Components

- App shell: two-column layout, left navigation 240px, main content minmax 0/1fr.
- Panel: white background, border token, panel radius, panel shadow, 24px padding.
- Data table: sticky header, 12px cell padding, muted metadata line.
- Form row: label above input, help text below input, error text below help text.
- Status chip: uppercase 12px label, color by readiness/warning/danger/action.
- Preview timeline: vertical list of placements, each card shows vault key, provider type, retention, required flag, failure policy.
- Derivative banner: warning chip plus text “configured for preview, not executing.”

## 6. Interaction and accessibility

All controls are keyboard reachable. Buttons use visible focus outlines with `color.action`. Motion is limited to 120ms opacity or transform transitions for hover/focus only. All form fields have visible labels. Warnings never rely on color alone.

## 7. Accepted debt

This first UI is internal and vanilla. It does not include tenant RBAC, React dev tooling, drag-and-drop route editing, or live image processing status.
```

- [ ] **Step 2: Write failing UI asset smoke tests**

Create `tests/storage-vault-admin-ui.test.ts`:

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStorageVaultAdminUiRuntime } from '../src/storage-vault-admin-ui.js';

test('admin UI serves HTML, CSS, and JS without prohibited private strings', async () => {
  const runtime = createStorageVaultAdminUiRuntime();
  for (const path of ['/admin/storage', '/admin/storage/admin.css', '/admin/storage/admin.js']) {
    const response = await runtime.handle(new Request(`http://local${path}`));
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes('secret'), false);
    assert.equal(text.includes('credential'), false);
    assert.equal(text.includes('endpoint'), false);
    assert.equal(text.includes('signed_url'), false);
    assert.equal(text.includes('object_key'), false);
  }
});

test('admin UI route falls through with route-not-found for unrelated paths', async () => {
  const runtime = createStorageVaultAdminUiRuntime();
  const response = await runtime.handle(new Request('http://local/health'));
  assert.equal(response.status, 404);
  assert.equal(await response.text(), '{"error":{"diagnostic":{"category":"not-ready","code":"route-not-found","retryable":false}}}');
});
```

- [ ] **Step 3: Run UI tests to verify RED**

Run: `npm run test:compile && node --test .test-dist/tests/storage-vault-admin-ui.test.js`

Expected: FAIL because `../src/storage-vault-admin-ui.js` does not exist.

- [ ] **Step 4: Implement the UI runtime**

Create `src/storage-vault-admin-ui.ts` with three embedded assets:

```typescript
import type { HttpStorageRuntime } from './runtime-contract.js';

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Z-s Storage Admin</title>
  <link rel="stylesheet" href="/admin/storage/admin.css">
</head>
<body>
  <div class="shell">
    <nav class="nav" aria-label="Storage admin sections">
      <strong>Z-s Storage</strong>
      <a href="#providers">Providers</a>
      <a href="#vaults">Vaults</a>
      <a href="#asset-classes">Asset Classes</a>
      <a href="#route-rules">Route Rules</a>
      <a href="#resize-rules">Image Resize Rules</a>
      <a href="#preview">Preview</a>
    </nav>
    <main class="main">
      <header class="hero">
        <p class="eyebrow">Internal admin</p>
        <h1>Storage vault routing</h1>
        <p>Configure provider-backed vaults, placement rules, retention, and image resize previews without exposing provider-private values.</p>
      </header>
      <section class="panel" id="providers">
        <h2>Providers</h2>
        <p class="muted">Register R2, MinIO, or S3-compatible identities using a runtime binding label only.</p>
        <div id="providers-output" class="output" aria-live="polite">Loading providers</div>
      </section>
      <section class="panel" id="preview">
        <h2>Preview route plan</h2>
        <form id="preview-form">
          <label>Storage profile UUID<input name="storageProfileId" required></label>
          <label>Asset class key<input name="assetClassKey" required value="raw-production-image"></label>
          <label>Media type<input name="mediaType" required value="image/png"></label>
          <label>Byte length<input name="byteLength" required inputmode="numeric" value="1024"></label>
          <button type="submit">Preview</button>
        </form>
        <div id="preview-output" class="output" aria-live="polite">No preview requested</div>
      </section>
      <section class="panel" id="resize-rules">
        <h2>Image resize rules</h2>
        <p><span class="chip warning">Preview only</span> Resize rules are configured for preview, not executing.</p>
      </section>
    </main>
  </div>
  <script src="/admin/storage/admin.js" type="module"></script>
</body>
</html>`;
```

Add CSS using only tokens from `DESIGN.md`; add JavaScript that calls `/admin/storage/api/providers` and `/admin/storage/api/preview-route` with existing browser headers. The JavaScript must render placement cards with vault key, provider type, retention mode, required flag, and failure policy. It must not render raw errors; render safe diagnostic code only.

- [ ] **Step 5: Compose UI route before admin API and runtime fallback**

In `src/runtime-local-composition.ts`, compose in this order:

```typescript
const runtime = composeStorageRuntimeRoutes(
  createStorageVaultAdminUiRuntime(),
  composeStorageRuntimeRoutes(adminRuntime, composeStorageRuntimeRoutes(writeRuntime, readRuntime)),
);
```

- [ ] **Step 6: Add admin UI smoke script**

Create `scripts/admin-ui-smoke.mjs`:

```javascript
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createNodeHttpHandler } from '../dist/node-http-adapter.js';
import { createVideoMakerRuntimeComposition } from '../dist/runtime-local-composition.js';

const prohibited = [
  'secret',
  'credential',
  'endpoint',
  'signed_url',
  'object_key',
  'bearer',
  'prompt',
  'user_name',
  'project_title',
  'scene_title',
];

const composition = createVideoMakerRuntimeComposition(process.env);
const server = createServer(createNodeHttpHandler(composition.runtime));

try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('admin-ui-smoke-address-unavailable');
  }
  const origin = `http://127.0.0.1:${address.port}`;
  for (const path of ['/admin/storage', '/admin/storage/admin.css', '/admin/storage/admin.js']) {
    const response = await fetch(`${origin}${path}`);
    if (response.status !== 200) {
      throw new Error(`admin-ui-smoke-status-${response.status}-${path}`);
    }
    const text = await response.text();
    for (const term of prohibited) {
      if (text.toLowerCase().includes(term)) {
        throw new Error(`admin-ui-smoke-private-term-${term}-${path}`);
      }
    }
  }
  console.log('admin UI smoke: passed');
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve(undefined);
      else reject(error);
    });
  });
  await composition.close();
}
```

- [ ] **Step 7: Run Task 5 verification**

Run:

```bash
npm run test:compile && node --test .test-dist/tests/storage-vault-admin-ui.test.js
npm run typecheck
npm run smoke:admin-ui
```

Expected: UI tests pass, typecheck exits 0, and smoke script prints `admin UI smoke: passed`.

- [ ] **Step 8: Browser manual QA for UI surface**

Use the Playwright skill after implementation. Start the local runtime, open `/admin/storage`, verify keyboard focus reaches each nav link and form field, submit a preview request, and capture evidence that the resize section says “Preview only” and “configured for preview, not executing.”

- [ ] **Step 9: Commit Task 5**

```bash
git add DESIGN.md src/storage-vault-admin-ui.ts src/runtime-local-composition.ts tests/storage-vault-admin-ui.test.ts scripts/admin-ui-smoke.mjs package.json
git commit -m "feat: add internal vault admin UI"
```

---

### Task 6: Vault-aware write intent planning and registry persistence

**Files:**
- Modify: `src/runtime-storage-registry-types.ts`
- Modify: `src/runtime-storage-registry-object.ts`
- Modify: `src/runtime-storage-registry.ts`
- Modify: `src/runtime-ingest.ts`
- Create: `src/storage-vault-runtime.ts`
- Test: `tests/storage-vault-runtime.integration.test.ts`

- [ ] **Step 1: Write failing N-placement registry test**

Create `tests/storage-vault-runtime.integration.test.ts` by reusing the migration reset helpers from `runtime-storage-registry.integration.test.ts`. The central assertion must be:

```typescript
integrationTest('vault route plan creates one storage object with three planned copies', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    await resetDatabaseThrough0004(pool);
    await seedVaultControlPlane(pool);
    const registry = new PostgresRuntimeStorageRegistry({
      pool: adaptPool(pool),
      duplicateResultCodec: codec,
      now: () => new Date('2026-07-30T00:00:00.000Z'),
    });

    const created = await registry.createObjectWriteIntent({
      managedAppId: IDS.managedApp,
      callerServiceId: 'api',
      storageProfileId: IDS.profile,
      storageProfileFingerprint: 'profile-fingerprint-vault-v1',
      storagePrefixClassId: IDS.prefixClass,
      hotProviderBindingId: IDS.hotBinding,
      canonicalProviderBindingId: IDS.canonicalBinding,
      appCorrelationReference: 'asset-001',
      sourceReference: 'source-asset-001',
      expectedContentType: 'image/png',
      expectedByteLength: 1024,
      expectedChecksumSha256: 'a'.repeat(64),
      expiresAt: new Date('2026-07-30T00:15:00.000Z'),
      internalLocators: {
        hot: 'video-maker/hot/asset-001',
        canonical: 'video-maker/raw/asset-001',
      },
      assetClassId: IDS.rawImageAssetClass,
      vaultPlacements: Object.freeze([
        Object.freeze({
          storageVaultId: IDS.rawPermanentVault,
          storageProfileVaultBindingId: IDS.rawPermanentBinding,
          storageRouteRuleId: IDS.rawPermanentRoute,
          placementIntent: 'primary',
          providerRole: 'canonical',
          providerBindingId: IDS.canonicalBinding,
          internalLocator: 'video-maker/raw/asset-001',
        }),
        Object.freeze({
          storageVaultId: IDS.rawHotVault,
          storageProfileVaultBindingId: IDS.rawHotBinding,
          storageRouteRuleId: IDS.rawHotRoute,
          placementIntent: 'cache',
          providerRole: 'hot',
          providerBindingId: IDS.hotBinding,
          internalLocator: 'video-maker/hot/asset-001',
        }),
        Object.freeze({
          storageVaultId: IDS.rawArchiveVault,
          storageProfileVaultBindingId: IDS.rawArchiveBinding,
          storageRouteRuleId: IDS.rawArchiveRoute,
          placementIntent: 'archive',
          providerRole: 'canonical',
          providerBindingId: IDS.archiveBinding,
          internalLocator: 'video-maker/archive/asset-001',
        }),
      ]),
      safeTechnicalMetadata: { media_family: 'image' },
    });

    const copies = await pool.query<{ storage_vault_id: string; placement_intent: string }>(
      `SELECT storage_vault_id::text, placement_intent
         FROM public.storage_object_copies
        WHERE storage_object_id = $1
        ORDER BY placement_intent`,
      [created.object.storageObjectId],
    );
    assert.equal(copies.rows.length, 3);
    assert.deepEqual(copies.rows.map((row) => row.placement_intent), ['archive', 'cache', 'primary']);
  } finally {
    await pool.end();
  }
});
```

- [ ] **Step 2: Run registry test to verify RED**

Run: `npm run test:compile && node --test .test-dist/tests/storage-vault-runtime.integration.test.js`

Expected: FAIL because `CreateObjectWriteIntentInput` does not accept `assetClassId` or `vaultPlacements`.

- [ ] **Step 3: Extend registry input/output types**

Modify `src/runtime-storage-registry-types.ts`:

```typescript
export interface VaultCopyPlacementInput {
  readonly storageVaultId: string;
  readonly storageProfileVaultBindingId: string;
  readonly storageRouteRuleId: string;
  readonly placementIntent: 'primary' | 'additional' | 'cache' | 'archive';
  readonly providerRole: ProviderRole;
  readonly providerBindingId: string;
  readonly internalLocator: string;
}

export interface CreateObjectWriteIntentInput {
  readonly assetClassId?: string;
  readonly sourceStorageObjectId?: string;
  readonly originKind?: 'upload' | 'derivative' | 'external-import' | 'system-generated';
  readonly vaultPlacements?: readonly Readonly<VaultCopyPlacementInput>[];
}
```

Merge these fields into the existing interface; do not duplicate the interface. Keep legacy `hotProviderBindingId`, `canonicalProviderBindingId`, and `internalLocators` for compatibility.

- [ ] **Step 4: Persist vault-aware object and copy rows**

Modify `src/runtime-storage-registry-object.ts` in `createObjectWriteIntent()`:

- Insert `asset_class_id`, `source_storage_object_id`, and `origin_kind` into `storage_objects`.
- If `input.vaultPlacements` is present and non-empty, insert one `storage_object_copies` row per placement using `storage_vault_id`, `storage_profile_vault_binding_id`, `storage_route_rule_id`, and `placement_intent`.
- If `input.vaultPlacements` is absent, keep the existing two-copy hot/canonical insert path unchanged.
- Validate every vault placement internal locator with the same locator rules used by the legacy path.

Use this branch shape:

```typescript
const vaultPlacements = input.vaultPlacements ?? [];
if (vaultPlacements.length > 0) {
  for (const placement of vaultPlacements) {
    await client.query(
      `INSERT INTO public.storage_object_copies (
         storage_object_copy_id, storage_object_id,
         storage_profile_provider_binding_id, provider_role, internal_locator,
         storage_vault_id, storage_profile_vault_binding_id, storage_route_rule_id,
         placement_intent, copy_state, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $10)`,
      [
        this.createId(),
        storageObjectId,
        placement.providerBindingId,
        placement.providerRole,
        placement.internalLocator,
        placement.storageVaultId,
        placement.storageProfileVaultBindingId,
        placement.storageRouteRuleId,
        placement.placementIntent,
        now,
      ],
    );
  }
} else {
  // existing hot/canonical insert loop remains here
}
```

- [ ] **Step 5: Add runtime placement conversion helper**

Create `src/storage-vault-runtime.ts` with a pure helper that converts `StorageRoutePlan` placements to `VaultCopyPlacementInput` using a locator factory. Keep it DB-free.

```typescript
import type { ProviderRole, VaultCopyPlacementInput } from './runtime-storage-registry-types.js';
import type { StorageRoutePlan } from './storage-vault-types.js';

export class StorageVaultRuntimeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'StorageVaultRuntimeError';
    this.code = code;
  }
}

export interface VaultLocatorFactory {
  create(input: Readonly<{ vaultKey: string; basePrefixPattern: string; sourceReference: string }>): string;
}

function roleForPlacement(input: Readonly<{ vaultKind: string; placementIntent: string }>): ProviderRole {
  if (input.vaultKind === 'hot' || input.vaultKind === 'temporary' || input.placementIntent === 'cache') {
    return 'hot';
  }
  return 'canonical';
}

function requireProviderBinding(
  bindings: ReadonlyMap<string, string>,
  vaultBindingId: string,
): string {
  const providerBindingId = bindings.get(vaultBindingId);
  if (providerBindingId === undefined) {
    throw new StorageVaultRuntimeError('vault-provider-binding-missing');
  }
  return providerBindingId;
}

export function createVaultCopyPlacements(input: Readonly<{
  plan: Readonly<StorageRoutePlan>;
  sourceReference: string;
  providerBindingByVaultBindingId: ReadonlyMap<string, string>;
  locatorFactory: VaultLocatorFactory;
}>): readonly Readonly<VaultCopyPlacementInput>[] {
  return Object.freeze(input.plan.placements.map((placement) => Object.freeze({
    storageVaultId: placement.vaultId,
    storageProfileVaultBindingId: placement.vaultBindingId,
    storageRouteRuleId: placement.routeRuleId,
    placementIntent: placement.placementIntent,
    providerRole: roleForPlacement({ vaultKind: placement.vaultKind, placementIntent: placement.placementIntent }),
    providerBindingId: requireProviderBinding(input.providerBindingByVaultBindingId, placement.vaultBindingId),
    internalLocator: input.locatorFactory.create({
      vaultKey: placement.vaultKey,
      basePrefixPattern: placement.basePrefixPattern,
      sourceReference: input.sourceReference,
    }),
  })));
}
```

Add a unit test in `tests/storage-vault-route-planner.test.ts` that calls `createVaultCopyPlacements()` with an empty `providerBindingByVaultBindingId` map and asserts `StorageVaultRuntimeError.code === 'vault-provider-binding-missing'`.

- [ ] **Step 6: Wire ingest to pass vault placements**

Modify `src/runtime-ingest.ts` so `ResolvedObjectWriteAuthority` can optionally include:

```typescript
readonly routePlan?: Readonly<StorageRoutePlan>;
readonly providerBindingByVaultBindingId?: ReadonlyMap<string, string>;
```

When present, call `createVaultCopyPlacements()` and pass `assetClassId` and `vaultPlacements` into `registry.createObjectWriteIntent()`.

- [ ] **Step 7: Run Task 6 verification**

Run:

```bash
npm run test:compile && node --test .test-dist/tests/storage-vault-runtime.integration.test.js
npm run test:registry
npm run typecheck
```

Expected: the new N-placement test passes; existing registry tests still pass; typecheck exits 0.

- [ ] **Step 8: Commit Task 6**

```bash
git add src/runtime-storage-registry-types.ts src/runtime-storage-registry-object.ts src/runtime-storage-registry.ts src/runtime-ingest.ts src/storage-vault-runtime.ts tests/storage-vault-runtime.integration.test.ts
git commit -m "feat: persist vault planned copies"
```

---

### Task 7: Runtime composition resolves route rules instead of fixed Video Maker authority

**Files:**
- Modify: `src/runtime-local-composition.ts`
- Modify: `src/storage-vault-control-plane.ts`
- Test: `tests/runtime-main.test.ts`
- Test: `tests/storage-vault-runtime.integration.test.ts`

- [ ] **Step 1: Write failing composition readiness test**

Add a test that seeds Video Maker-style vault rules and asserts local readiness returns ready without requiring exactly one hot and one canonical provider binding. The assertion must check readiness body status:

```typescript
assert.equal(readiness.status, 200);
assert.equal((await readiness.json()).status, 'ready');
```

Then seed an optional hot vault backed by MinIO instead of R2 and assert readiness still passes.

- [ ] **Step 2: Run composition test to verify RED**

Run: `npm run test:compile && node --test .test-dist/tests/runtime-main.test.js .test-dist/tests/storage-vault-runtime.integration.test.js`

Expected: FAIL with existing `provider-authority-mismatch` or `storage-authority-incomplete` because `runtime-local-composition.ts` still expects fixed aliases.

- [ ] **Step 3: Add repository method to resolve runtime route authority**

In `src/storage-vault-control-plane.ts`, add:

```typescript
async resolveRuntimeRoutePlan(input: Readonly<{
  storageProfileId: string;
  assetClassKey: string;
  mediaType: string;
  byteLength: number;
}>): Promise<Readonly<{
  plan: StorageRoutePlan;
  providerBindingByVaultBindingId: ReadonlyMap<string, string>;
}>>
```

This method may use legacy `storage_profile_provider_bindings` as provider-binding compatibility rows, but the returned plan must be driven by `storage_route_rules` and `storage_profile_vault_bindings`.

- [ ] **Step 4: Replace hardcoded authority validation with vault route validation**

In `src/runtime-local-composition.ts`:

- Keep `VIDEO_MAKER_APP`, `CALLER_SERVICE`, profile alias, and prefix alias for development default auth.
- Remove the requirement that provider IDs equal `r2_video_maker_dev_01` and `minio_zimspace_local_pc_01`.
- Validate at least one active route plan has a durable required placement.
- Validate credential resolver has labels for every provider used by the plan.
- Preserve existing readiness error codes where possible; use `storage-route-plan-not-ready` for planner failures.

- [ ] **Step 5: Run Task 7 verification**

Run:

```bash
npm run test:compile && node --test .test-dist/tests/runtime-main.test.js .test-dist/tests/storage-vault-runtime.integration.test.js
npm run local:readiness
```

Expected: tests pass. `local:readiness` exits 0 only when local required env is configured; otherwise record the existing not-ready code and continue to full test verification.

- [ ] **Step 6: Commit Task 7**

```bash
git add src/runtime-local-composition.ts src/storage-vault-control-plane.ts tests/runtime-main.test.ts tests/storage-vault-runtime.integration.test.ts
git commit -m "feat: resolve runtime writes from vault routes"
```

---

### Task 8: Vault-priority read delivery

**Files:**
- Modify: `src/runtime-read-grant.ts`
- Modify: `src/runtime-read-delivery.ts`
- Modify: `src/storage-vault-runtime.ts`
- Test: `tests/storage-vault-read-delivery.test.ts`
- Test: `tests/runtime-read-delivery.test.ts`

- [ ] **Step 1: Write failing read-priority tests**

Create `tests/storage-vault-read-delivery.test.ts`:

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { selectVaultReadCopy } from '../src/storage-vault-runtime.js';

test('selects verified copy with lowest vault read priority before legacy canonical fallback', () => {
  const selected = selectVaultReadCopy(Object.freeze([
    Object.freeze({ storageObjectCopyId: 'canonical-copy', state: 'verified', readPriority: 20, observedChecksumSha256: 'a'.repeat(64), observedByteLength: 100 }),
    Object.freeze({ storageObjectCopyId: 'hot-copy', state: 'verified', readPriority: 10, observedChecksumSha256: 'a'.repeat(64), observedByteLength: 100 }),
  ]), 'a'.repeat(64), 100);

  assert.equal(selected.storageObjectCopyId, 'hot-copy');
});

test('skips unverified high-priority copy and selects verified durable copy', () => {
  const selected = selectVaultReadCopy(Object.freeze([
    Object.freeze({ storageObjectCopyId: 'hot-copy', state: 'failed', readPriority: 10, observedChecksumSha256: 'a'.repeat(64), observedByteLength: 100 }),
    Object.freeze({ storageObjectCopyId: 'canonical-copy', state: 'verified', readPriority: 20, observedChecksumSha256: 'a'.repeat(64), observedByteLength: 100 }),
  ]), 'a'.repeat(64), 100);

  assert.equal(selected.storageObjectCopyId, 'canonical-copy');
});
```

- [ ] **Step 2: Run read tests to verify RED**

Run: `npm run test:compile && node --test .test-dist/tests/storage-vault-read-delivery.test.js`

Expected: FAIL because `selectVaultReadCopy` is not exported.

- [ ] **Step 3: Add pure read selection helper**

In `src/storage-vault-runtime.ts`, add:

```typescript
export interface VaultReadCopyCandidate {
  readonly storageObjectCopyId: string;
  readonly state: 'pending' | 'verified' | 'failed' | 'missing' | 'delete_pending' | 'deleted';
  readonly readPriority?: number;
  readonly observedChecksumSha256?: string;
  readonly observedByteLength?: number;
}

export class VaultReadSelectionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'VaultReadSelectionError';
    this.code = code;
  }
}

export function selectVaultReadCopy(
  candidates: readonly Readonly<VaultReadCopyCandidate>[],
  checksumSha256: string,
  byteLength: number,
): Readonly<VaultReadCopyCandidate> {
  const selected = [...candidates]
    .filter((candidate) =>
      candidate.state === 'verified' &&
      candidate.observedChecksumSha256 === checksumSha256 &&
      candidate.observedByteLength === byteLength,
    )
    .sort((left, right) => (left.readPriority ?? 1_000_000) - (right.readPriority ?? 1_000_000))[0];
  if (selected === undefined) {
    throw new VaultReadSelectionError('object-content-unavailable');
  }
  return selected;
}
```

The read-delivery coordinator must translate `VaultReadSelectionError('object-content-unavailable')` to the existing `ObjectReadDeliveryError` with category `dependency-unavailable`, code `object-content-unavailable`, status `503`, and `retryable = true`.

- [ ] **Step 4: Query vault-aware snapshots in read grant registry**

Modify `src/runtime-read-grant.ts` snapshot query to select all verified/pending copy candidates with:

- `storage_object_copies.storage_vault_id`
- `storage_profile_vault_bindings.read_priority`
- `storage_vaults.vault_key`
- provider target from vault/provider rows

Keep the existing hot/canonical shape for old object rows with `storage_vault_id IS NULL`.

- [ ] **Step 5: Delegate selection in read delivery coordinator**

Modify `src/runtime-read-delivery.ts` only enough to call the new selector when a snapshot contains vault copy candidates. Preserve existing delivery states for legacy responses:

- vault hot/cache selected -> `x-zs-delivery-state: hot`
- vault canonical/derivative/archive selected -> `x-zs-delivery-state: canonical-fallback`

- [ ] **Step 6: Run Task 8 verification**

Run:

```bash
npm run test:compile && node --test .test-dist/tests/storage-vault-read-delivery.test.js .test-dist/tests/runtime-read-delivery.test.js .test-dist/tests/runtime-read-grant.test.js
npm run typecheck
```

Expected: new and existing read tests pass; typecheck exits 0.

- [ ] **Step 7: Commit Task 8**

```bash
git add src/runtime-read-grant.ts src/runtime-read-delivery.ts src/storage-vault-runtime.ts tests/storage-vault-read-delivery.test.ts tests/runtime-read-delivery.test.ts
git commit -m "feat: read objects by vault priority"
```

---

### Task 9: Documentation, full verification, and manual QA

**Files:**
- Modify: `README.md`
- Modify: `docs/runtime-contract.md`
- Modify: `package.json`
- Read/update if live schema is applied by explicit instruction only: `z-kn/06-db-schema/project/z-s/main.md`
- Create if live schema is applied by explicit instruction only: `z-kn-bk/06-db-schema/project/z-s/<date>-storage-vault-routing.md`

- [ ] **Step 1: Document the admin/control-plane surface**

In `README.md`, add a section named `Storage vault routing admin surface`:

```markdown
## Storage vault routing admin surface

The internal Z-s admin UI is served at `/admin/storage`. It configures provider identities, vaults, asset classes, route rules, image-resize preview rules, and route previews. It never stores or returns provider credentials, endpoints, signed URLs, bearer tokens, object keys, internal locators, prompts, user names, project titles, or scene titles.

Admin API routes live under `/admin/storage/api/*` and require the same server-side Z-s bearer authorization used by the local runtime. The browser talks only to Z-s admin APIs; it never calls provider APIs.

Image resize rules in this release are preview-only. They validate image-only source asset classes and destination vault placement, but they do not execute processing jobs.
```

- [ ] **Step 2: Document runtime contract compatibility**

In `docs/runtime-contract.md`, add:

```markdown
### Vault-aware placement compatibility

Runtime contract `1.0` keeps the existing upload and read response shapes. New vault route plans persist `storage_object_copies` rows with vault binding metadata, while legacy `hot` and `canonical` copy fields remain available for existing clients. Breaking removals or renames still require a new major contract version.
```

- [ ] **Step 3: Run focused verification**

Run:

```bash
npm run test:vault
npm run test:registry
npm run test:focused
npm run validate:migration
npm run typecheck
npm run lint
npm run build
npm run smoke:admin-ui
```

Expected: every command exits 0. If `TEST_DATABASE_URL` is absent, integration tests report skipped; run them again with `TEST_DATABASE_URL` before claiming the implementation is complete.

- [ ] **Step 4: Run full package verification**

Run:

```bash
npm run validate
```

Expected: exits 0. If `local:readiness` fails because local secrets/provider credentials are not configured, record the exact readiness code and run the manual QA against a configured local env before claiming runtime readiness.

- [ ] **Step 5: Manual QA through the actual surfaces**

Use the actual HTTP/UI surfaces:

```bash
npm run local:start
```

Then:

1. Open `http://127.0.0.1:<port>/admin/storage` in Playwright.
2. Confirm the page title is `Storage vault routing`.
3. Create or seed the Video Maker example provider/vault/asset/route/derivative setup using the admin API.
4. In the UI preview form, submit `raw-production-image`, `image/png`, and `1024` bytes.
5. Confirm the preview shows raw MinIO permanent required placement, optional provider-neutral 7-day hot placement, and image resize derivative to a permanent R2 vault.
6. Submit a derivative rule for `raw-production-video` and confirm API/UI rejection code `image-derivative-source-required`.
7. Call `/admin/storage/api/preview-route` with curl and confirm the response text does not contain `secret`, `credential`, `endpoint`, `signed_url`, `object_key`, `locator`, `bearer`, `prompt`, `user_name`, `project_title`, or `scene_title`.

- [ ] **Step 6: Live schema documentation gate**

Only if the user explicitly asks to apply migration `0004` to live DB in a separate governed step:

1. Apply the migration through the authorized `z-s_app` DB env.
2. Update `z-kn/06-db-schema/project/z-s/main.md` with the new table/column current state.
3. Create immutable history under `z-kn-bk/06-db-schema/project/z-s/`.
4. Do not copy row data, credentials, URLs, tokens, env paths, or secret labels into those docs.

- [ ] **Step 7: Commit Task 9**

```bash
git add README.md docs/runtime-contract.md package.json
git commit -m "docs: document vault routing admin surface"
```

---

## Dependency order

1. Task 1 must finish before repository/runtime integration tests use migration `0004`.
2. Task 2 must finish before preview API, runtime write planning, and UI preview.
3. Task 3 must finish before Task 4 admin API and Task 7 runtime composition.
4. Task 4 must finish before Task 5 UI can call real APIs.
5. Task 6 must finish before Task 7 can write vault planned copies at runtime.
6. Task 8 can start after Task 6 persisted vault copy metadata.
7. Task 9 runs after all implementation tasks pass.

## Must-not-have checklist for reviewers

- No `as any`, `as unknown`, non-null assertions, `@ts-ignore`, or `@ts-expect-error`.
- No new provider credential, endpoint, signed URL, bearer token, object key, internal locator, prompt, user name, project title, or scene title fields.
- No React/Tailwind dependency for this UI slice.
- No actual image resize execution, job queue, image processor dependency, or provider browser access.
- No broad vault scanning or documentation scrape outside the scoped files named in this plan.
- No substantial logic added to existing oversized files; use focused new files and delegate.

## Final verification bundle

Run these before reporting completion:

```bash
npm run test:vault
npm run test:focused
npm test
npm run test:registry
npm run validate:migration
npm run validate:seed
npm run validate:secrets
npm run validate:legacy-id
npm run typecheck
npm run lint
npm run build
npm run pack:check
npm run smoke:admin-ui
```

Then run browser/UI manual QA with Playwright and API manual QA with curl as described in Task 9.
