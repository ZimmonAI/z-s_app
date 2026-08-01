# Zimspace Storage App control plane

This private repository is the canonical implementation home for `z-s_app`, the main application of the Z-s storage brand.

The package provides the server-side control-plane, durable registry, and bounded object-ingest runtime for:

- versioned storage profiles and exact prefix authority;
- provider and bucket bindings without exposing credential values;
- capability-aware integrity verification;
- durable `object-write-intent` creation and duplicate protection;
- single-read bounded staging of raw upload bodies;
- structural PNG and MP4 verification without shelling out to external media tools;
- independent concurrent hot and canonical provider writes;
- provider-attempt, provider-copy, storage-object, and intent state persistence; and
- targeted retry of only a failed provider role.

It does not contain credential values, reusable upload authority, caller-selected provider destinations, live database state, deployment configuration, or consumer business logic.

## Source package identity

The current source identity is `@zimmonai/z-s-control-plane@0.5.0`. Contract `1.0` and Node.js `>=22` remain unchanged. The existing package entry points remain available, with additive `runtime-read-grant` and `runtime-read-delivery` subpaths for the governed server runtime.

Version `0.5.0` is a source implementation target only. This task does not publish the package, create a release tag, change package visibility, or grant consumer access.

The only direct runtime dependency is the exact registry package `@aws-sdk/client-s3@3.1088.0`. `package-lock.json` is the canonical npm lock and uses lockfile version 3.

## Runtime HTTP surface

The in-process runtime recognizes:

```text
GET    /
GET    /login
POST   /admin/session
DELETE /admin/session
GET    /admin/storage
POST   /admin/storage/plans
GET    /healthz
GET    /readyz
POST   /v1/object-write-intents
PUT    /v1/object-write-intents/{objectWriteIntentId}/content
DELETE /v1/object-write-intents/{objectWriteIntentId}
POST   /v1/object-read-grants
DELETE /v1/object-read-grants/{objectReadGrantId}
GET    /v1/storage-objects/{storageObjectId}/content
HEAD   /v1/storage-objects/{storageObjectId}/content
```

`POST /v1/object-write-intents` creates one durable object identity, one write intent, and exactly two pending provider-copy rows under resolved server-side authority.

The browser control routes are operator-gated by `Z_S_CONTROL_ADMIN_PASSWORD` and `Z_S_CONTROL_SESSION_SIGNING_KEY`. They serve a minimal storage vault planner for client vaults, provider roles, retention policy, asset-class routing, and image-only resize derivatives. The planner returns a safe preview only; raw provider endpoints, access keys, secret access keys, and bearer/client tokens are not returned.

`PUT /v1/object-write-intents/{objectWriteIntentId}/content`, when composed with `DualProviderObjectIngestAdapter`, performs this bounded sequence:

1. validates the existing caller, token, MIME, declared size, and declared SHA-256 boundaries;
2. reserves one write attempt for each provider role;
3. consumes the incoming body exactly once into a restrictive temporary file while computing byte length and SHA-256;
4. verifies PNG or MP4 structure before provider writes;
5. opens independent streams from the staged file and writes hot and canonical concurrently;
6. verifies each write using provider `HEAD` facts and the existing capability-aware integrity policy;
7. persists both attempt outcomes, both copy states, object state/stage, safe media facts, and terminal intent state; and
8. removes the temporary file on every exit path.

A durable duplicate replay returns the recorded result without reading the request body, resolving provider credentials, or invoking providers again.

`DELETE /v1/object-write-intents/{objectWriteIntentId}` retains its existing cancellation semantics.

## Provider and media boundaries

`S3CompatibleProviderObjectWriter` uses the official AWS SDK S3 client with injected credential resolution. Provider endpoint, credential, bucket, and locator authority stays server-side. Public results expose only stable copy state and retryability.

The writer uses `PutObject`, `HeadObject`, and exact-target `DeleteObject` cleanup. A conditional create prevents overwriting an existing target. Integrity verification requires the approved SHA-256 metadata value and applies the resolved size capability policy.

`BoundedMediaVerifier` supports:

- PNG signature, first `IHDR`, positive dimensions, pixel limits, bounded chunk traversal, and exact terminal `IEND`; and
- MP4 `ftyp`, bounded box traversal, `moov`/`mvhd` timing, positive duration, and optional deterministic video dimensions and codec facts.

Unsupported, malformed, truncated, MIME-mismatched, and over-limit inputs fail before provider writes.

## State truth

| Provider outcome | Public storage state | Registry state | Object protection stage | Hot copy | Canonical copy |
|---|---|---|---|---|---|
| both verified | `ready` | `active` | `canonical-and-hot-verified` | `verified` | `verified` |
| hot failed, canonical verified | `degraded` | `degraded` | `canonical-verified-hot-repair-required` | `failed` | `verified` |
| hot verified, canonical failed | `degraded` | `degraded` | `hot-verified-canonical-repair-required` | `verified` | `failed` |
| both failed | `unavailable` | `reserved` | `provider-write-failed` | `failed` | `failed` |

