# Z-s Storage Vault Routing and Image Resize Design

## Status

Draft for user review. No runtime code, migration, or live database schema has been changed by this document.

## Context read

- Governance entry: `z-kn/vault-rule.md`.
- Z-s common guide: `z-kn/07-resources/technology/z-s-storage-service/z-s-storage-service-integration-guide.md`.
- Object-storage governance: core boundary, provider model, naming/IAM, registry fields, retention/recovery rules.
- Z-s operations registry: `z-kn/05-operations/brand/z-s/storage/app-storage-assignment-registry.md`.
- Current schema registry: `z-kn/06-db-schema/project/z-s/main.md`.
- Current source map: `z-kn/02-sources/apps/codebases/z-s_app_codebase.md`.
- Source inspected: `D:/zimspace/apps/z-s_app` migrations and runtime registry/composition modules.
- Live schema checked read-only through the authorized `z-s_app` DB scoped env: current live database has 15 public tables and table comments present.

## Problem

Z-s currently supports app/environment profiles, providers, prefix classes, write intents, storage objects, two object copies (`hot`, `canonical`), and read grants. The runtime is still shaped around Video Maker defaults in `runtime-local-composition.ts`, and the schema assumes one hot copy plus one canonical copy per object.

The requested model needs a client-configurable control plane where a client can:

1. create named storage destinations, called **vaults** in this design;
2. choose provider type such as R2 or MinIO;
3. bind a non-secret provider credential reference and bucket/prefix identity, with secret values stored only in the authorized secret source;
4. assign retention behavior such as permanent or temporary 7 days;
5. route one asset class to one vault or many vaults;
6. store one asset to one vault or many vaults without making provider-specific behavior visible to the client;
7. create image resize derivatives only for image inputs;
8. choose whether each derivative stores in the same vault or another explicit vault;
9. manage these rules from a client-facing web UI.

The motivating Video Maker shape is:

- raw production uploads: video/image/docs to MinIO permanently;
- raw production additional placement: same uploads to an optional temporary hot vault for 7 days, backed by R2, MinIO, or another approved provider;
- production images: resized derivatives stored in another permanent R2 vault.

## Design decision

Use **vault** as the client-facing unit. A vault is a named destination and policy boundary. Internally it binds to one provider, bucket, prefix, retention policy, access class, and lifecycle rule set. Credential values stay outside the database; a vault reaches credentials only through the linked provider's non-secret `secret_reference_id`.

This is better than exposing provider bindings as the main UI concept because clients think in destinations and policies, not storage profile internals. Z-s can still keep provider-neutral storage truth and secret separation behind the vault abstraction.

## Approaches considered

### A. Extend current hot/canonical roles only

Keep `storage_profile_provider_bindings.provider_role IN ('hot', 'canonical')` and add fields for retention and resize.

Tradeoffs:

- Smallest schema change.
- Does not support many vaults per object cleanly.
- Cannot represent raw MinIO permanent plus R2 hot plus derivative R2 permanent without overloading `hot` and `canonical`.
- Keeps runtime logic coupled to a two-copy object model.

Rejected because it would hardcode the exact pattern the user wants to make dynamic.

### B. Add generic vaults and route rules alongside current tables

Add vault, route, derivative, and object-copy extensions while retaining existing tables for backward compatibility. Current `hot` and `canonical` become role tags on vault routes, not the only storage shape.

Tradeoffs:

- Incremental and migration-friendly.
- Keeps current write/read contracts working while adding a flexible control plane.
- Requires runtime refactor from two fixed copies to a planned copy set.
- Requires an admin UI and new API surface.

Recommended.

### C. Replace the current storage model with a generic workflow engine

Build a full routing/workflow graph for uploads, transforms, lifecycle, and provider operations.

Tradeoffs:

- Maximum flexibility.
- Higher implementation risk and more schema surface.
- Too broad for the current Z-s state and would delay the concrete storage UI.

Rejected for now. The route-rule model can later evolve toward workflows if needed.

## Proposed schema model

### Existing tables retained

- `managed_apps`
- `storage_providers`
- `storage_profiles`
- `storage_prefix_classes`
- `storage_capability_results`
- `storage_profile_audit_events`
- `storage_objects`
- `object_write_intents`
- `storage_object_copies`
- `storage_provider_attempts`
- `storage_operation_events`
- `storage_reconciliation_issues`
- `storage_idempotency_records`
- `object_read_grants`

### New control-plane tables

#### `storage_vaults`

Client-facing storage destination.

Key columns:

