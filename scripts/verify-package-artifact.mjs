import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const EXPECTED_NAME = '@zimmonai/z-s-control-plane';
const EXPECTED_VERSION = '0.5.0';
const EXPECTED_REPOSITORY = 'git+https://github.com/ZimmonAI/z-s_app.git';
const EXPECTED_REGISTRY = 'https://npm.pkg.github.com';
const EXPECTED_EXPORTS = [
  '.',
  './runtime-contract',
  './runtime-service',
  './runtime-storage-registry',
  './runtime-read-delivery',
  './runtime-read-grant',
];
const EXPECTED_PACKAGE_FILES = [
  'dist',
  'README.md',
  'docs/runtime-contract.md',
  'docs/storage-services.md',
  'db/migrations/0002_z_s_runtime_registry.sql',
  'db/migrations/0002_z_s_runtime_registry.down.sql',
  'db/migrations/0003_z_s_read_delivery.sql',
  'db/migrations/0003_z_s_read_delivery.down.sql',
  'db/migrations/0004_z_s_storage_control_vaults.sql',
  'db/migrations/0004_z_s_storage_control_vaults.down.sql',
  'db/migrations/0005_z_s_client_storage_configuration.sql',
  'db/migrations/0005_z_s_client_storage_configuration.down.sql',
  'db/migrations/0006_z_s_configuration_audit_cleanup.sql',
  'db/migrations/0006_z_s_configuration_audit_cleanup.down.sql',
  'db/migrations/0007_z_s_configuration_child_cleanup.sql',
  'db/migrations/0007_z_s_configuration_child_cleanup.down.sql',
  'db/migrations/0008_z_s_configuration_audit_nullification.sql',
  'db/migrations/0008_z_s_configuration_audit_nullification.down.sql',
  'db/migrations/0009_z_s_configuration_child_fk_deferral.sql',
  'db/migrations/0009_z_s_configuration_child_fk_deferral.down.sql',
  'db/migrations/0010_z_s_runtime_configuration_routing.sql',
  'db/migrations/0010_z_s_runtime_configuration_routing.down.sql',
  'db/migrations/0011_z_s_image_derivatives.sql',
  'db/migrations/0011_z_s_image_derivatives.down.sql',
  'db/migrations/0012_z_s_storage_services.sql',
  'db/migrations/0012_z_s_storage_services.down.sql',
];
const EXPECTED_STATIC_ARTIFACT_FILES = [
  'README.md',
  'docs/runtime-contract.md',
  'docs/storage-services.md',
  'package.json',
  'db/migrations/0002_z_s_runtime_registry.sql',
  'db/migrations/0002_z_s_runtime_registry.down.sql',
  'db/migrations/0003_z_s_read_delivery.sql',
  'db/migrations/0003_z_s_read_delivery.down.sql',
  'db/migrations/0004_z_s_storage_control_vaults.sql',
  'db/migrations/0004_z_s_storage_control_vaults.down.sql',
  'db/migrations/0005_z_s_client_storage_configuration.sql',
  'db/migrations/0005_z_s_client_storage_configuration.down.sql',
  'db/migrations/0006_z_s_configuration_audit_cleanup.sql',
  'db/migrations/0006_z_s_configuration_audit_cleanup.down.sql',
  'db/migrations/0007_z_s_configuration_child_cleanup.sql',
  'db/migrations/0007_z_s_configuration_child_cleanup.down.sql',
  'db/migrations/0008_z_s_configuration_audit_nullification.sql',
  'db/migrations/0008_z_s_configuration_audit_nullification.down.sql',
  'db/migrations/0009_z_s_configuration_child_fk_deferral.sql',
  'db/migrations/0009_z_s_configuration_child_fk_deferral.down.sql',
  'db/migrations/0010_z_s_runtime_configuration_routing.sql',
  'db/migrations/0010_z_s_runtime_configuration_routing.down.sql',
  'db/migrations/0011_z_s_image_derivatives.sql',
  'db/migrations/0011_z_s_image_derivatives.down.sql',
  'db/migrations/0012_z_s_storage_services.sql',
  'db/migrations/0012_z_s_storage_services.down.sql',
];

async function sourceModuleNames(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const modules = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      modules.push(...await sourceModuleNames(path.join(directory, entry.name), relativePath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      modules.push(relativePath.slice(0, -3));
    }
  }
  return modules;
}

async function expectedFiles() {
  const files = [...EXPECTED_STATIC_ARTIFACT_FILES];
  const moduleNames = await sourceModuleNames(path.join(root, 'src'));
  for (const moduleName of moduleNames) {
    files.push(
      `dist/${moduleName}.d.ts`,
      `dist/${moduleName}.d.ts.map`,
      `dist/${moduleName}.js`,
      `dist/${moduleName}.js.map`,
    );
  }
  return files.sort();
}

