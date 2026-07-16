# Runtime storage registry

The runtime registry is a server-only PostgreSQL persistence boundary for Z-s generic storage operations. It is exported from:

```ts
import {
  PostgresRuntimeStorageRegistry,
  type DurableDuplicateResultCodec,
  type PostgresPoolLike,
} from '@zimspace/z-s-control-plane/runtime-storage-registry';
```

## Transaction composition

The registry implements `DuplicateProtectionStore`. Its `execute()` method starts a transaction and exposes the same client to nested registry calls through an asynchronous transaction scope. A runtime write-intent operation can therefore reserve the duplicate-protection key and call `createObjectWriteIntent()` inside one transaction.

```ts
const registry = new PostgresRuntimeStorageRegistry({
  pool: postgresPoolAdapter,
  duplicateResultCodec,
});

const runtime = createHttpStorageRuntime({
  // authentication/profile/readiness dependencies omitted
  duplicateProtectionStore: registry,
  createObjectWriteIntent: async ({ request, resolvedProfile, context }) => {
    const created = await registry.createObjectWriteIntent({
      managedAppId: resolvedManagedAppId,
      callerServiceId: context.caller.serviceId,
      storageProfileId: resolvedStorageProfileId,
      storageProfileFingerprint: resolvedProfile.safeFingerprint,
      storagePrefixClassId: resolvedPrefixClassId,
      hotProviderBindingId: resolvedHotBindingId,
      canonicalProviderBindingId: resolvedCanonicalBindingId,
      appCorrelationReference: context.appCorrelationReference,
      sourceReference: request.sourceReference,
      expectedContentType: request.mediaType,
      expectedByteLength: request.byteLength,
      expectedChecksumSha256: request.checksumSha256,
      requestedObjectProtectionStage: request.requestedProtectionStage,
      expiresAt,
      internalLocators,
    });

    return mintSafeWriteIntentResult(created);
  },
});
```

The result codec persists only a result kind and stable UUID references. Replay decoding may query the stored intent/object and mint a fresh short-lived completion value at the service boundary. Raw bearer or upload-completion values are not registry fields.

## Safety boundary

The repository accepts only opaque correlation/source references and bounded technical JSON objects. Event/detail validation rejects provider-private and app-business key families. Provider locators are stored only in `storage_object_copies`, validated against the resolved prefix pattern, and are never part of public DTOs, events or diagnostics.

The registry performs no upload, read, verification, delete, repair, provider SDK, browser, deployment or live database setup action.
