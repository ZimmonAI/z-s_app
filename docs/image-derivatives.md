# Image derivative runtime

T2 H05 adds bounded image-only derivative processing to the existing client storage workspace and generic runtime.

## Authority and lifecycle

A successful generic upload remains authoritative. After the source object and its configured provider copies are verified, the derivative store idempotently snapshots the source client, environment, immutable configuration version and fingerprint, image route, image preset, target derivative vault, width, output format, quality, and fit mode into one durable job per configured width.

Jobs use `queued`, `processing`, `succeeded`, and `failed` states. PostgreSQL claims use `FOR UPDATE SKIP LOCKED`, short leases, maximum attempts, safe diagnostic codes, and delayed retry eligibility. A periodic bounded worker and an immediate post-upload drain both use the same claim path, so duplicate workers cannot create duplicate output objects.

Every successful derivative is stored as a separate normal `storage_objects` row and one verified `storage_object_copies` row. `storage_image_derivative_outputs` records source-to-job-to-output lineage only after the output checksum, byte length, target vault, provider connection, and copy state have been verified.

## Supported processing envelope

This implementation deliberately accepts only non-interlaced, 8-bit RGB or RGBA PNG input (`image/png`) and produces PNG output. Presets requesting AVIF, WebP, or JPEG fail safely with `image-derivative-output-format-unsupported`; no partial lineage is recorded. The narrow codec envelope avoids adding a new native image library or silently changing configuration authority.

Hard limits are defined in `IMAGE_DERIVATIVE_LIMITS`: 32 MiB source bytes, 64 million decoded pixels, widths from 16 through 16,384, at most eight widths per preset, 16 MiB output bytes, concurrency two, three attempts, a five-minute lease, and a bounded 50-row status response.

## Runtime configuration

The worker reuses existing configuration:

- `Z_S_POSTGRES_URL` enables durable jobs and status.
- `Z_S_PROVIDER_CREDENTIAL_BINDINGS_JSON` resolves server-side provider credentials; credentials never enter the browser response.
- `Z_S_CONTROL_SESSION_SIGNING_KEY` enables the authenticated client status endpoint.
- `Z_S_IMAGE_DERIVATIVE_POLL_INTERVAL_MS` controls the bounded retry poll interval from 1,000 through 60,000 milliseconds; default 5,000.

No integration bearer token authorizes the browser status API.

## Client status surface

`GET /client/storage/image-derivatives?environment=dev|staging|prod` requires the signed client browser session. It returns only safe identifiers and operational state: job ID, source/output object IDs, preset ID, width, format, state, attempt count, safe diagnostic code, and timestamps.

The existing `/client/storage/configuration` page receives an additive status section. Loading, empty, unavailable, success, and failure states are isolated from the configuration editor. Provider endpoints, bucket names, object keys, internal locators, checksums, credentials, signed URLs, and raw provider errors are never rendered.

## Operations

A retryable job remains `failed` with `next_retry_at` until a bounded worker claims it again. Expired processing leases are reclaimable. Verified outputs are immutable and retries return the existing verified object only when byte length and checksum match.

Migration rollback is intentionally blocked once any derivative job, lineage row, output object, or output copy exists. Operators must preserve adopted derivative lineage rather than dropping the schema around live data.

H04B external database proof remains pending. This implementation does not claim approval-environment validation, deployment, readiness promotion, or merge authority.
