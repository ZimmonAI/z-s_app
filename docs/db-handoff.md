# Z-s schema apply handoff artifact

The SQL artifacts in this repository are prepared for the separate governed live database handoff. This package does not connect to or mutate the live database.

```yaml
expected_live_database: z-s
expected_schema: public
expected_tables:
  - managed_apps
  - storage_providers
  - storage_profiles
  - storage_profile_provider_bindings
  - storage_prefix_classes
  - storage_capability_results
  - storage_profile_audit_events
migration_artifact: db/migrations/0001_z_s_control_plane_foundation.sql
seed_artifact: db/seeds/0001_video_maker_dev_profiles.sql
capability_readiness_seeded: false
```

The live handoff must verify every table and column comment, apply the idempotent development seed only in the authorized development scope, and synchronize the current and immutable schema documentation after live verification.