Provider failure is contained as durable storage truth rather than leaking raw SDK errors. A targeted retry creates a new attempt for only the selected failed role and never rewrites or deletes the verified peer.

## Repository validation

```text
npm ci --ignore-scripts --no-audit --no-fund
npm run test:focused
npm run test:registry
npm test
npm run typecheck
npm run lint
npm run build
npm run pack:check
npm run package:verify
npm run validate
```

The dedicated GitHub Actions workflow runs Node.js 22 with a disposable PostgreSQL 17 service, verifies that migrations and seeds are unchanged, executes the complete validation chain, and runs all nine frozen scenarios with process-local provider doubles. It also proves scenario, run-ID, and prefix refusal without reading provider credentials or connecting to governed provider infrastructure.

## Governed local provider handoff

`scripts/verify-2b-06-providers.mjs` has two explicit modes. `fake` is the CI-only deterministic provider-double mode. `live` is reserved for the separately approved R2 and MinIO-compatible handoff; it requires `--confirm-provider-actions` and `ZS_2B06_PROVIDER_ACTIONS_APPROVED=true`, reads only already-populated environment bindings, never lists a bucket, and deletes plus `HEAD`-verifies every exact task-owned target before exit.

Supported scenario names are exactly:

```text
png-both-success
mp4-both-success
hot-failure
canonical-failure
both-failure
checksum-mismatch
required-size-mismatch
hot-retry
canonical-retry
```

Every invocation requires the approved non-secret profile, provider, and bucket aliases, the exact `video-maker/user-resources/*` prefix, and a safe caller-supplied run ID. Locator IDs use `2b-06-<run-id>-<scenario>-<nonce>` under that approved prefix.

For live mode only, provide `ZS_2B06_<ROLE>_BUCKET`, `ZS_2B06_<ROLE>_ENDPOINT`, `ZS_2B06_<ROLE>_REGION`, `ZS_2B06_<ROLE>_FORCE_PATH_STYLE`, `ZS_2B06_<ROLE>_ACCESS_KEY_ID`, `ZS_2B06_<ROLE>_SECRET_ACCESS_KEY`, and optional `ZS_2B06_<ROLE>_SESSION_TOKEN` in the approved local shell.

After source review and separate provider-action approval, run one live scenario at a time:

```text
ZS_2B06_PROVIDER_ACTIONS_APPROVED=true \
  npm run verify:2b06:providers -- \
  --mode live \
  --run-id <approved-safe-run-id> \
  --scenario <allowlisted-scenario> \
  --profile-alias video-maker-dev-default \
  --hot-provider-alias r2_video_maker_dev_01 \
  --hot-bucket-alias video-maker-hot \
  --canonical-provider-alias minio_zimspace_local_pc_01 \
  --canonical-bucket-alias zs-dev-app-video-maker-canon \
  --prefix-pattern 'video-maker/user-resources/*' \
  --confirm-provider-actions
```

The harness emits exactly one compact safe JSON line containing the run ID, scenario, final role states, checksum and size dispositions, safe media facts, retry disposition, cleanup counts, and bounded safety flags. It refuses to emit aliases, endpoints, actual bucket names, prefixes, internal locators, raw object keys, credential values, credential-reference identifiers, ETags, signed URLs, or provider bodies.

## Safety boundary

Public responses and safe diagnostics exclude provider endpoints, bucket names, internal locators, object keys, credential values, credential-reference identifiers, connection strings, bearer tokens, upload-completion tokens, raw provider responses, and consumer business payloads.

Real deployment, package publication, provider provisioning, technical deletion, broad reconciliation scheduling, and consumer adoption remain separate governed work.

Source migration `0004_z_s_storage_control_vaults.sql` adds the pending storage-control schema for browser-managed client vault setup: `storage_control_clients`, `storage_control_vaults`, `storage_control_route_rules`, `storage_control_image_derivative_rules`, and `storage_control_client_tokens`. It is additive and guarded, but not asserted here as live-applied.

## Short-lived object read delivery

Package 0.5.0 adds caller-bound, short-lived object read grants and server-streamed delivery without exposing provider authority. Callers create grants with `POST /v1/object-read-grants`, revoke them with `DELETE /v1/object-read-grants/{objectReadGrantId}`, and use `GET` or `HEAD /v1/storage-objects/{storageObjectId}/content` with `x-zs-read-grant-token`.

Delivery accepts one closed, open-ended, or suffix byte range. It returns safe `206` or `416` metadata, tries a verified hot R2-compatible copy first, and falls back to a verified canonical MinIO-compatible copy only when the registry snapshot proves matching checksum, byte length, and media type. Conflicting verified metadata fails closed. Raw object keys, buckets, endpoints, credentials, signed URLs, and provider bodies never enter the public contract, token claims, diagnostics, attempts, or events.
