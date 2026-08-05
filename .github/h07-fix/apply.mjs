import { readFile, writeFile } from 'node:fs/promises';

async function replace(path, before, after) {
  const content = await readFile(path, 'utf8');
  if (!content.includes(before)) throw new Error(`missing replacement anchor: ${path}`);
  await writeFile(path, content.replace(before, after), 'utf8');
}

const packagePath = 'package.json';
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
packageJson.scripts['test:storage-services'] = `${packageJson.scripts['test:storage-services']} .test-dist/tests/storage-service-credential-resolver.test.js`;
packageJson.scripts.test = 'npm run test:compile && node --test --test-concurrency=1 .test-dist/tests/*.test.js';
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

await replace(
  'src/client-control-composition.ts',
  "import { S3CompatibleProviderObjectWriter } from './runtime-s3-provider.js';",
  "import {\n  type ProviderCredentialResolver,\n  S3CompatibleProviderObjectWriter,\n} from './runtime-s3-provider.js';",
);
await replace(
  'src/client-control-composition.ts',
  '  readonly storageService: StorageServiceApplicationService | null;\n  readonly imageDerivativeStore: ImageDerivativeStore;',
  '  readonly storageService: StorageServiceApplicationService | null;\n  readonly credentialResolver: ProviderCredentialResolver;\n  readonly imageDerivativeStore: ImageDerivativeStore;',
);
await replace(
  'src/client-control-composition.ts',
  '): ClientControlComposition {\n  const postgresUrl = optionalString(environment.Z_S_POSTGRES_URL);',
  `): ClientControlComposition {\n  const managedCredentialResolver = createRuntimeProviderCredentialResolver(\n    optionalString(environment.Z_S_PROVIDER_CREDENTIAL_BINDINGS_JSON),\n  );\n  const postgresUrl = optionalString(environment.Z_S_POSTGRES_URL);`,
);
await replace(
  'src/client-control-composition.ts',
  '      storageService: null,\n      imageDerivativeStore:',
  '      storageService: null,\n      credentialResolver: managedCredentialResolver,\n      imageDerivativeStore:',
);
await replace(
  'src/client-control-composition.ts',
  `  const managedCredentialResolver = createRuntimeProviderCredentialResolver(\n    optionalString(environment.Z_S_PROVIDER_CREDENTIAL_BINDINGS_JSON),\n  );\n  const credentialResolver = new StorageServiceProviderCredentialResolver({`,
  '  const credentialResolver = new StorageServiceProviderCredentialResolver({',
);
await replace(
  'src/client-control-composition.ts',
  '    configurationStore,\n    storageService,\n    imageDerivativeStore,',
  '    configurationStore,\n    storageService,\n    credentialResolver,\n    imageDerivativeStore,',
);

await replace(
  'src/runtime-control-composition.ts',
  `  const composition = createVideoMakerRuntimeComposition(environment);\n  const clientControl = createClientControlComposition(environment);`,
  `  const clientControl = createClientControlComposition(environment);\n  const composition = createVideoMakerRuntimeComposition(\n    environment,\n    clientControl.credentialResolver,\n  );`,
);

await replace(
  'src/runtime-local-composition.ts',
  `export function createVideoMakerRuntimeComposition(\n  environment: NodeJS.ProcessEnv = process.env,\n): VideoMakerRuntimeComposition {`,
  `export function createVideoMakerRuntimeComposition(\n  environment: NodeJS.ProcessEnv = process.env,\n  credentialResolverOverride?: ProviderCredentialResolver,\n): VideoMakerRuntimeComposition {`,
);
await replace(
  'src/runtime-local-composition.ts',
  `  const credentialResolver = createRuntimeProviderCredentialResolver(\n    configuration.providerCredentialBindingsJson,\n  );`,
  `  const credentialResolver = credentialResolverOverride ??\n    createRuntimeProviderCredentialResolver(configuration.providerCredentialBindingsJson);`,
);
await replace(
  'src/runtime-local-composition.ts',
  `function validSigningKey(value: string | undefined): value is string {`,
  `function providerCredentialResolverConfigured(\n  resolver: ProviderCredentialResolver,\n): boolean {\n  const configured = (resolver as { readonly configured?: unknown }).configured;\n  return configured === undefined || configured === true;\n}\n\nfunction validSigningKey(value: string | undefined): value is string {`,
);
await replace(
  'src/runtime-local-composition.ts',
  '      if (!credentialResolver.configured) {',
  '      if (!providerCredentialResolverConfigured(credentialResolver)) {',
);

await replace(
  'src/storage-service-credential-resolver.ts',
  `export class StorageServiceProviderCredentialResolver\nimplements ProviderCredentialResolver {`,
  `export class StorageServiceProviderCredentialResolver\nimplements ProviderCredentialResolver {\n  readonly configured: boolean;`,
);
await replace(
  'src/storage-service-credential-resolver.ts',
  `    this.#services = options.services;\n    this.#secrets = options.secrets;`,
  `    const managedConfigured = (options.managedResolver as {\n      readonly configured?: unknown;\n    }).configured;\n    this.configured = options.secrets.configured || managedConfigured === true;\n    this.#services = options.services;\n    this.#secrets = options.secrets;`,
);

const h07Scope = "|src/(client-storage-configuration-safe|cloudflare-r2-adapter|provider-secret-store(-postgres)?|storage-provider-adapter|storage-service(-[a-z-]+)?)\\.ts|tests/(client-storage-configuration-safe|cloudflare-r2-adapter|provider-secret-store|storage-service(-credential-resolver|-presentation|-migration)?)\\.test\\.ts|scripts/validate-storage-service-migration\\.mjs|db/migrations/0012_z_s_storage_services(\\.down)?\\.sql|docs/storage-services\\.md|reports/t2-h07-storage-services/[^/]+\\.md|evidence/t2-h07-storage-services/.+|\\.github/workflows/t2-h07-storage-service-management-validation\\.yml";
for (const path of [
  '.github/workflows/2b-05-write-intent-ingest-validation.yml',
  '.github/workflows/2b-06-dual-provider-media-validation.yml',
  '.github/workflows/2b-07-read-delivery-validation.yml',
  '.github/workflows/t2-h05-image-derivative-validation.yml',
]) {
  const content = await readFile(path, 'utf8');
  const lines = content.split('\n');
  const index = lines.findIndex((line) => line.includes("allowed='^(") && line.endsWith(")$'"));
  if (index < 0) throw new Error(`missing scope allowlist: ${path}`);
  lines[index] = lines[index].replace(")$'", `${h07Scope})$'`);
  await writeFile(path, lines.join('\n'), 'utf8');
}

// Trigger the completion workflow after its definition exists on the branch.
