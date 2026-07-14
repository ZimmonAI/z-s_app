# Zimspace Storage App control plane

This private repository is the canonical implementation home for `z-s_app`, the main application of the Z-s storage brand.

The package provides a server-side, provider-neutral control-plane foundation for:

- managed app and environment registration;
- versioned storage profiles;
- provider and bucket bindings without credential values;
- exact prefix classes;
- dated capability evidence;
- fail-closed safe profile resolution;
- deterministic secret-safe fingerprints;
- capability-aware write integrity verification.

It does not contain provider credentials, provider endpoints, raw object keys, consumer routes, browser code, or live database state.

## Repository validation

```text
npm install --ignore-scripts
npm run validate
```

`npm run validate` runs focused tests, the full test suite, TypeScript checks, repository linting, a production build, migration static validation, seed idempotency validation, secret-pattern enforcement, and legacy delivery-identifier enforcement.

## Artifacts

- Migration: `db/migrations/0001_z_s_control_plane_foundation.sql`
- Development seed: `db/seeds/0001_video_maker_dev_profiles.sql`
- DB apply handoff notes: `docs/db-handoff.md`
- Safe example configuration: `config/example.env`

The migration and seed are reviewed artifacts only. They are not applied by this repository package.
