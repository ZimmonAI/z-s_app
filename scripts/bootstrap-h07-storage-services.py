from __future__ import annotations

import base64
import io
import json
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

PAYLOAD_DIR = ROOT / '.h07-bootstrap'



def extract_payload() -> None:
    encoded = ''.join(path.read_text(encoding='ascii').strip() for path in sorted(PAYLOAD_DIR.glob('chunk-*')))
    if not encoded:
        raise RuntimeError('H07 payload chunks are unavailable')
    raw = base64.b64decode(encoded, validate=True)
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        for member in archive.getmembers():
            member_path = Path(member.name)
            if member_path.is_absolute() or '..' in member_path.parts:
                raise RuntimeError(f'unsafe payload path: {member.name}')
        archive.extractall(ROOT, filter='data')


extract_payload()


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def write(path: str, content: str) -> None:
    if not content.endswith('\n'):
        content += '\n'
    (ROOT / path).write_text(content, encoding='utf-8')


def replace_once(content: str, old: str, new: str, path: str) -> str:
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f'{path}: expected one match, found {count}: {old[:100]!r}')
    return content.replace(old, new, 1)


def insert_once(content: str, marker: str, addition: str, path: str) -> str:
    return replace_once(content, marker, marker + addition, path)


# Browser request parsing: storage-service selection is safe metadata; internal secret references are server-owned.
path = 'src/client-storage-control-request.ts'
content = read(path)
start = content.index('function providerConnection(')
end = content.index('\nfunction configurationVault(', start)
replacement = '''function providerConnection(value: unknown): ProviderConnectionInput {
  const record = objectValue(value, 'invalid-provider-connection');
  const providerType = stringValue(record.providerType, 'invalid-provider-type');
  if (providerType !== 'minio' && providerType !== 'r2' && providerType !== 's3-compatible') {
    throw new ClientStorageConfigurationError(400, 'invalid-provider-type');
  }
  const safeMetadata = optionalRecord(record.safeMetadata, 'invalid-safe-metadata');
  const storageServiceId = typeof safeMetadata?.storageServiceId === 'string'
    ? safeMetadata.storageServiceId
    : undefined;
  return Object.freeze({
    connectionId: stringValue(record.connectionId, 'invalid-provider-connection-id'),
    displayLabel: stringValue(record.displayLabel, 'invalid-provider-connection-label'),
    providerType,
    secretReferenceId: '',
    ...(safeMetadata === undefined
      ? {}
      : {
        safeMetadata: Object.freeze({
          ...safeMetadata,
          ...(storageServiceId === undefined ? {} : { storageServiceId }),
        }),
      }),
  });
}
'''
content = content[:start] + replacement + content[end:]
write(path, content)

# Canonical S3 writer uses a privately resolved bucket while retaining the safe configuration label.
path = 'src/runtime-s3-provider.ts'
content = read(path)
content = replace_once(
    content,
    "  sessionToken?: string;\n}",
    "  sessionToken?: string;\n  bucketOverride?: string;\n}",
    path,
)
content = replace_once(
    content,
    "    const binding = await this.#resolver.resolve(input.target.credentialSecretReferenceId);\n    const client = this.#createClient(clientConfig(binding));",
    "    const binding = await this.#resolver.resolve(input.target.credentialSecretReferenceId);\n    const bucketLabel = binding.bucketOverride ?? input.target.bucketLabel;\n    const client = this.#createClient(clientConfig(binding));",
    path,
)
content = content.replace('Bucket: input.target.bucketLabel,', 'Bucket: bucketLabel,')
content = content.replace('expectedBucketLabel: input.target.bucketLabel,', 'expectedBucketLabel: bucketLabel,')
content = content.replace('observedBucketLabel: input.target.bucketLabel,', 'observedBucketLabel: bucketLabel,')
content = replace_once(
    content,
    "    const client = this.#createClient(clientConfig(binding));\n    try {\n      await client.send(\n        new DeleteObjectCommand({",
    "    const bucketLabel = binding.bucketOverride ?? input.target.bucketLabel;\n    const client = this.#createClient(clientConfig(binding));\n    try {\n      await client.send(\n        new DeleteObjectCommand({",
    path,
)
write(path, content)

