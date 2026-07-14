BEGIN;

INSERT INTO public.managed_apps (
  id,
  app_id,
  environment,
  status,
  created_at,
  updated_at
) VALUES (
  '00000000-0000-4000-8000-000000000101',
  'video-maker_app',
  'dev',
  'active',
  '2026-07-14T00:00:00Z',
  '2026-07-14T00:00:00Z'
)
ON CONFLICT (app_id, environment) DO UPDATE SET
  status = EXCLUDED.status,
  updated_at = EXCLUDED.updated_at;

INSERT INTO public.storage_providers (
  id,
  provider_id,
  provider_type,
  status,
  secret_reference_id,
  created_at,
  updated_at
) VALUES
  (
    '00000000-0000-4000-8000-000000000201',
    'r2_video_maker_dev_01',
    'r2',
    'active',
    'credential-binding:r2_video_maker_dev_01',
    '2026-07-14T00:00:00Z',
    '2026-07-14T00:00:00Z'
  ),
  (
    '00000000-0000-4000-8000-000000000202',
    'minio_zimspace_local_pc_01',
    'minio',
    'active',
    'credential-binding:minio_zimspace_local_pc_01',
    '2026-07-14T00:00:00Z',
    '2026-07-14T00:00:00Z'
  )
ON CONFLICT (provider_id) DO UPDATE SET
  provider_type = EXCLUDED.provider_type,
  status = EXCLUDED.status,
  secret_reference_id = EXCLUDED.secret_reference_id,
  updated_at = EXCLUDED.updated_at;

INSERT INTO public.storage_profiles (
  id,
  managed_app_id,
  profile_id,
  version,
  status,
  effective_at,
  retired_at,
  created_at,
  updated_at
)
SELECT
  '00000000-0000-4000-8000-000000000301',
  managed.id,
  'video-maker-dev-default',
  1,
  'active',
  '2026-07-14T00:00:00Z',
  NULL,
  '2026-07-14T00:00:00Z',
  '2026-07-14T00:00:00Z'
FROM public.managed_apps AS managed
WHERE managed.app_id = 'video-maker_app' AND managed.environment = 'dev'
ON CONFLICT (managed_app_id, profile_id, version) DO UPDATE SET
  status = EXCLUDED.status,
  effective_at = EXCLUDED.effective_at,
  retired_at = EXCLUDED.retired_at,
  updated_at = EXCLUDED.updated_at;

INSERT INTO public.storage_profiles (
  id,
  managed_app_id,
  profile_id,
  version,
  status,
  effective_at,
  retired_at,
  created_at,
  updated_at
)
SELECT
  '00000000-0000-4000-8000-000000000302',
  managed.id,
  'video-maker-dev-private',
  1,
  'active',
  '2026-07-14T00:00:00Z',
  NULL,
  '2026-07-14T00:00:00Z',
  '2026-07-14T00:00:00Z'
FROM public.managed_apps AS managed
WHERE managed.app_id = 'video-maker_app' AND managed.environment = 'dev'
ON CONFLICT (managed_app_id, profile_id, version) DO UPDATE SET
  status = EXCLUDED.status,
  effective_at = EXCLUDED.effective_at,
  retired_at = EXCLUDED.retired_at,
  updated_at = EXCLUDED.updated_at;

INSERT INTO public.storage_profile_provider_bindings (
  id,
  storage_profile_id,
  provider_role,
  storage_provider_id,
  bucket_label,
  required,
  created_at,
  updated_at
)
SELECT
  '00000000-0000-4000-8000-000000000401',
  profile.id,
  'hot',
  provider.id,
  'video-maker-hot',
  true,
  '2026-07-14T00:00:00Z',
  '2026-07-14T00:00:00Z'
FROM public.storage_profiles AS profile
JOIN public.managed_apps AS managed ON managed.id = profile.managed_app_id
JOIN public.storage_providers AS provider ON provider.provider_id = 'r2_video_maker_dev_01'
WHERE managed.app_id = 'video-maker_app'
  AND managed.environment = 'dev'
  AND profile.profile_id = 'video-maker-dev-default'
  AND profile.version = 1
ON CONFLICT (storage_profile_id, provider_role) DO UPDATE SET
  storage_provider_id = EXCLUDED.storage_provider_id,
  bucket_label = EXCLUDED.bucket_label,
  required = EXCLUDED.required,
  updated_at = EXCLUDED.updated_at;

