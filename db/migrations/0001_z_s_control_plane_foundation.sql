BEGIN;

CREATE TABLE public.managed_apps (
  id uuid PRIMARY KEY,
  app_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('dev', 'stg', 'prod')),
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, environment)
);

COMMENT ON TABLE public.managed_apps IS 'Registered managed app and environment identities for Z-s profile resolution. Ref: z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02a-package-z-s-core-control-plane-and-provider-capability-baseline.md';
COMMENT ON COLUMN public.managed_apps.id IS 'Internal UUID primary key.';
COMMENT ON COLUMN public.managed_apps.app_id IS 'Stable non-secret managed app identifier.';
COMMENT ON COLUMN public.managed_apps.environment IS 'Managed deployment environment: dev, stg, or prod.';
COMMENT ON COLUMN public.managed_apps.status IS 'Whether profile resolution is active or disabled for this app environment.';
COMMENT ON COLUMN public.managed_apps.created_at IS 'Timestamp when the managed app registration was created.';
COMMENT ON COLUMN public.managed_apps.updated_at IS 'Timestamp when the managed app registration was last updated.';

CREATE TABLE public.storage_providers (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL UNIQUE,
  provider_type text NOT NULL CHECK (provider_type IN ('minio', 'r2', 's3-compatible')),
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  secret_reference_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.storage_providers IS 'Non-secret provider identities and server-side credential pointer identities. Ref: z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02a-package-z-s-core-control-plane-and-provider-capability-baseline.md';
COMMENT ON COLUMN public.storage_providers.id IS 'Internal UUID primary key.';
COMMENT ON COLUMN public.storage_providers.provider_id IS 'Stable non-secret provider identifier.';
COMMENT ON COLUMN public.storage_providers.provider_type IS 'Provider family: MinIO, R2, or another S3-compatible service.';
COMMENT ON COLUMN public.storage_providers.status IS 'Whether this provider may be selected by profile resolution.';
COMMENT ON COLUMN public.storage_providers.secret_reference_id IS 'Approved non-secret pointer identity resolved only by the server-side secret boundary.';
COMMENT ON COLUMN public.storage_providers.created_at IS 'Timestamp when the provider registration was created.';
COMMENT ON COLUMN public.storage_providers.updated_at IS 'Timestamp when the provider registration was last updated.';

CREATE TABLE public.storage_profiles (
  id uuid PRIMARY KEY,
  managed_app_id uuid NOT NULL REFERENCES public.managed_apps(id) ON DELETE RESTRICT,
  profile_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'active', 'disabled')),
  effective_at timestamptz NOT NULL,
  retired_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (managed_app_id, profile_id, version),
  CHECK (retired_at IS NULL OR retired_at >= effective_at)
);

CREATE UNIQUE INDEX storage_profiles_one_active_version_idx
  ON public.storage_profiles (managed_app_id, profile_id)
  WHERE status = 'active';

COMMENT ON TABLE public.storage_profiles IS 'Versioned storage profiles scoped to one managed app environment. Ref: z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02a-package-z-s-core-control-plane-and-provider-capability-baseline.md';
COMMENT ON COLUMN public.storage_profiles.id IS 'Internal UUID primary key for one profile version.';
COMMENT ON COLUMN public.storage_profiles.managed_app_id IS 'Managed app environment that owns this profile version.';
COMMENT ON COLUMN public.storage_profiles.profile_id IS 'Stable profile identifier shared across versions.';
COMMENT ON COLUMN public.storage_profiles.version IS 'Positive monotonically managed profile version.';
COMMENT ON COLUMN public.storage_profiles.status IS 'Draft, active, or disabled profile-version state.';
COMMENT ON COLUMN public.storage_profiles.effective_at IS 'Earliest time this profile version may be considered effective.';
COMMENT ON COLUMN public.storage_profiles.retired_at IS 'Optional retirement time for this profile version.';
COMMENT ON COLUMN public.storage_profiles.created_at IS 'Timestamp when the profile version was created.';
COMMENT ON COLUMN public.storage_profiles.updated_at IS 'Timestamp when the profile version was last updated.';