# Canonical S3 reader applies the same private bucket resolution for HEAD/GET.
path = 'src/runtime-read-delivery.ts'
content = read(path)
needle = "      const binding = await this.#resolver.resolve(input.target.credentialSecretReferenceId);\n      client = this.#createClient(clientConfig(binding));"
replacement = "      const binding = await this.#resolver.resolve(input.target.credentialSecretReferenceId);\n      const bucketLabel = binding.bucketOverride ?? input.target.bucketLabel;\n      client = this.#createClient(clientConfig(binding));"
if content.count(needle) != 2:
    raise RuntimeError(f'{path}: expected two reader resolver matches, found {content.count(needle)}')
content = content.replace(needle, replacement)
content = content.replace('Bucket: input.target.bucketLabel,', 'Bucket: bucketLabel,')
write(path, content)

# Runtime composition uses a provider-neutral composite resolver for managed and client-owned services.
path = 'src/runtime-local-composition.ts'
content = read(path)
content = insert_once(
    content,
    "import { PostgresClientStorageConfigurationStore } from './client-storage-configuration-postgres.js';\n",
    "import {\n  composeStorageServiceCredentialResolver,\n  createPostgresStorageServiceComposition,\n  createUnavailableStorageServiceComposition,\n} from './storage-service-composition.js';\n",
    path,
)
content = replace_once(
    content,
    """  const pool = createPool(configuration);
  const credentialResolver = createRuntimeProviderCredentialResolver(
    configuration.providerCredentialBindingsJson,
  );
""",
    """  const pool = createPool(configuration);
  const managedCredentialResolver = createRuntimeProviderCredentialResolver(
    configuration.providerCredentialBindingsJson,
  );
  const storageServices = configuration.postgresUrl === undefined
    ? createUnavailableStorageServiceComposition()
    : createPostgresStorageServiceComposition({
      pool,
      queryable: pool,
      environment,
    });
  const credentialResolver = composeStorageServiceCredentialResolver({
    managed: managedCredentialResolver,
    clientOwned: storageServices.credentialResolver,
  });
""",
    path,
)
write(path, content)

# Client control composition owns the UI application and reuses the same composite resolver for derivatives.
path = 'src/client-control-composition.ts'
content = read(path)
content = insert_once(
    content,
    "import { PostgresClientStorageConfigurationStore } from './client-storage-configuration-postgres.js';\n",
    "import { StorageServiceConfigurationStore } from './storage-service-configuration.js';\nimport {\n  composeStorageServiceCredentialResolver,\n  createPostgresStorageServiceComposition,\n  createUnavailableStorageServiceComposition,\n} from './storage-service-composition.js';\nimport type { StorageServiceApplication } from './storage-service-application.js';\n",
    path,
)
content = replace_once(
    content,
    """  readonly configurationStore: ClientStorageConfigurationStore;
  readonly imageDerivativeStore: ImageDerivativeStore;
""",
    """  readonly configurationStore: StorageServiceConfigurationStore;
  readonly storageServices: StorageServiceApplication;
  readonly imageDerivativeStore: ImageDerivativeStore;
""",
    path,
)
content = replace_once(
    content,
    """  if (postgresUrl === undefined) {
    return Object.freeze({
      authenticator: createUnavailableClientCredentialAuthenticator(),
      configurationStore: createUnavailableClientStorageConfigurationStore(),
      imageDerivativeStore: createUnavailableImageDerivativeStore(),
      imageDerivativeWorker: null,
      async close(): Promise<void> {},
    });
  }
""",
    """  if (postgresUrl === undefined) {
    const storageServices = createUnavailableStorageServiceComposition();
    return Object.freeze({
      authenticator: createUnavailableClientCredentialAuthenticator(),
      configurationStore: new StorageServiceConfigurationStore({
        base: createUnavailableClientStorageConfigurationStore(),
        services: storageServices.application,
      }),
      storageServices: storageServices.application,
      imageDerivativeStore: createUnavailableImageDerivativeStore(),
      imageDerivativeWorker: null,
      async close(): Promise<void> {},
    });
  }
""",
    path,
)
content = replace_once(
    content,
    """  const imageDerivativeStore = new PostgresImageDerivativeStore(queryable);
  const credentialResolver = createRuntimeProviderCredentialResolver(
    optionalString(environment.Z_S_PROVIDER_CREDENTIAL_BINDINGS_JSON),
  );
""",
    """  const imageDerivativeStore = new PostgresImageDerivativeStore(queryable);
  const storageServices = createPostgresStorageServiceComposition({
    pool: queryable,
    queryable,
    environment,
  });
  const credentialResolver = composeStorageServiceCredentialResolver({
    managed: createRuntimeProviderCredentialResolver(
      optionalString(environment.Z_S_PROVIDER_CREDENTIAL_BINDINGS_JSON),
    ),
    clientOwned: storageServices.credentialResolver,
  });
  const configurationStore = new StorageServiceConfigurationStore({
    base: new PostgresClientStorageConfigurationStore(queryable),
    services: storageServices.application,
  });
""",
    path,
)
content = replace_once(
    content,
    """    authenticator: new PostgresStorageControlClientCredentialAuthenticator(queryable),
    configurationStore: new PostgresClientStorageConfigurationStore(queryable),
    imageDerivativeStore,
""",
    """    authenticator: new PostgresStorageControlClientCredentialAuthenticator(queryable),
    configurationStore,
    storageServices: storageServices.application,
    imageDerivativeStore,
""",
    path,
)
# Remove now-unused interface import while retaining unavailable factory.
content = content.replace(',\n  type ClientStorageConfigurationStore,', ',')
write(path, content)