INSERT INTO public.storage_profile_provider_bindings (
  id,
  storage_profile_id,
  provider_role,
  storage_provider_id,
  bucket_label,
  required,
  created_at,
  updated_at
)
SELECT
  '00000000-0000-4000-8000-000000000402',
  profile.id,
  'canonical',
  provider.id,
  'zs-dev-app-video-maker-canon',
  true,
  '2026-07-14T00:00:00Z',
  '2026-07-14T00:00:00Z'
FROM public.storage_profiles AS profile
JOIN public.managed_apps AS managed ON managed.id = profile.managed_app_id
JOIN public.storage_providers AS provider ON provider.provider_id = 'minio_zimspace_local_pc_01'
WHERE managed.app_id = 'video-maker_app'
  AND managed.environment = 'dev'
  AND profile.profile_id = 'video-maker-dev-default'
  AND profile.version = 1
ON CONFLICT (storage_profile_id, provider_role) DO UPDATE SET
  storage_provider_id = EXCLUDED.storage_provider_id,
  bucket_label = EXCLUDED.bucket_label,
  required = EXCLUDED.required,
  updated_at = EXCLUDED.updated_at;

INSERT INTO public.storage_profile_provider_bindings (
  id,
  storage_profile_id,
  provider_role,
  storage_provider_id,
  bucket_label,
  required,
  created_at,
  updated_at
)
SELECT
  '00000000-0000-4000-8000-000000000403',
  profile.id,
  'canonical',
  provider.id,
  'zs-dev-app-video-maker-private',
  true,
  '2026-07-14T00:00:00Z',
  '2026-07-14T00:00:00Z'
FROM public.storage_profiles AS profile
JOIN public.managed_apps AS managed ON managed.id = profile.managed_app_id
JOIN public.storage_providers AS provider ON provider.provider_id = 'minio_zimspace_local_pc_01'
WHERE managed.app_id = 'video-maker_app'
  AND managed.environment = 'dev'
  AND profile.profile_id = 'video-maker-dev-private'
  AND profile.version = 1
ON CONFLICT (storage_profile_id, provider_role) DO UPDATE SET
  storage_provider_id = EXCLUDED.storage_provider_id,
  bucket_label = EXCLUDED.bucket_label,
  required = EXCLUDED.required,
  updated_at = EXCLUDED.updated_at;

INSERT INTO public.storage_prefix_classes (
  id,
  storage_profile_id,
  prefix_class_id,
  operation_class,
  normalized_prefix_pattern,
  status,
  created_at,
  updated_at
)
SELECT
  '00000000-0000-4000-8000-000000000501',
  profile.id,
  'video-maker-user-resource',
  'user-upload',
  'video-maker/user-resources/*',
  'active',
  '2026-07-14T00:00:00Z',
  '2026-07-14T00:00:00Z'
FROM public.storage_profiles AS profile
JOIN public.managed_apps AS managed ON managed.id = profile.managed_app_id
WHERE managed.app_id = 'video-maker_app'
  AND managed.environment = 'dev'
  AND profile.profile_id = 'video-maker-dev-default'
  AND profile.version = 1
ON CONFLICT (storage_profile_id, prefix_class_id) DO UPDATE SET
  operation_class = EXCLUDED.operation_class,
  normalized_prefix_pattern = EXCLUDED.normalized_prefix_pattern,
  status = EXCLUDED.status,
  updated_at = EXCLUDED.updated_at;

INSERT INTO public.storage_prefix_classes (
  id,
  storage_profile_id,
  prefix_class_id,
  operation_class,
  normalized_prefix_pattern,
  status,
  created_at,
  updated_at
)
SELECT
  '00000000-0000-4000-8000-000000000502',
  profile.id,
  'video-maker-capability-probe',
  'capability-probe',
  'video-maker/user-resources/capability/*',
  'active',
  '2026-07-14T00:00:00Z',
  '2026-07-14T00:00:00Z'
FROM public.storage_profiles AS profile
JOIN public.managed_apps AS managed ON managed.id = profile.managed_app_id
WHERE managed.app_id = 'video-maker_app'
  AND managed.environment = 'dev'
  AND profile.profile_id = 'video-maker-dev-default'
  AND profile.version = 1
ON CONFLICT (storage_profile_id, prefix_class_id) DO UPDATE SET
  operation_class = EXCLUDED.operation_class,
  normalized_prefix_pattern = EXCLUDED.normalized_prefix_pattern,
  status = EXCLUDED.status,
  updated_at = EXCLUDED.updated_at;

COMMIT;