- `id uuid primary key`
- `managed_app_id uuid not null references managed_apps(id)`
- `vault_key text not null`
- `display_name text not null`
- `storage_provider_id uuid not null references storage_providers(id)`
- `bucket_label text not null`
- `base_prefix_pattern text not null`
- `vault_kind text not null` with values such as `canonical`, `hot`, `derivative`, `archive`, `temporary`
- `retention_policy_id text not null`
- `retention_mode text not null` with values `permanent`, `ttl`, `until-app-delete`, `legal-hold`
- `ttl_seconds integer null`
- `access_mode text not null` with values `private`, `signed-read`, `public-approved`
- `status text not null` with values `draft`, `active`, `disabled`
- timestamps and row version

Constraints:

- unique `(managed_app_id, vault_key)`;
- R2/MinIO credentials are never stored here, only the provider's existing `secret_reference_id` remains in `storage_providers`;
- `bucket_label` is lowercase, contains no whitespace, and is non-secret;
- `base_prefix_pattern` must be normalized, must not start with `/`, and must not contain `..`, backslashes, or URLs;
- if `retention_mode = 'ttl'`, `ttl_seconds` is required and positive;
- if `retention_mode = 'permanent'`, `ttl_seconds` is null.

#### `storage_profile_vault_bindings`

Connects a storage profile version to the vaults available to that profile.

Key columns:

- `id uuid primary key`
- `storage_profile_id uuid not null references storage_profiles(id)`
- `storage_vault_id uuid not null references storage_vaults(id)`
- `storage_prefix_class_id uuid not null references storage_prefix_classes(id)`
- `binding_key text not null`
- `required boolean not null default true`
- `write_order integer not null`
- `read_priority integer null`
- `status text not null`

This supersedes but does not immediately delete `storage_profile_provider_bindings`. The existing hot/canonical bindings can be bridged into vault bindings during migration. The prefix-class link is the capability-evidence bridge: readiness for a vault is proved by `storage_capability_results` for the vault provider, bucket label, and this exact prefix class.

Constraints:

- the profile, vault, and prefix class must belong to the same managed app/profile scope;
- unique `(storage_profile_id, binding_key)`;
- unique `(storage_profile_id, storage_vault_id, storage_prefix_class_id)`.

#### `storage_asset_classes`

Defines which asset classes a client can route.

Key columns:

- `id uuid primary key`
- `managed_app_id uuid not null references managed_apps(id)`
- `asset_class_key text not null`
- `display_name text not null`
- `media_family text not null` with values `image`, `video`, `document`, `binary`, `any`
- `allowed_mime_types text[] not null`
- `max_byte_length bigint null`
- `status text not null`

Examples: `raw-production-image`, `raw-production-video`, `raw-production-document`, `production-image-resize`.

#### `storage_route_rules`

Declares which vault placements an original upload should receive.

Key columns:

- `id uuid primary key`
- `storage_profile_id uuid not null references storage_profiles(id)`
- `asset_class_id uuid not null references storage_asset_classes(id)`
- `route_key text not null`
- `operation_class text not null`
- `destination_vault_binding_id uuid not null references storage_profile_vault_bindings(id)`
- `placement_intent text not null` with values `primary`, `additional`, `cache`, `archive`
- `required boolean not null`
- `failure_policy text not null` with values `fail-write`, `allow-degraded`, `retry-background`
- `status text not null`

An upload can match multiple active route rules, creating multiple object placements. This directly models one asset stored in one vault or many vaults.

Constraints:

- destination vault binding must belong to the same `storage_profile_id` as the route rule;
- asset class must belong to the same managed app as the route rule's profile.

#### `storage_derivative_rules`

Defines generated objects such as image resizes.

Key columns:

- `id uuid primary key`
- `storage_profile_id uuid not null references storage_profiles(id)`
- `source_asset_class_id uuid not null references storage_asset_classes(id)`
- `derivative_asset_class_id uuid not null references storage_asset_classes(id)`
- `derivative_key text not null`
- `processor text not null` such as `image-resize`
- `processor_config jsonb not null`
- `destination_vault_binding_id uuid not null references storage_profile_vault_bindings(id)`
- `trigger_mode text not null` with values `on-upload-complete`, `manual`, `job`
- `required boolean not null default false`
- `status text not null`

Constraints:

- source asset class must have `media_family = 'image'` or `any` with MIME restricted to image types;
- `processor = 'image-resize'` requires image source and config containing bounded dimensions or named preset;
- source and derivative asset classes must belong to the same managed app as the profile;
- destination vault binding must belong to the same `storage_profile_id` as the derivative rule;
- derivative objects are new `storage_objects` rows with provenance back to the source object.

#### `storage_object_derivations`

Tracks source-to-derived object relationships.

Key columns:

- `id uuid primary key`
- `source_storage_object_id uuid not null references storage_objects(storage_object_id)`
- `derived_storage_object_id uuid not null references storage_objects(storage_object_id)`
- `derivative_rule_id uuid not null references storage_derivative_rules(id)`
- `state text not null` with values `planned`, `processing`, `completed`, `failed`, `cancelled`
- timestamps and safe diagnostic fields

