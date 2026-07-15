# Z-s runtime contract

## Exact identity

- Package: `@zimspace/z-s-control-plane@0.2.0`
- Service: `z-s`
- Contract: `1.0`
- Runtime: Node.js 22 or newer
- Transport: authenticated server-to-server HTTP JSON

The package is private and installable from an exact generated package tarball or an approved immutable private-package release. Consumers must not depend on a floating branch or a permanent local `file:` path.

## Imports

```ts
import {
  CONTRACT_VERSION,
  type ObjectWriteIntentRequest,
  type ObjectWriteIntentResult,
  type ProviderCapabilityPolicy,
  type IntegrityVerificationResult,
} from '@zimspace/z-s-control-plane/runtime-contract';

import {
  createHttpStorageRuntime,
  createInMemoryDuplicateProtectionStore,
} from '@zimspace/z-s-control-plane/runtime-service';
```

The package root exports both the existing control-plane API and the runtime contract. The subpaths make the consumer boundary explicit.

## Runtime foundation

```ts
import { createHttpStorageRuntime } from '@zimspace/z-s-control-plane/runtime-service';

const runtime = createHttpStorageRuntime({
  authenticate: async (token) =>
    token === process.env.INTERNAL_ZS_TOKEN ? { appId: 'video-maker_app' } : null,
  authorizeCaller: async ({ appId }) =>
    appId === 'video-maker_app' || appId === 'z-x_app',
  resolveStorageProfile: async (request) => ({
    ...request,
    ready: true,
    safeFingerprint: 'approved-profile-fingerprint',
    capabilityPolicy: {
      checksumVerification: 'required',
      sizeVerification: 'required-when-supported',
      headContentLength: 'optional-with-checksum',
      rangeRead: 'required',
    },
    capabilities: {
      objectWriteIntent: true,
      objectReadGrant: false,
      objectDeleteRequest: false,
      objectRepairOperation: false,
    },
    protectionStages: ['write-intent-created'],
  }),
  createObjectWriteIntent: async ({ context }) => ({
    writeIntentId: `wi_${context.requestId}`,
    storageObjectId: `so_${context.requestId}`,
    state: 'accepted',
    uploadCompletionToken: 'opaque-z-s-token',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    objectProtectionStage: 'write-intent-created',
  }),
  controlPlaneReadiness: async () => ({ status: 'ready' }),
  dataPlaneReadiness: async () => ({
    status: 'not-ready',
    code: 'provider-adapters-not-configured',
  }),
});
```

The foundation exposes:

```text
GET  /healthz
GET  /readyz
POST /v1/object-write-intents
```

The write-intent request requires:

```text
Authorization: Bearer <server-only token>
x-zs-contract-version: 1.0
x-zs-caller-app: <authenticated app ID>
idempotency-key: <duplicate-protection key>
x-app-correlation-reference: <safe opaque correlation>
Content-Type: application/json
```

## Safety boundary

The runtime serializes only safe contract results and `safe-diagnostic` values. Profile resolvers and operation adapters may hold provider assignments internally, but normal responses do not expose provider endpoints, credentials, secret-reference IDs, buckets, or object keys.

The default in-memory duplicate-protection store is suitable only for deterministic tests and a single-process foundation. Durable duplicate protection belongs to the 2B-04 runtime registry.

No live upload, provider write, read delivery, delete, repair, reconciliation, browser flow, deployment, Video Maker business logic, or Z-X execution logic is implemented by this foundation.
