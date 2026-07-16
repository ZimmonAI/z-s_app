import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const EXPECTED_NAME = '@zimmonai/z-s-control-plane';
const EXPECTED_VERSION = '0.3.0';
const EXPECTED_REPOSITORY = 'git+https://github.com/ZimmonAI/z-s_app.git';
const EXPECTED_REGISTRY = 'https://npm.pkg.github.com';
const EXPECTED_EXPORTS = [
  '.',
  './runtime-contract',
  './runtime-service',
  './runtime-storage-registry',
];
const EXPECTED_PACKAGE_FILES = [
  'dist',
  'README.md',
  'docs/runtime-contract.md',
  'db/migrations/0002_z_s_runtime_registry.sql',
  'db/migrations/0002_z_s_runtime_registry.down.sql',
];
const APPROVED_DIST_MODULES = [
  'capability-registry',
  'domain',
  'errors',
  'fingerprint',
  'index',
  'integrity',
  'prefix-authorizer',
  'profile-registry',
  'runtime-contract',
  'runtime-ingest',
  'runtime-service',
  'runtime-storage-registry',
  'runtime-storage-registry-duplicate',
  'runtime-storage-registry-object',
  'runtime-storage-registry-support',
  'runtime-storage-registry-types',
  'runtime-upload-token',
  'service',
];

function expectedFiles() {
  const files = [
    'README.md',
    'docs/runtime-contract.md',
    'package.json',
    'db/migrations/0002_z_s_runtime_registry.sql',
    'db/migrations/0002_z_s_runtime_registry.down.sql',
  ];
  for (const moduleName of APPROVED_DIST_MODULES) {
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
  for (const field of [
    'dependencies',
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
  assert.deepEqual(files, expectedFiles(), 'package file list differs from the approved allowlist');

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
    sourceBaseline: '70055e466557f0039756fc211b7dadbc1880c38d',
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