### Existing table extensions

#### `storage_object_copies`

Add:

- `storage_vault_id uuid null references storage_vaults(id)`
- `storage_profile_vault_binding_id uuid null references storage_profile_vault_bindings(id)`
- `storage_route_rule_id uuid null references storage_route_rules(id)`
- `placement_intent text null`

Keep existing `storage_profile_provider_binding_id` and `provider_role` for backward compatibility, but new runtime paths should treat vault binding as the primary copy authority. Migration `0004` must relax the current two-copy shape by removing the unique `(storage_object_id, provider_role)` rule from the new path and adding a new planned-placement uniqueness rule such as `(storage_object_id, storage_route_rule_id, storage_vault_id)`.

#### `storage_objects`

Add:

- `asset_class_id uuid null references storage_asset_classes(id)`
- `source_storage_object_id uuid null references storage_objects(storage_object_id)`
- `origin_kind text not null default 'upload'` with values `upload`, `derivative`, `external-import`, `system-generated`

The current `safe_technical_metadata` remains for bounded non-secret technical summaries only.

## Runtime behavior

### Write planning

When an app requests a write intent, Z-s resolves:

1. authenticated managed app and profile version;
2. requested operation/media type to an asset class;
3. active route rules for that asset class;
4. destination vault bindings;
5. provider credentials through existing provider secret references;
6. capability evidence for each destination vault provider/bucket/prefix.

The write intent creates one `storage_objects` row and N `storage_object_copies` rows, where N is the matched route-rule count.

### Copy completion state

The runtime stops assuming exactly `hot` and `canonical`. It calculates object state from required route outcomes:

- all required copies verified: `active`;
- required permanent copy verified but optional/cache copy failed: `degraded`;
- no required copy verified: `reserved` or failed write state;
- temporary vault expiry cannot proceed if the required permanent vault is missing, failed, or under legal hold.

### Derivative creation

After an image upload reaches the trigger stage, active derivative rules can create processing jobs in a later execution slice. Each completed derivative becomes a new storage object and receives its own copy plan based on the derivative rule's destination vault.

The derivative is not a mutation of the source object. It is a new object with provenance:

- `storage_objects.source_storage_object_id = source`;
- `storage_object_derivations.source_storage_object_id = source`;
- `storage_object_derivations.derived_storage_object_id = derivative`.

### Read delivery

Read delivery should choose copies by vault read priority and verified availability, not by fixed hot-first/canonical-second assumptions. R2 hot can remain first where configured. Permanent R2 derivative vaults can be served as normal verified copies.

## Client web UI

The web UI is a Z-s admin/client-control surface, not direct browser access to providers.

Provider setup in the UI creates or updates the non-secret provider record and secret-reference label. If secret material must be entered by a human, that entry must write only to the authorized secret source or stop at a handoff boundary; the browser and API responses must not persist or echo secret values.

### Main sections

1. **Providers**
   - Register provider identity: R2, MinIO, or S3-compatible.
   - Store only non-secret provider ID, provider type, status, and secret reference label.
   - Show whether runtime has the credential reference bound, without showing values.

2. **Vaults**
   - Create named vaults: display name, provider, bucket label, prefix pattern, retention mode, TTL, access mode.
   - Examples: `Raw Production Permanent`, `Raw Hot 7 Days`, `Permanent Image Resizes`.

3. **Asset Classes**
   - Define media family and MIME policy.
   - Examples: raw image/video/document, generated image resize.

4. **Route Rules**
   - For each asset class, select one or many destination vaults.
   - Mark each destination as primary/additional/cache/archive, required or optional, and failure policy.

5. **Image Resize Rules**
   - Only visible/enabled for image asset classes.
   - Configure presets such as width, height, fit, format, quality.
   - Select destination vault explicitly; default can be same vault but must be visible.

6. **Preview and Validation**
   - Show a dry-run plan for a selected asset class: objects to create, vaults to write, retention, and expected reads.
   - Warn on missing permanent copy, missing capability evidence, temporary-only durable asset, or resize rule on non-image.

### UI acceptance examples

For Video Maker, the UI should be able to show:

- raw production image/video/document -> MinIO permanent vault, required;
- raw production image/video/document -> optional temporary hot vault backed by R2 or MinIO, TTL 7 days;
- production image -> image resize derivative -> R2 permanent resize vault, required for derivative object.

## API surface

Add authenticated server-side admin routes under a new admin namespace. The exact route names can be refined during planning, but the design needs these capabilities:

- list/create/update providers;
- list/create/update vaults;
- list/create/update asset classes;
- list/create/update route rules;
- list/create/update derivative rules;
- preview route plan for profile + asset class + media type;
- validate profile readiness without exposing secrets.

