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

It does not contain credential values, reusable upload authority, caller-selected provider destinations, browser code, live database state, deployment configuration, or consumer business logic.

## Source package identity

The current source identity is `@zimmonai/z-s-control-plane@0.4.0`. Contract `1.0` and Node.js `>=22` remain unchanged. The existing root, `runtime-contract`, `runtime-service`, and `runtime-storage-registry` package entry points are preserved; no additional package subpath is introduced.

Version `0.4.0` is a source implementation target only. This task does not publish the package, create a release tag, change package visibility, or grant consumer access.

The only direct runtime dependency is the exact registry package `@aws-sdk/client-s3@3.1088.0`. `package-lock.json` is the canonical npm lock and uses lockfile version 3.

## Runtime HTTP surface

The in-process runtime recognizes exactly:

```text
GET    /healthz
GET    /readyz
POST   /v1/object-write-intents
PUT    /v1/object-write-intents/{objectWriteIntentId}/content
DELETE /v1/object-write-intents/{objectWriteIntentId}
```

`POST /v1/object-write-intents` creates one durable object identity, one write intent, and exactly two pending provider-copy rows under resolved server-side authority.

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

The dedicated GitHub Actions workflow runs Node.js 22 with a disposable PostgreSQL 17 service, verifies that migrations and seeds are unchanged, and executes the complete validation chain with deterministic provider doubles. It does not read provider credentials or connect to governed provider infrastructure.

## Governed local provider handoff

`scripts/verify-2b-06-providers.mjs` is a separate, explicit local handoff for approved R2 and MinIO-compatible targets. It is never executed by CI. It requires both `--confirm-provider-actions` and `ZS_2B06_PROVIDER_ACTIONS_APPROVED=true`, generates exact locators under approved prefixes, never lists a bucket, and deletes plus `HEAD`-verifies absence of every exact target before exit.

Supported scenarios are exactly:

```text
both-success-png
both-success-mp4
hot-write-failure
canonical-write-failure
both-write-failure
checksum-mismatch
required-size-mismatch
hot-targeted-retry
canonical-targeted-retry
```

For each role (`HOT` and `CANONICAL`), provide these environment variables only in the approved local shell: `ZS_2B06_<ROLE>_PROVIDER_ALIAS`, `ZS_2B06_<ROLE>_BUCKET_ALIAS`, `ZS_2B06_<ROLE>_BUCKET`, `ZS_2B06_<ROLE>_PREFIX_PATTERN`, `ZS_2B06_<ROLE>_ENDPOINT`, `ZS_2B06_<ROLE>_REGION`, `ZS_2B06_<ROLE>_FORCE_PATH_STYLE`, `ZS_2B06_<ROLE>_ACCESS_KEY_ID`, `ZS_2B06_<ROLE>_SECRET_ACCESS_KEY`, and optional `ZS_2B06_<ROLE>_SESSION_TOKEN`. Prefix patterns must end in `*` and must already be approved for disposable 2B-06 objects.

After source review and separate provider-action approval, run one scenario at a time:

```text
ZS_2B06_PROVIDER_ACTIONS_APPROVED=true \
  npm run verify:2b06:providers -- \
  --run-id <approved-safe-run-id> \
  --scenario <allowlisted-scenario> \
  --confirm-provider-actions
```

The emitted JSON contains only safe aliases, state and retry outcomes, media facts, write-attempt counts, and cleanup counts. It excludes endpoints, actual bucket names, internal locators, object keys, credential values, credential-reference identifiers, and raw provider responses.

## Safety boundary

Public responses and safe diagnostics exclude provider endpoints, bucket names, internal locators, object keys, credential values, credential-reference identifiers, connection strings, bearer tokens, upload-completion tokens, raw provider responses, and consumer business payloads.

Real deployment, package publication, provider provisioning, schema changes, read delivery, technical deletion, broad reconciliation scheduling, browser behavior, and consumer adoption remain separate governed work.
