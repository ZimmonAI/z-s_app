# Z-s runtime contract

## Exact identity

- Source package: `@zimmonai/z-s-control-plane@0.4.0`
- Registry authority: npm/GitHub Packages; no Git, workspace, link, or local source authority
- Direct runtime dependency: `@aws-sdk/client-s3@3.1088.0`
- Lock authority: tracked `package-lock.json`, lockfile version 3
- Contract: `1.0`
- Runtime: Node.js 22 or newer
- Publication in 2B-06: none
- Release tag in 2B-06: none

Version `0.4.0` preserves the existing root, `runtime-contract`, `runtime-service`, and `runtime-storage-registry` package entry points. It adds no public HTTP route and no package subpath.

## Imports

```ts
import {
  CONTRACT_VERSION,
  PACKAGE_VERSION,
  type ObjectUploadCompletionResult,
  type ProviderCopyResultState,
  type SafeProviderCopyResult,
  type StorageObjectResultState,
  type VerifiedImageMetadata,
  type VerifiedMediaMetadata,
  type VerifiedVideoMetadata,
} from '@zimmonai/z-s-control-plane/runtime-contract';

import {
  BoundedMediaVerifier,
  DualProviderObjectIngestAdapter,
  S3CompatibleProviderObjectWriter,
  TargetedProviderRetryCoordinator,
  createObjectIngestRuntime,
  type ProviderCredentialResolver,
  type ProviderWriteTargetResolver,
  type ResolvedProviderWriteTarget,
} from '@zimmonai/z-s-control-plane/runtime-service';

import {
  PostgresRuntimeStorageRegistry,
} from '@zimmonai/z-s-control-plane/runtime-storage-registry';
```

Provider targets, credential bindings, endpoints, buckets, internal locators, and credential references are server-only values. They are not public result DTOs.

## Exact HTTP surface

```text
GET    /healthz
GET    /readyz
POST   /v1/object-write-intents
PUT    /v1/object-write-intents/{objectWriteIntentId}/content
DELETE /v1/object-write-intents/{objectWriteIntentId}
```

No multipart, resumable, provider-presigned, browser-direct, caller-selected bucket, caller-selected provider, or caller-selected object-key route is implemented.

## Dual-provider upload completion

The existing upload-completion route retains its caller, correlation, token, MIME, byte-length, SHA-256, and durable duplicate-protection checks. The dual-provider adapter then:

1. creates exactly two provider-attempt rows with operation reference `object-upload-completion:<intentId>` and attempt number `1`;
2. stages the body once with restrictive file permissions and independently computes exact byte length and SHA-256;
3. verifies media structure before any provider write;
4. opens two independent streams from the staged file;
5. starts hot and canonical writes concurrently and waits for both with settled semantics;
6. verifies each provider result through `verifyProviderWrite`;
7. records each attempt and copy outcome independently;
8. derives object state only after both outcomes are known;
9. completes the write intent durably; and
10. removes temporary state in `finally`.

A provider failure does not erase a verified peer. Cleanup is limited to the exact conditional-create target associated with the failed task.

## Media verification

`VerifiedMediaMetadata` contains only deterministic technical facts:

```ts
interface VerifiedMediaMetadata {
  mediaType: string;
  mediaFamily: 'image' | 'video';
  image?: { width: number; height: number };
  video?: {
    width?: number;
    height?: number;
    durationMs: number;
    container: 'mp4' | (string & {});
    codec?: string;
  };
}
```

PNG validation checks signature, first `IHDR`, positive dimensions, pixel bounds, bounded chunks, and exact terminal `IEND`. MP4 validation checks a supported `ftyp`, bounded box structure, `moov`/`mvhd` timing, and positive duration. Unsupported, malformed, truncated, MIME-mismatched, and over-limit input is rejected before provider execution.

No prompt, title, user, project, scene, provider, endpoint, bucket, locator, object-key, credential, or raw SDK metadata is stored in verified media facts.

## Safe upload-completion result

The existing result identity and `state: "recorded"` remain. A dual-provider completion adds storage truth, verified media, and safe copy outcomes:

```json
{
  "storageObjectId": "<uuid>",
  "writeIntentId": "<uuid>",
  "state": "recorded",
  "checksumSha256": "<computed-lowercase-64-hex>",
  "byteLength": 1234,
  "integrityVerification": {
    "verified": true,
    "checksumVerified": true,
    "sizeVerified": true,
    "sizeVerificationDisposition": "matched"
  },
  "storageState": "ready",
  "verifiedMedia": {
    "mediaType": "image/png",
    "mediaFamily": "image",
    "image": { "width": 1920, "height": 1080 }
  },
  "copies": {
    "hot": { "state": "verified", "retryable": false },
    "canonical": { "state": "verified", "retryable": false }
  },
  "objectProtectionStage": "canonical-and-hot-verified",
  "duplicateProtection": {
    "key": "complete-example-001",
    "replayed": false
  }
}
```

For degraded or unavailable outcomes, `safeDiagnostic` may contain only a bounded category, stable code, retryability, and correlation added by the HTTP runtime. It never contains raw provider messages or authority values.

## Exact outcome matrix

| Hot | Canonical | `storageState` | Registry state | `objectProtectionStage` |
|---|---|---|---|---|
| verified | verified | `ready` | `active` | `canonical-and-hot-verified` |
| failed | verified | `degraded` | `degraded` | `canonical-verified-hot-repair-required` |
| verified | failed | `degraded` | `degraded` | `hot-verified-canonical-repair-required` |
| failed | failed | `unavailable` | `reserved` | `provider-write-failed` |

The intent becomes `completed` after the durable outcome is recorded, including the both-failed `unavailable` case. Request/media validation errors fail the intent instead and do not invoke providers.

## Durable replay

The duplicate-result codec stores only the durable write-intent and storage-object references. Replay reconstructs checksum, byte length, object stage, storage state, verified media, and both safe copy outcomes from registry rows. It does not reread the request body or invoke provider or credential adapters.

## Targeted retry

`TargetedProviderRetryCoordinator` requires an expected failed-copy row version and a verified source. The registry appends the next provider attempt, changes only the selected copy through compare-and-set semantics, writes only that role, and re-derives object truth while leaving the verified peer untouched.

Retry is an internal primitive. It adds no HTTP route, scheduler, queue consumer, or broad reconciliation loop.

## Validation and distribution boundary

The 2B-06 workflow uses Node.js 22 and disposable PostgreSQL 17. It runs focused provider/media tests with deterministic doubles, registry integration tests, the full suite, typecheck, lint, build, clean package install, package artifact verification, migration/seed no-change validation, secret and legacy-identifier checks, and the complete validation chain.

The governed local provider handoff is intentionally separate from CI. It supports only the documented scenario allowlist, requires explicit provider-action approval and a safe run identifier, resolves credentials from the local environment, uses exact generated targets under approved prefixes, performs no broad listing, and deletes plus verifies absence of every exact target. Safe JSON output may contain aliases, media facts, state transitions, retryability, attempt counts, and cleanup counts only.

Packaging and automated testing do not apply migrations, publish a package, access live providers, read credentials, deploy services, or modify consumers.