CREATE TABLE public.storage_profile_provider_bindings (
  id uuid PRIMARY KEY,
  storage_profile_id uuid NOT NULL REFERENCES public.storage_profiles(id) ON DELETE CASCADE,
  provider_role text NOT NULL CHECK (provider_role IN ('hot', 'canonical')),
  storage_provider_id uuid NOT NULL REFERENCES public.storage_providers(id) ON DELETE RESTRICT,
  bucket_label text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_profile_id, provider_role),
  CHECK (bucket_label = lower(bucket_label)),
  CHECK (bucket_label !~ '[[:space:]]')
);

COMMENT ON TABLE public.storage_profile_provider_bindings IS 'Provider role and bucket bindings for one exact storage profile version. Ref: z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02a-package-z-s-core-control-plane-and-provider-capability-baseline.md';
COMMENT ON COLUMN public.storage_profile_provider_bindings.id IS 'Internal UUID primary key.';
COMMENT ON COLUMN public.storage_profile_provider_bindings.storage_profile_id IS 'Exact storage profile version receiving the binding.';
COMMENT ON COLUMN public.storage_profile_provider_bindings.provider_role IS 'Provider responsibility: hot or canonical.';
COMMENT ON COLUMN public.storage_profile_provider_bindings.storage_provider_id IS 'Registered provider selected for this role.';
COMMENT ON COLUMN public.storage_profile_provider_bindings.bucket_label IS 'Approved non-secret bucket label for this profile role.';
COMMENT ON COLUMN public.storage_profile_provider_bindings.required IS 'Whether capability readiness and assignment require this binding.';
COMMENT ON COLUMN public.storage_profile_provider_bindings.created_at IS 'Timestamp when the provider binding was created.';
COMMENT ON COLUMN public.storage_profile_provider_bindings.updated_at IS 'Timestamp when the provider binding was last updated.';

CREATE TABLE public.storage_prefix_classes (
  id uuid PRIMARY KEY,
  storage_profile_id uuid NOT NULL REFERENCES public.storage_profiles(id) ON DELETE CASCADE,
  prefix_class_id text NOT NULL,
  operation_class text NOT NULL CHECK (operation_class IN ('user-upload', 'generated-asset', 'private-document', 'capability-probe')),
  normalized_prefix_pattern text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_profile_id, prefix_class_id),
  CHECK (normalized_prefix_pattern LIKE '%/*'),
  CHECK (normalized_prefix_pattern !~ '(^/|\\|\.\.)')
);

CREATE UNIQUE INDEX storage_prefix_classes_one_active_operation_idx
  ON public.storage_prefix_classes (storage_profile_id, operation_class)
  WHERE status = 'active';

COMMENT ON TABLE public.storage_prefix_classes IS 'Exact normalized prefix classes authorized for profile operation classes. Ref: z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02a-package-z-s-core-control-plane-and-provider-capability-baseline.md';
COMMENT ON COLUMN public.storage_prefix_classes.id IS 'Internal UUID primary key.';
COMMENT ON COLUMN public.storage_prefix_classes.storage_profile_id IS 'Exact storage profile version that owns this prefix class.';
COMMENT ON COLUMN public.storage_prefix_classes.prefix_class_id IS 'Stable non-secret prefix class identifier.';
COMMENT ON COLUMN public.storage_prefix_classes.operation_class IS 'Consumer operation class authorized by the prefix.';
COMMENT ON COLUMN public.storage_prefix_classes.normalized_prefix_pattern IS 'Normalized wildcard prefix pattern without a raw object key or sensitive value.';
COMMENT ON COLUMN public.storage_prefix_classes.status IS 'Whether this prefix class may be resolved.';
COMMENT ON COLUMN public.storage_prefix_classes.created_at IS 'Timestamp when the prefix class was created.';
COMMENT ON COLUMN public.storage_prefix_classes.updated_at IS 'Timestamp when the prefix class was last updated.';

