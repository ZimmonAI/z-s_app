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
const EXPECTED_VERSION = '0.5.0';
const EXPECTED_REGISTRY = 'https://npm.pkg.github.com';

function parseArguments(argv) {
  const options = { spec: null, registry: null, evidence: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--spec') options.spec = argv[++index] ?? null;
    else if (value === '--registry') options.registry = argv[++index] ?? null;
    else if (value === '--evidence') options.evidence = argv[++index] ?? null;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function assertNoProhibitedRegistrySource(value) {
  if (typeof value === 'string') {
    assert.equal(/git\+ssh|ssh:\/\//i.test(value), false, `Git SSH source detected: ${value}`);
    assert.equal(/github\.com.*#/i.test(value), false, `Git ref source detected: ${value}`);
    assert.equal(/^(?:file:|workspace:|link:)/i.test(value), false, `local/workspace source detected: ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertNoProhibitedRegistrySource);
    return;
  }
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(assertNoProhibitedRegistrySource);
  }
}

const options = parseArguments(process.argv.slice(2));
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'z-s-package-smoke-'));
const packDirectory = path.join(temporaryRoot, 'pack');
const consumerDirectory = path.join(temporaryRoot, 'consumer');
const cacheDirectory = path.join(temporaryRoot, 'cache');
const evidencePath = options.evidence ? path.resolve(root, options.evidence) : null;

try {
  await mkdir(packDirectory, { recursive: true });
  await mkdir(consumerDirectory, { recursive: true });
  await mkdir(cacheDirectory, { recursive: true });

  let installSpec = options.spec;
  let tarballFilename = null;
  let tarballSha256 = null;
  let localPackIntegrity = null;

  if (!installSpec) {
    const packResult = await execFileAsync(
      'npm',
      ['pack', '--json', '--silent', '--pack-destination', packDirectory],
      { cwd: root },
    );
    const packed = JSON.parse(packResult.stdout);
    assert.ok(Array.isArray(packed) && packed.length === 1);
    tarballFilename = packed[0]?.filename;
    localPackIntegrity = packed[0]?.integrity ?? null;
    assert.equal(typeof tarballFilename, 'string');
    const tarball = path.join(packDirectory, tarballFilename);
    tarballSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
    installSpec = tarball;
  }

  await writeFile(
    path.join(consumerDirectory, 'package.json'),
    `${JSON.stringify({ name: 'z-s-clean-consumer', private: true, type: 'module' }, null, 2)}\n`,
    'utf8',
  );

  const installArguments = [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--save-exact',
    '--package-lock=true',
  ];
  if (options.spec) installArguments.push('--cache', cacheDirectory);
  if (options.registry) installArguments.push('--registry', options.registry);
  installArguments.push(installSpec);

  await execFileAsync('npm', installArguments, {
    cwd: consumerDirectory,
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });

  await writeFile(
    path.join(consumerDirectory, 'verify.mjs'),
    [
      `import * as root from '${EXPECTED_NAME}';`,
      `import * as contract from '${EXPECTED_NAME}/runtime-contract';`,
      `import * as runtime from '${EXPECTED_NAME}/runtime-service';`,
      `import * as registry from '${EXPECTED_NAME}/runtime-storage-registry';`,
      `import * as readGrant from '${EXPECTED_NAME}/runtime-read-grant';`,
      `import * as readDelivery from '${EXPECTED_NAME}/runtime-read-delivery';`,
      "if (root.SERVICE_ID !== 'z-s') throw new Error('root contract export missing');",
      `if (root.PACKAGE_VERSION !== '${EXPECTED_VERSION}') throw new Error('root package identity mismatch');`,
      `if (contract.PACKAGE_VERSION !== '${EXPECTED_VERSION}') throw new Error('contract package identity mismatch');`,
      "if (contract.CONTRACT_VERSION !== '1.0') throw new Error('contract identity mismatch');",
      "if (runtime.createHttpStorageRuntime === undefined) throw new Error('runtime export missing');",
      "if (runtime.createObjectIngestRuntime === undefined) throw new Error('ingest runtime export missing');",
      "if (runtime.createDeterministicUploadCompletionTokenService === undefined) throw new Error('token service export missing');",
      "if (runtime.DualProviderObjectIngestAdapter === undefined) throw new Error('dual-provider adapter export missing');",
      "if (runtime.S3CompatibleProviderObjectWriter === undefined) throw new Error('S3 provider writer export missing');",
      "if (runtime.BoundedMediaVerifier === undefined) throw new Error('media verifier export missing');",
      "if (registry.PostgresRuntimeStorageRegistry === undefined) throw new Error('registry export missing');",
      "if (registry.createRuntimeStorageDuplicateResultCodec === undefined) throw new Error('registry codec export missing');",
      "if (readGrant.createObjectReadGrantTokenService === undefined) throw new Error('read grant token export missing');",
      "if (readDelivery.createReadDeliveryHttpStorageRuntime === undefined) throw new Error('read delivery runtime export missing');",
      "if (root.CAPABILITY_POLICY_VERSION !== '1') throw new Error('control-plane export missing');",
    ].join('\n'),
    'utf8',
  );
  await execFileAsync('node', ['verify.mjs'], { cwd: consumerDirectory });

  const installedManifestPath = path.join(
    consumerDirectory,
    'node_modules',
    '@zimmonai',
    'z-s-control-plane',
    'package.json',
  );
  const installedManifest = JSON.parse(await readFile(installedManifestPath, 'utf8'));
  assert.equal(installedManifest.name, EXPECTED_NAME);
  assert.equal(installedManifest.version, EXPECTED_VERSION);
  assert.deepEqual(Object.keys(installedManifest.exports ?? {}), [
    '.',
    './runtime-contract',
    './runtime-service',
    './runtime-storage-registry',
    './runtime-read-grant',
    './runtime-read-delivery',
  ]);

  const lock = JSON.parse(await readFile(path.join(consumerDirectory, 'package-lock.json'), 'utf8'));
  const rootLock = lock.packages?.[''];
  const installedLock = lock.packages?.[`node_modules/${EXPECTED_NAME}`];
  assert.equal(installedLock?.version, EXPECTED_VERSION);

  if (options.spec) {
    assert.equal(rootLock?.dependencies?.[EXPECTED_NAME], EXPECTED_VERSION);
    assert.equal(options.registry, EXPECTED_REGISTRY, 'registry smoke must use the approved authority');
    assert.equal(typeof installedLock?.resolved, 'string');
    assert.ok(installedLock.resolved.startsWith(`${EXPECTED_REGISTRY}/`));
    assert.equal(typeof installedLock?.integrity, 'string');
    assert.ok(installedLock.integrity.startsWith('sha512-'));
    assertNoProhibitedRegistrySource(lock);
  } else {
    const localDependency = rootLock?.dependencies?.[EXPECTED_NAME];
    assert.equal(typeof localDependency, 'string');
    assert.ok(localDependency.startsWith('file:'), 'local smoke must install the generated tarball');
  }

  const evidence = {
    schemaVersion: 1,
    packageName: installedManifest.name,
    packageVersion: installedManifest.version,
    contractVersion: '1.0',
    installMode: options.spec ? 'registry' : 'local-tarball',
    registry: options.registry,
    installSpec: options.spec ? `${EXPECTED_NAME}@${EXPECTED_VERSION}` : 'generated-local-tarball',
    resolved: options.spec ? installedLock?.resolved ?? null : null,
    packageManagerIntegrity: installedLock?.integrity ?? localPackIntegrity,
    tarballFilename,
    tarballSha256,
    rootExportVerified: true,
    runtimeContractExportVerified: true,
    runtimeServiceExportVerified: true,
    runtimeStorageRegistryExportVerified: true,
    runtimeReadGrantExportVerified: true,
    runtimeReadDeliveryExportVerified: true,
    genericIngestExportVerified: true,
    uploadCompletionTokenExportVerified: true,
    prohibitedSourceDetected: false,
  };

  if (evidencePath) {
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  }

  const identity = options.spec
    ? `${EXPECTED_NAME}@${EXPECTED_VERSION} ${installedLock.resolved}`
    : `${tarballFilename} sha256:${tarballSha256}`;
  console.log(`pack:check passed ${identity}`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
