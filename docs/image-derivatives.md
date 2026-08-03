# Image derivative processing

T2 H05 adds a bounded, image-only derivative workflow on top of the immutable client storage configuration selected when a source object is written.

## Durable authority

A derivative job is created only after a configuration-routed source object is active and checksum/size verified. The job snapshots the source client, configuration version and fingerprint, image route, image preset, target derivative vault, width, output format, quality, and fit. Later configuration activation cannot change an existing job.

The logical idempotency key is the source object, immutable configuration version, immutable image preset, requested width, and output format. Repeated upload-completion observation therefore creates no duplicate job.

Each successful derivative is a separate normal `storage_objects` row with a normal `storage_object_copies` row. The output copy is authorized by the derivative job and preset-selected vault, not by a caller-supplied provider locator. `storage_image_derivative_outputs` stores safe source-to-output lineage after checksum and byte-length verification.

## Processing limits

The initial bounded processor accepts PNG signature plus `image/png`, non-interlaced 8-bit grayscale/RGB/grayscale-alpha/RGBA input. It rejects malformed CRCs, animated PNG, unsupported critical chunks, decompression mismatch, oversized source/output bodies, excessive decoded pixels, excessive working memory, invalid width, invalid quality, and unsupported output formats.

Named defaults:

- source bytes: 32 MiB
- output bytes: 32 MiB
- decoded pixels: 40,000,000
- working memory: 256 MiB
- width: 16–16,384 pixels
- widths per preset: at most 8
- quality: 1–100
- worker concurrency: 2
- processing attempts: 3
- retry delay: 30 seconds
- lease: 2 minutes
- browser status rows: 50

The selected dependency-free processor emits PNG. Presets selecting WebP, AVIF, or JPEG fail with the safe terminal diagnostic `image-output-format-unsupported`; they are never silently rewritten to another format.

## Worker operation

The main HTTP runtime enqueues duplicate-safe jobs after a verified upload completion response. It does not run image processing inline and does not change a successful upload response when enqueue reconciliation is temporarily unavailable.

A worker is run explicitly after build:

```bash
npm run image-derivative:run -- --maximum-jobs=10
```

The worker requires `Z_S_POSTGRES_URL` and the existing `Z_S_PROVIDER_CREDENTIAL_BINDINGS_JSON`. `Z_S_IMAGE_DERIVATIVE_WORKER_ID` is optional. Each claim uses `FOR UPDATE SKIP LOCKED`, a random lease token, bounded attempts, and a delayed retry for safe retryable failures.

## Browser status boundary

`GET /client/storage/image-derivatives?environment=dev|staging|prod` accepts only the signed browser client session. Integration bearer tokens are rejected. The response is bounded and contains only job/source/output UUIDs, preset identifier, width, format, state, attempts, safe diagnostic code, and timestamps. It never exposes provider endpoints, buckets, internal locators, credentials, token values/digests, or raw checksums.

The authenticated configuration workspace receives an additive status section. If the derivative store is unavailable, no jobs exist, or no processor is running, the rest of the workspace remains usable.

## Migration

Apply `db/migrations/0011_z_s_image_derivatives.sql` after migration 0010. Reapply is rejected. The down migration is allowed only before any derivative job, output, or derivative copy row has been adopted; otherwise it refuses destructive rollback.