All writes must emit `storage_profile_audit_events` or a new dedicated admin audit table. Browser UI must never receive provider credentials, bearer tokens, signed provider URLs, internal locators, full env paths, or raw secret references beyond approved labels.

The first implementation should keep these admin APIs server-side only. Client app owners may use the UI through scoped Z-s authorization, but app browser code must not call provider APIs or hold Z-s app bearer tokens.

## Migration strategy

1. Add migration `0004_storage_vault_routes_and_derivatives.sql` with new tables, comments, indexes, constraints, and safe references.
2. Backfill vaults for existing Video Maker and seed-test rows from current provider bindings:
   - canonical MinIO vault from `minio_zimspace_local_pc_01` / `zs-dev-app-video-maker-canon`;
   - hot R2 vault from `r2_video_maker_dev_01` / `video-maker-hot`.
3. Backfill profile-vault bindings and route rules for current `user-upload` behavior.
4. Keep old `storage_profile_provider_bindings` populated until runtime no longer depends on fixed hot/canonical assumptions.
5. Implement a pure route planner and preview API before UI so validation and runtime share one rule source.
6. Refactor runtime to plan copy sets from vault route rules.
7. Add derivative execution only in a separate implementation slice after image processor and job semantics are approved; schema and UI preview can be added first, but UI must label execution readiness accurately.

## Documentation and live DB obligations

Any live schema change must:

- add comments for every new table and column;
- update `z-kn/06-db-schema/project/z-s/main.md` current state;
- create immutable post-change schema history under `z-kn-bk/06-db-schema/project/z-s/`;
- update live legacy-object sections if any old fixed-role objects remain present but are no longer preferred;
- avoid copying row data, secrets, credentials, URLs, or token values into vault docs.

## Testing and verification plan

### Source-level tests

- Migration validation for new tables, constraints, comments, and rollback if a down migration is included.
- Route planner tests:
  - one asset to one vault;
  - one asset to many vaults;
  - required permanent plus optional temporary copy;
  - reject temporary-only durable route;
  - reject resize derivative for video/document.
- Runtime registry tests for N-placement write intent creation after the generic runtime slice.
- Delivery selection tests using vault read priority.
- Admin API tests for secret-safe responses.

### Manual QA gate after implementation

- Use the client web UI to create the Video Maker example configuration.
- Preview an image upload route and confirm it shows raw MinIO permanent, an optional provider-neutral 7-day hot vault, and image resize derivative to permanent R2 vault.
- Try a bad resize rule on a video asset class and confirm the UI/API rejects it.
- Hit readiness/preview API with curl and confirm no secrets/provider-private locators are exposed.

## Risks and constraints

- This is larger than a simple schema addition because current runtime code assumes two copies and hardcoded Video Maker authority.
- A UI can be built before all runtime execution is generalized, but it must consume the pure route planner and mark unproved runtime actions as not live-ready.
- Actual image resize execution is a new subsystem because this package has no image-processing dependency or job-worker model today.
- Existing Z-s contract version `1.0` may need additive responses only; any breaking contract change requires a new major contract version.
- Live DB mutation, source code changes, provider capability proof, and browser acceptance must remain separate governed steps.

## Recommended implementation slices

1. Schema and docs: migration `0004`, table comments, z-kn/z-kn-bk schema documentation.
2. Pure route planner for vault placement preview and readiness validation.
3. Control-plane read/write admin API for providers, vaults, asset classes, route rules, derivative rules, and preview validation.
4. Minimal internal Z-s admin web UI for configuration and preview.
5. Runtime route planner integration replacing fixed hot/canonical write planning for original uploads.
6. Generic read-delivery selection by vault read priority.
7. Image resize derivative execution and object provenance after processor/job approval.
8. Live Video Maker-style acceptance with non-secret evidence and registry update.

## Decisions for implementation plan

1. Use **vault** as the client-facing term.
2. Allow R2 to be permanent only when explicitly configured as a permanent vault; the model remains provider-neutral, so a temporary or permanent vault can also be MinIO when approved.
3. Include image resize schema and UI preview first, but defer actual image resize execution until the image processor and job semantics are approved.
4. Build the first UI as an internal Z-s admin surface, not a full client-owner portal with tenant RBAC.

## Self-review result

- Placeholder scan: no TBD/TODO placeholders remain.
- Internal consistency: schema, runtime, API, and UI sections all use vaults as the client-facing destination and keep provider credentials outside the database.
- Scope check: the full request spans schema, runtime, and UI; implementation is split into bounded slices so the first plan can be executable.
- Ambiguity check: former review decisions are resolved above for the implementation plan; actual derivative execution remains a later approved slice.
