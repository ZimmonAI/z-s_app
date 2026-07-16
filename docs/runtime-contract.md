# Z-s runtime contract

## Exact identity

- Source package: `@zimmonai/z-s-control-plane@0.3.0`
- Registry: private GitHub Packages npm registry
- Package owner/scope: `ZimmonAI/@zimmonai`
- Contract: `1.0`
- Runtime: Node.js 22 or newer
- Transport: authenticated server-to-server HTTP with JSON control requests and one raw streamed upload body
- Publication in 2B-05: none
- Release tag in 2B-05: none

Version `0.3.0` is a backward-compatible addition within contract `1.x`. It preserves the root, `runtime-contract`, `runtime-service`, and `runtime-storage-registry` package entry points. It does not overwrite or republish `0.2.1`, configure package visibility, or grant consumer access.

## Imports

```ts
import {
  CONTRACT_VERSION,
  PACKAGE_VERSION,
  type ObjectWriteIntentRequest,
  type ObjectWriteIntentResult,
  type ObjectUploadCompletionRequestMetadata,
  type ObjectUploadCompletionResult,
  type ObjectWriteIntentCancellationResult,
  type ResolvedObjectWritePolicy,
} from '@zimmonai/z-s-control-plane/runtime-contract';

import {
  createObjectIngestRuntime,
  createDeterministicUploadCompletionTokenService,
  type ObjectIngestAdapter,
  type ResolvedObjectWriteAuthority,
} from '@zimmonai/z-s-control-plane/runtime-service';

import {
  PostgresRuntimeStorageRegistry,
  type PostgresQueryable,
} from '@zimmonai/z-s-control-plane/runtime-storage-registry';
```

The deterministic upload-completion token service is an injected testing utility. Production signer and secret binding are deliberately not configured by 2B-05.

## Runtime composition boundary

`createObjectIngestRuntime` composes:

- bearer-token authentication;
- caller authorization;
- exact active storage-profile resolution;
- server-only write-authority resolution;
- durable registry and duplicate protection;
- an injected upload-completion token service;
- an injected bounded `ObjectIngestAdapter`; and
- separate control-plane and data-plane readiness probes.

The server-only `ResolvedObjectWriteAuthority` contains internal profile, prefix, and provider-binding identifiers plus this exact write policy shape:

```ts
interface ResolvedObjectWritePolicy {
  uploadMode: 'server-streamed-single-object';
  allowedMediaTypes: readonly string[];
  maxByteLength: number;
  intentTtlSeconds: 900;
}
```

Internal identifiers, provider bindings, bucket data, and generated locators are never part of public result DTOs.

## Exact HTTP surface

```text
GET    /healthz
GET    /readyz
POST   /v1/object-write-intents
PUT    /v1/object-write-intents/{objectWriteIntentId}/content
DELETE /v1/object-write-intents/{objectWriteIntentId}
```

No multipart, resumable, provider-presigned, browser-direct, caller-selected bucket, caller-selected provider, or caller-selected object-key route is implemented.

## Create an object-write-intent

### Request

```http
POST /v1/object-write-intents
Authorization: Bearer <runtime-token>
X-ZS-Contract-Version: 1.0
X-ZS-Caller-App: video-maker_app
X-App-Correlation-Reference: upload-example-001
Idempotency-Key: create-example-001
Content-Type: application/json

{
  "storageProfile": {
    "profileId": "video-maker-dev-default",
    "profileVersion": 1,
    "environment": "dev"
  },
  "mediaType": "image/png",
  "byteLength": 1234,
  "checksumSha256": "<lowercase-64-hex>",
  "sourceReference": "opaque-consumer-reference"
}
```

The runtime rejects unsupported contract versions before operation execution, requires `X-ZS-Caller-App` to match the authenticated caller, authorizes `object-write-intent`, resolves the exact active profile and ready capability evidence, validates MIME and size from the resolved write policy, and creates one storage object, one write intent, and two pending provider-copy rows under durable duplicate protection.

### Safe result

```json
{
  "contractVersion": "1.0",
  "result": {
    "writeIntentId": "<uuid>",
    "storageObjectId": "<uuid>",
    "state": "accepted",
    "uploadCompletionToken": "<short-lived-sensitive-token>",
    "expiresAt": "<iso-8601-not-more-than-900-seconds>",
    "objectProtectionStage": "write-intent-created",
    "duplicateProtection": {
      "key": "create-example-001",
      "replayed": false
    }
  }
}
```

The upload-completion token is sensitive. It must never be persisted, logged, emitted in diagnostics, included in screenshots, or stored in snapshots.

## Stream object content

### Request