CREATE TABLE public.storage_capability_results (
  id uuid PRIMARY KEY,
  capability_run_id text NOT NULL,
  storage_profile_id uuid NOT NULL REFERENCES public.storage_profiles(id) ON DELETE CASCADE,
  storage_provider_id uuid NOT NULL REFERENCES public.storage_providers(id) ON DELETE RESTRICT,
  bucket_label text NOT NULL,
  prefix_class_id text NOT NULL,
  capability text NOT NULL CHECK (capability IN ('put', 'head', 'get', 'delete', 'checksum', 'size', 'range')),
  result text NOT NULL CHECK (result IN ('passed', 'failed', 'not-supported')),
  verified_at timestamptz NOT NULL,
  expires_at timestamptz NULL,
  safe_evidence_ref text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capability_run_id, storage_provider_id, prefix_class_id, capability),
  CHECK (expires_at IS NULL OR expires_at > verified_at)
);

CREATE INDEX storage_capability_results_readiness_idx
  ON public.storage_capability_results (
    storage_profile_id,
    storage_provider_id,
    bucket_label,
    prefix_class_id,
    capability,
    verified_at DESC
  );

COMMENT ON TABLE public.storage_capability_results IS 'Dated non-secret capability results for exact profile, provider, bucket, and prefix assignments. Ref: z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02a-package-z-s-core-control-plane-and-provider-capability-baseline.md';
COMMENT ON COLUMN public.storage_capability_results.id IS 'Internal UUID primary key.';
COMMENT ON COLUMN public.storage_capability_results.capability_run_id IS 'Stable identifier for one bounded capability verification run.';
COMMENT ON COLUMN public.storage_capability_results.storage_profile_id IS 'Exact storage profile version tested by the run.';
COMMENT ON COLUMN public.storage_capability_results.storage_provider_id IS 'Registered provider tested by the run.';
COMMENT ON COLUMN public.storage_capability_results.bucket_label IS 'Approved bucket label tested by the run.';
COMMENT ON COLUMN public.storage_capability_results.prefix_class_id IS 'Registered prefix class tested by the run.';
COMMENT ON COLUMN public.storage_capability_results.capability IS 'Tested provider capability.';
COMMENT ON COLUMN public.storage_capability_results.result IS 'Passed, failed, or explicitly not-supported result.';
COMMENT ON COLUMN public.storage_capability_results.verified_at IS 'Time when the capability result was verified.';
COMMENT ON COLUMN public.storage_capability_results.expires_at IS 'Optional time after which the result is no longer readiness evidence.';
COMMENT ON COLUMN public.storage_capability_results.safe_evidence_ref IS 'Optional non-secret reference to bounded evidence without provider-private responses.';
COMMENT ON COLUMN public.storage_capability_results.created_at IS 'Timestamp when the capability result record was created.';

CREATE TABLE public.storage_profile_audit_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  profile_id text NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version > 0),
  actor_role text NOT NULL,
  safe_change_summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX storage_profile_audit_events_profile_idx
  ON public.storage_profile_audit_events (profile_id, profile_version, created_at DESC);

COMMENT ON TABLE public.storage_profile_audit_events IS 'Non-secret audit history for profile and assignment changes. Ref: z-kn/08-execution/zimspace-storage-server-dev/tasks/in-progress/storage-platform-development/02a-package-z-s-core-control-plane-and-provider-capability-baseline.md';
COMMENT ON COLUMN public.storage_profile_audit_events.id IS 'Internal UUID primary key.';
COMMENT ON COLUMN public.storage_profile_audit_events.event_type IS 'Safe event category for the profile change.';
COMMENT ON COLUMN public.storage_profile_audit_events.profile_id IS 'Stable profile identifier affected by the event.';
COMMENT ON COLUMN public.storage_profile_audit_events.profile_version IS 'Positive profile version affected by the event.';
COMMENT ON COLUMN public.storage_profile_audit_events.actor_role IS 'Approved operational role responsible for the change.';
COMMENT ON COLUMN public.storage_profile_audit_events.safe_change_summary IS 'Concise non-secret change summary without requests, object content, or credential material.';
COMMENT ON COLUMN public.storage_profile_audit_events.created_at IS 'Timestamp when the audit event was recorded.';

COMMIT;
