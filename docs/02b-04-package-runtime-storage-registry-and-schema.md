# 2B-04 coding handoff: runtime storage registry and schema

## Exact authority

```yaml
repository: https://github.com/ZimmonAI/z-s_app
baseline_commit: b04677280a77a338aa41d9a6994140e7d4918e2f
implementation_branch: agent/02b-04-runtime-storage-registry
package: '@zimspace/z-s-control-plane@0.2.0'
contract: '1.0'
node_runtime: '>=22'
source_actions: authorized-by-2B-04-coding-request
live_database_actions: none
provider_actions: none
browser_actions: none
deployment_actions: none
```

This handoff implements source artifacts only. It creates no database connection outside isolated tests, applies no live migration, performs no provider operation, and does not mutate Video Maker or Z-X source/schema.

## Reviewed table split

The preferred seven-table split is accepted without deviation:

- `object_write_intents`
- `storage_objects`
- `storage_object_copies`
- `storage_provider_attempts`
- `storage_operation_events`
- `storage_reconciliation_issues`
- `storage_idempotency_records`

The existing seven control-plane tables remain unchanged. Runtime identity is application-generated UUID. Current copy truth is separate from append-only provider-attempt history. Internal locators remain private to the Z-s repository boundary.

## Exact allowed files

Only these paths belong to this coding handoff:

- `.github/workflows/2b-04-runtime-storage-registry-validation.yml`
- `db/migrations/0002_z_s_runtime_registry.sql`
- `db/migrations/0002_z_s_runtime_registry.down.sql`
- `docs/02b-04-package-runtime-storage-registry-and-schema.md`
- `docs/runtime-storage-registry.md`
- `package.json`
- `scripts/install-smoke.mjs`
- `scripts/validate-migration.mjs`
- `src/index.ts`
- `src/runtime-storage-registry-duplicate.ts`
- `src/runtime-storage-registry-object.ts`
- `src/runtime-storage-registry-support.ts`
- `src/runtime-storage-registry-types.ts`
- `src/runtime-storage-registry.ts`
- `tests/runtime-storage-registry.integration.test.ts`

No `0001` rewrite, seed, provider adapter, environment value, deployment artifact, browser code, Video Maker field, Z-X field, provider endpoint, credential, signed URL, raw object key, raw bearer value, or upload-completion value is allowed.

## Repository boundary

`PostgresRuntimeStorageRegistry` uses an injected PostgreSQL-compatible pool and injected time/ID/result-codec functions. It implements the existing `DuplicateProtectionStore` interface and shares an `AsyncLocalStorage` transaction scope with repository methods, so duplicate reservation, object allocation, intent creation, and hot/canonical copy creation commit atomically.

Implemented responsibilities:

- execute durable duplicate protection using stable result references rather than stored response payloads;
- create one object-write-intent, storage-object and expected hot/canonical copy set atomically;
- read and compare-and-set object-write-intent state;
- read an internally consistent storage-object snapshot with independent copy states;
- compare-and-set copy state;
- append, claim and finish provider-attempt rows without provider I/O;
- append safe deduplicated storage-event rows;
- open/touch, claim and resolve reconciliation-issue rows;
- recover stale idempotency, provider-attempt and reconciliation leases deterministically.

The durable duplicate result codec rehydrates a stable result from UUID references. It does not store full contract responses, credentials, provider locators, private error bodies, or upload-completion values.

## Migration artifacts

Forward:

```text
db/migrations/0002_z_s_runtime_registry.sql
```

Isolated-test reverse:

```text
db/migrations/0002_z_s_runtime_registry.down.sql
```

The forward migration:

- verifies all seven baseline table targets;
- deterministically rejects reapplication;
- sets bounded lock and statement timeouts;
- creates seven additive tables, constraints, indexes, comments and append-only triggers;
- adds no PostgreSQL extension, seed or backfill;
- leaves zero runtime rows after schema application.

The reverse migration refuses to drop any runtime table containing adopted rows. It is for isolated tests and separately approved live rollback only.

## Validation

Full source validation:

```bash
npm install --ignore-scripts
npm run validate
```

Real PostgreSQL registry validation:

```bash
$TEST_DATABASE_URL npm run test:registry
```

The GitHub workflow supplies an isolated PostgreSQL service and runs both commands. Coverage includes migration up/down/reapply, catalog comments/table count, 20-call concurrency, conflicting duplicate keys, atomic row counts, independent hot/canonical truth, append-only attempts/events, exclusive attempt/issue leases, event safety and dedupe.

## Source rollback

Before merge, close the pull request and delete `agent/02b-04-runtime-storage-registry`. After merge, revert the implementation merge commit. Live schema rollback is not part of this handoff and must use the separately reviewed live DB procedure with the exact merged migration checksum and zero adopted rows/dependencies.

## Report and handback

This document is the coding report path. A merged coding PR moves 2B-04 only to `in-progress-live-db-blocked`; it does not mark 2B-04 complete or unblock 2B-05 until the separate live DB application, catalog verification, current/history schema synchronization and shared execution-map completion pass are done.