# Route composition adds the storage-service browser adapter around the existing control surface.
path = 'src/runtime-control-composition.ts'
content = read(path)
content = replace_once(
    content,
    "import type { ClientStorageConfigurationStore } from './client-storage-configuration.js';\n",
    "import { StorageServiceConfigurationStore } from './storage-service-configuration.js';\nimport type { StorageServiceApplication } from './storage-service-application.js';\nimport { createStorageServiceControlRuntime } from './storage-service-control-runtime.js';\n",
    path,
)
content = replace_once(
    content,
    """  clientStorageConfigurationStore: ClientStorageConfigurationStore,
  imageDerivativeStore: ImageDerivativeStore,
""",
    """  clientStorageConfigurationStore: StorageServiceConfigurationStore,
  storageServices: StorageServiceApplication,
  imageDerivativeStore: ImageDerivativeStore,
""",
    path,
)
content = replace_once(
    content,
    """  const control = createControlPlaneUiRuntime(runtime, {
    clientCredentialAuthenticator,
    clientStorageConfigurationStore,
    ...(adminPassword === undefined ? {} : { adminPassword }),
    ...(sessionSigningKey === undefined ? {} : { sessionSigningKey }),
  });
  return createImageDerivativeRuntime(control, {
""",
    """  const control = createControlPlaneUiRuntime(runtime, {
    clientCredentialAuthenticator,
    clientStorageConfigurationStore,
    ...(adminPassword === undefined ? {} : { adminPassword }),
    ...(sessionSigningKey === undefined ? {} : { sessionSigningKey }),
  });
  const storageServiceControl = createStorageServiceControlRuntime(control, {
    application: storageServices,
    configurationStore: clientStorageConfigurationStore,
    ...(sessionSigningKey === undefined ? {} : { sessionSigningKey }),
  });
  return createImageDerivativeRuntime(storageServiceControl, {
""",
    path,
)
content = replace_once(
    content,
    """      clientControl.configurationStore,
      clientControl.imageDerivativeStore,
""",
    """      clientControl.configurationStore,
      clientControl.storageServices,
      clientControl.imageDerivativeStore,
""",
    path,
)
write(path, content)

# Public package exports the canonical storage-service/platform contracts.
path = 'src/index.ts'
content = read(path)
exports = [
    "export * from './provider-secret-store.js';",
    "export * from './provider-secret-store-postgres.js';",
    "export * from './storage-provider-adapter.js';",
    "export * from './storage-provider-cloudflare-r2.js';",
    "export * from './storage-provider-registry.js';",
    "export * from './storage-service.js';",
    "export * from './storage-service-application.js';",
    "export * from './storage-service-configuration.js';",
    "export * from './storage-service-reference.js';",
    "export * from './storage-service-runtime.js';",
]
for line in exports:
    if line not in content:
        content += line + '\n'
write(path, content)