```http
PUT /v1/object-write-intents/<objectWriteIntentId>/content
Authorization: Bearer <same-runtime-token>
X-ZS-Contract-Version: 1.0
X-ZS-Caller-App: video-maker_app
X-App-Correlation-Reference: upload-example-001
Idempotency-Key: complete-example-001
X-ZS-Upload-Completion-Token: <token-returned-by-create>
X-Content-SHA256: <lowercase-64-hex>
Content-Type: image/png
Content-Length: 1234

<exactly 1234 raw object bytes>
```

The body is a raw byte stream. JSON and multipart bodies are not accepted.

Before full body consumption, the runtime validates the UUID route parameter, contract version, caller, correlation, idempotency key, completion token, durable intent context, exact MIME type, exact `Content-Length`, and exact declared SHA-256. It atomically transitions `accepted -> uploading`, invokes the injected adapter once, independently computes byte count and SHA-256 while streaming, cleans task-created partial state on abort or mismatch, and records `uploading -> completed` only after bounded validation succeeds.

### Safe result

```json
{
  "contractVersion": "1.0",
  "result": {
    "storageObjectId": "<uuid>",
    "writeIntentId": "<uuid>",
    "state": "recorded",
    "checksumSha256": "<computed-lowercase-64-hex>",
    "byteLength": 1234,
    "integrityVerification": {
      "checksum": "passed",
      "size": "passed"
    },
    "objectProtectionStage": "upload-completion-recorded",
    "duplicateProtection": {
      "key": "complete-example-001",
      "replayed": false
    }
  }
}
```

An exact durable replay returns the same stable result without consuming the stream or invoking the adapter again. Reusing the same idempotency key with a different fingerprint returns a deterministic duplicate conflict.

Generic completion does not mean provider verification. The storage object remains reserved, and both hot and canonical copy rows remain pending.

## Cancel an uncompleted intent

### Request

```http
DELETE /v1/object-write-intents/<objectWriteIntentId>
Authorization: Bearer <same-runtime-token>
X-ZS-Contract-Version: 1.0
X-ZS-Caller-App: video-maker_app
X-App-Correlation-Reference: upload-example-001
Idempotency-Key: cancel-example-001
```

The runtime uses durable `object-write-intent-cancel` duplicate protection and compare-and-set state checks. Only `accepted` or `uploading` may become `cancelled`. Completed, expired, failed, or already cancelled intents return deterministic safe behavior. Durable storage-object and registry rows are not deleted.

### Safe result

```json
{
  "contractVersion": "1.0",
  "result": {
    "storageObjectId": "<uuid>",
    "writeIntentId": "<uuid>",
    "state": "cancelled",
    "duplicateProtection": {
      "key": "cancel-example-001",
      "replayed": false
    }
  }
}
```

## Durable duplicate-protection scopes

```text
object-write-intent
object-upload-completion
object-write-intent-cancel
```

The durable identity is caller app, optional caller service, operation scope, and idempotency key. Request fingerprints exclude bearer tokens and upload-completion tokens.

## State truth

| Condition | Intent | Storage object | Provider copies |
|---|---|---|---|
| intent created | `accepted` | `reserved` / `write-intent-created` | both `pending` |
| stream accepted | `uploading` | `reserved` / `write-intent-created` | both `pending` |
| generic ingest recorded | `completed` | `reserved` / `upload-completion-recorded` | both `pending` |
| expired | `expired` | durable and not active | both `pending` |
| cancelled | `cancelled` | durable and not active | both `pending` |
| failed after stream/validation error | `failed` after cleanup | durable and not active | both `pending` |

2B-05 never marks a storage object active or protected and never marks a provider copy verified.

## Validation and distribution boundary

The dedicated `2B-05 write intent and generic ingest validation` workflow runs on Node.js 22 with a disposable PostgreSQL 17 service. It verifies focused ingest tests, registry integration tests, migration byte identity, and the complete `npm run validate` chain. The package smoke installs a clean local tarball and verifies all four existing package entry points at source version `0.3.0` and contract `1.0`.

Including reviewed migration files in the package does not apply them. No live database, R2, MinIO, deployment, browser, Video Maker source, or Z-X source action is performed by packaging, importing, or testing this source.

## Safety boundary

Public responses and diagnostics exclude provider endpoints, bucket names, internal locators, credentials, secret references, connection strings, bearer tokens, upload-completion tokens, raw provider responses, and consumer business payloads.

Real independent R2 and MinIO writes plus provider/media verification belong to the separate 2B-06 implementation. Read delivery, technical deletion, repair, reconciliation, eventing, deployment, and consumer adoption remain separate governed work.