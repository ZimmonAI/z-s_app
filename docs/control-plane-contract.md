# Control-plane contract

## Safe resolution call

`StorageControlPlaneService.resolveStorageProfileAssignment` requires an explicit app ID, environment, profile ID, and operation class. An optional object key is checked against the resolved prefix before assignment is returned.

The response contains only app identity, active profile version, provider IDs, bucket labels, the prefix class, the provider capability policy, and a deterministic fingerprint. It never contains credentials, endpoints, account identifiers, connection strings, signed URLs, raw object keys, or provider-private responses.

## Fail-closed behavior

Resolution rejects unknown or disabled managed apps, inactive or ambiguous profiles, app/environment mismatches, missing or disabled provider bindings, missing prefix classes, object keys outside the prefix, missing/failed/expired capability evidence, and configuration conflicts.

## Capability policy

Checksum verification is always required when a write contract supplies a checksum. Size is required when the provider exposes a trustworthy size signal. A provider may declare size unsupported; in that case an absent HEAD content length is accepted only when checksum evidence matches. Conflicting checksum, size, provider, bucket, or prefix evidence remains a hard failure.

## Secret boundary

The control-plane provider record stores only a non-secret `secretReferenceId`. `StorageSecretResolver` is a server-only interface implemented outside the assignment response path. Resolved credentials must not enter fingerprints, API output, audit events, test snapshots, or documentation.