# Exact package contents and validation commands.
path = 'package.json'
manifest = json.loads(read(path))
files = manifest['files']
for value in [
    'docs/storage-services.md',
    'db/migrations/0011_z_s_image_derivatives.sql',
    'db/migrations/0011_z_s_image_derivatives.down.sql',
    'db/migrations/0012_z_s_storage_services.sql',
    'db/migrations/0012_z_s_storage_services.down.sql',
]:
    if value not in files:
        files.append(value)
focused = manifest['scripts']['test:focused']
for test_file in [
    '.test-dist/tests/provider-secret-store.test.js',
    '.test-dist/tests/storage-provider-cloudflare-r2.test.js',
    '.test-dist/tests/storage-service-application.test.js',
    '.test-dist/tests/storage-service-configuration.test.js',
    '.test-dist/tests/storage-service-migration.test.js',
    '.test-dist/tests/storage-service-presentation.test.js',
]:
    if test_file not in focused:
        focused += f' {test_file}'
manifest['scripts']['test:focused'] = focused
migration = manifest['scripts']['validate:migration']
if 'validate-storage-service-migration.mjs' not in migration:
    migration += ' && node scripts/validate-storage-service-migration.mjs'
manifest['scripts']['validate:migration'] = migration
write(path, json.dumps(manifest, indent=2) + '\n')

# Package artifact allowlist follows the exact manifest additions.
path = 'scripts/verify-package-artifact.mjs'
content = read(path)
content = insert_once(
    content,
    "  'docs/runtime-contract.md',\n",
    "  'docs/storage-services.md',\n",
    path,
)
# This marker occurs in both expected arrays; append after each 0010 down entry.
marker = "  'db/migrations/0010_z_s_runtime_configuration_routing.down.sql',\n"
addition = "  'db/migrations/0011_z_s_image_derivatives.sql',\n  'db/migrations/0011_z_s_image_derivatives.down.sql',\n  'db/migrations/0012_z_s_storage_services.sql',\n  'db/migrations/0012_z_s_storage_services.down.sql',\n"
if content.count(marker) != 2:
    raise RuntimeError(f'{path}: expected two migration allowlist markers, found {content.count(marker)}')
content = content.replace(marker, marker + addition)
write(path, content)

# Package validation should run when H07 sources or migration change.
path = '.github/workflows/package-distribution-validation.yml'
content = read(path)
content = insert_once(
    content,
    "      - 'src/client-storage-configuration*.ts'\n",
    "      - 'src/provider-secret-store*.ts'\n      - 'src/storage-provider*.ts'\n      - 'src/storage-service*.ts'\n",
    path,
)
content = insert_once(
    content,
    "      - 'tests/client-storage-configuration*.test.ts'\n",
    "      - 'tests/provider-secret-store.test.ts'\n      - 'tests/storage-provider-cloudflare-r2.test.ts'\n      - 'tests/storage-service*.test.ts'\n",
    path,
)
content = insert_once(
    content,
    "      - 'scripts/validate-client-storage-configuration.mjs'\n",
    "      - 'scripts/validate-storage-service-migration.mjs'\n",
    path,
)
content = insert_once(
    content,
    "      - 'docs/runtime-contract.md'\n",
    "      - 'docs/storage-services.md'\n",
    path,
)
content = insert_once(
    content,
    "      - 'db/migrations/0005_z_s_client_storage_configuration.down.sql'\n",
    "      - 'db/migrations/0011_z_s_image_derivatives.sql'\n      - 'db/migrations/0011_z_s_image_derivatives.down.sql'\n      - 'db/migrations/0012_z_s_storage_services.sql'\n      - 'db/migrations/0012_z_s_storage_services.down.sql'\n",
    path,
)
write(path, content)

# Append source-facing documentation pointer without changing existing runtime claims.
path = 'README.md'
content = read(path)
section = '''
## Client storage services and Cloudflare R2

The authenticated client control center includes `/client/storage/services` and related setup,
workflow, dependency, and activity routes. Client-owned Cloudflare R2 credentials are accepted
once, encrypted with deployment-managed AES-256-GCM keys, bound to client/environment/service/provider
associated data, and never returned. Existing Z-s-managed MinIO/R2 bindings remain deployment-resolved.
See `docs/storage-services.md` for the source contract and H08 deployment handoff.
'''
if '## Client storage services and Cloudflare R2' not in content:
    content += section
write(path, content)

print('H07 source bootstrap patches applied')
