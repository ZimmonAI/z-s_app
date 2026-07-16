# Z-s runtime contract

## Exact identity

- Package: `@zimmonai/z-s-control-plane@0.2.1`
- Registry: private GitHub Packages npm registry
- Package owner/scope: `ZimmonAI/@zimmonai`
- Release tag: `z-s-control-plane-v0.2.1`
- Canonical distribution baseline: `abd710088ca1640eb6d5f864bc65a563b3481d82`
- Service: `z-s`
- Contract: `1.0`
- Runtime: Node.js 22 or newer
- Transport: authenticated server-to-server HTTP JSON

This is the explicit registry successor to the unpublished/private source identity `@zimspace/z-s-control-plane@0.2.0`; it is not an overwrite or republication of that identity. Consumers install the exact private registry version after their repository has been granted bounded package read access. Consumers must not depend on Git SSH, a floating branch or tag, a permanent local path, a committed tarball, copied build output, or vendored contract types.

## Imports

```ts
import {
  CONTRACT_VERSION,
  type ObjectWriteIntentRequest,
  type ObjectWriteIntentResult,
  type ProviderCapabilityPolicy,
  type IntegrityVerificationResult,
} from '@zimmonai/z-s-control-plane/runtime-contract';

import {
  createHttpStorageRuntime,
  createInMemoryDuplicateProtectionStore,
} from '@zimmonai/z-s-control-plane/runtime-service';

import {
  PostgresRuntimeStorageRegistry,
  type PostgresQueryable,
} from '@zimmonai/z-s-control-plane/runtime-storage-registry';
```

The package root exports the existing control-plane API and runtime contract. The `runtime-contract`, `runtime-service`, and merged `runtime-storage-registry` subpaths make the server-side boundaries explicit.

## Runtime foundation

```ts
import { createHttpStorageRuntime } from '@zimmonai/z-s-control-plane/runtime-service';

const completionValue = ['opaque', 'z-s', 'value'].join('-');
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
    uploadCompletionToken: completionValue,
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

## Distribution and integrity boundary

The exact package is built with `prepack` and restricted to the explicitly verified compiled `dist` modules, `README.md`, this runtime contract document, and the reviewed 2B-04 forward/rollback migration artifacts. It is published only from the exact release tag after the full Node.js 22 validation chain passes. The publication workflow retains the tarball SHA-256, npm integrity value, source commit, tag, workflow run, package URL, exact file/export list, and post-publish exact-version install evidence without retaining credentials or workspace paths.

Including the reviewed migration files in the package does not apply them. Live database application and rollback remain separately governed 2B-04 work.

A defective version is never overwritten. It remains recorded and a new reviewed successor version is published. Package visibility, repository Actions access, and any deprecation or restriction action remain separately governed package-administration work.

## Safety boundary

The runtime serializes only safe contract results and `safe-diagnostic` values. Profile resolvers and operation adapters may hold provider assignments internally, but normal responses do not expose provider endpoints, credentials, secret-reference IDs, buckets, or object keys.

The merged runtime storage registry provides an injectable durable persistence implementation and durable duplicate-protection boundary. It does not establish a live database connection merely by being packaged or imported; live schema application and runtime wiring remain separate governed actions.

No live upload, provider write, read delivery, delete, repair, reconciliation worker, browser flow, deployment, Video Maker business logic, or Z-X execution logic is completed by publishing this package.
