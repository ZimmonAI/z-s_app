# Client storage service management

T2 H07 adds provider-neutral service management for managed and client-owned storage.

## Browser routes

- `/client/storage/services`
- `/client/storage/services/new`
- `/client/storage/services/{serviceId}`
- `/client/storage/services/{serviceId}/setup`
- `/client/storage/services/{serviceId}/workflow`
- `/client/storage/services/{serviceId}/activity`

All browser mutations require the existing signed client session and a same-origin `Origin` header. JSON bodies remain bounded by the control-plane request reader.

## Credential boundary

Client-owned provider values are validated by the provider adapter, serialized in a bounded object, and encrypted with AES-256-GCM. Each envelope uses a random 96-bit nonce, an explicit key version, and authenticated additional data containing the client, environment, service, and provider identifiers. PostgreSQL stores only nonce, ciphertext, authentication tag, algorithm, key version, and lifecycle metadata.

Configure the active deployment key through `Z_S_PROVIDER_SECRET_MASTER_KEY_V1`. The value must decode to exactly 32 bytes from either hexadecimal or base64. The key is deployment-only and must never be committed.

The browser and public API do not return plaintext credentials, encrypted envelopes, internal provider endpoints, private bucket names, object keys, signed URLs, or internal secret references. Replacement creates a new envelope and revokes the old envelope. There is no reveal route.

## Cloudflare R2 adapter

The accepted provider manifest is `cloudflare-r2`. Runtime execution uses the existing S3-compatible object boundary. Connection testing performs one write and one head verification under an exact caller-supplied test prefix, then attempts cleanup. It does not enumerate accounts, buckets, or unrelated prefixes.

## Configuration linkage

Only services in `ready` state can seed configuration drafts. The service reference is persisted through the existing provider-connection boundary with an internal `zs-storage-service:{uuid}` reference. Migration `0012` attaches the authoritative service foreign key through a database trigger.

Before activation, the safe configuration facade checks service ownership, client/environment isolation, readiness, and required capabilities. Existing accepted provider references remain compatible when they do not use the storage-service reference prefix.

## Migration

Apply `db/migrations/0012_z_s_storage_services.sql` after `0011`. The rollback is intentionally blocked while any service, encrypted secret, event, or provider-connection dependency remains.