function parseArguments(argv) {
  const options = { packJson: null, output: null, tarballRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--pack-json') options.packJson = argv[++index] ?? null;
    else if (value === '--output') options.output = argv[++index] ?? null;
    else if (value === '--tarball-root') options.tarballRoot = argv[++index] ?? null;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function normalizeRepository(repository) {
  if (typeof repository === 'string') return repository;
  if (repository && typeof repository.url === 'string') return repository.url;
  return null;
}

function assertExactManifest(manifest) {
  assert.equal(manifest.name, EXPECTED_NAME);
  assert.equal(manifest.version, EXPECTED_VERSION);
  assert.notEqual(manifest.private, true, 'npm private publication guard must be removed');
  assert.equal(normalizeRepository(manifest.repository), EXPECTED_REPOSITORY);
  assert.equal(manifest.publishConfig?.registry, EXPECTED_REGISTRY);
  assert.equal(manifest.publishConfig?.access, 'restricted');
  assert.deepEqual(Object.keys(manifest.exports ?? {}), EXPECTED_EXPORTS);
  assert.deepEqual(manifest.files, EXPECTED_PACKAGE_FILES);
  assert.equal(manifest.engines?.node, '>=22');
  assert.equal(manifest.scripts?.prepack, 'npm run build');
  assert.deepEqual(manifest.dependencies, { '@aws-sdk/client-s3': '3.1088.0' });
  for (const field of [
    'optionalDependencies',
    'peerDependencies',
    'bundledDependencies',
    'bundleDependencies',
  ]) {
    assert.equal(manifest[field], undefined, `unexpected package dependency field: ${field}`);
  }
}

const options = parseArguments(process.argv.slice(2));
const temporaryRoot = options.packJson ? null : await mkdtemp(path.join(tmpdir(), 'z-s-artifact-verify-'));

try {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assertExactManifest(manifest);

  let packJsonPath;
  if (options.packJson) {
    packJsonPath = path.resolve(root, options.packJson);
  } else {
    const packDirectory = path.join(temporaryRoot, 'pack');
    await mkdir(packDirectory, { recursive: true });
    const result = await execFileAsync(
      'npm',
      ['pack', '--json', '--silent', '--pack-destination', packDirectory],
      { cwd: root, maxBuffer: 10 * 1024 * 1024 },
    );
    packJsonPath = path.join(temporaryRoot, 'pack.json');
    await writeFile(packJsonPath, result.stdout, 'utf8');
    options.tarballRoot = packDirectory;
  }

  const packed = JSON.parse(await readFile(packJsonPath, 'utf8'));
  assert.ok(Array.isArray(packed) && packed.length === 1, 'npm pack must produce exactly one tarball');
  const artifact = packed[0];
  assert.equal(artifact.name, EXPECTED_NAME);
  assert.equal(artifact.version, EXPECTED_VERSION);
  assert.equal(typeof artifact.filename, 'string');
  assert.match(artifact.integrity, /^sha512-[A-Za-z0-9+/=]+$/);
  assert.match(artifact.shasum, /^[a-f0-9]{40}$/);

  const files = (artifact.files ?? []).map((entry) => entry.path).sort();
  assert.deepEqual(files, await expectedFiles(), 'package file list differs from the source-derived allowlist');

  const tarballRoot = options.tarballRoot
    ? path.resolve(root, options.tarballRoot)
    : path.dirname(packJsonPath);
  const tarballPath = path.join(tarballRoot, artifact.filename);
  const tarballBytes = await readFile(tarballPath);
  const sha256 = createHash('sha256').update(tarballBytes).digest('hex');

  const evidence = {
    schemaVersion: 1,
    packageName: artifact.name,
    packageVersion: artifact.version,
    contractVersion: '1.0',
    packageOwnerNamespace: 'ZimmonAI/@zimmonai',
    registry: EXPECTED_REGISTRY,
    repository: 'https://github.com/ZimmonAI/z-s_app',
    packageUrl: 'https://github.com/orgs/ZimmonAI/packages/npm/package/z-s-control-plane',
    sourceBaseline: 'a18bd69818a5e12da5ac45cf5d64da68a59fe49e',
    tarballFilename: artifact.filename,
    tarballSha256: sha256,
    npmIntegrity: artifact.integrity,
    npmShasum: artifact.shasum,
    exports: EXPECTED_EXPORTS,
    files,
    unexpectedFiles: [],
  };

  if (options.output) {
    const outputPath = path.resolve(root, options.output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  }

  console.log(`package artifact verified ${artifact.filename} sha256:${sha256}`);
} finally {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
}
