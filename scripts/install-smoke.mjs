import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'z-s-package-smoke-'));
const packDirectory = path.join(temporaryRoot, 'pack');
const consumerDirectory = path.join(temporaryRoot, 'consumer');

function assertNoFloatingOrLocalDependencies(value) {
  if (typeof value === 'string') {
    assert.equal(value.startsWith('file:'), false, `permanent local dependency: ${value}`);
    assert.equal(/github\.com.*(?:main|master)(?:#|$)/i.test(value), false, `floating Git dependency: ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertNoFloatingOrLocalDependencies);
    return;
  }
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(assertNoFloatingOrLocalDependencies);
  }
}

try {
  await mkdir(packDirectory, { recursive: true });
  await mkdir(consumerDirectory, { recursive: true });

  const packResult = await execFileAsync(
    'npm',
    ['pack', '--json', '--silent', '--pack-destination', packDirectory],
    { cwd: root },
  );
  const packed = JSON.parse(packResult.stdout);
  assert.ok(Array.isArray(packed) && packed.length === 1);
  const filename = packed[0]?.filename;
  assert.equal(typeof filename, 'string');
  const tarball = path.join(packDirectory, filename);
  const checksum = createHash('sha256').update(await readFile(tarball)).digest('hex');

  await writeFile(
    path.join(consumerDirectory, 'package.json'),
    JSON.stringify({ name: 'z-s-clean-consumer', private: true, type: 'module' }, null, 2),
  );
  await execFileAsync(
    'npm',
    [
      'install',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      tarball,
    ],
    { cwd: consumerDirectory },
  );

  await writeFile(
    path.join(consumerDirectory, 'verify.mjs'),
    [
      "import * as root from '@zimspace/z-s-control-plane';",
      "import * as contract from '@zimspace/z-s-control-plane/runtime-contract';",
      "import * as runtime from '@zimspace/z-s-control-plane/runtime-service';",
      "if (root.SERVICE_ID !== 'z-s') throw new Error('root contract export missing');",
      "if (contract.CONTRACT_VERSION !== '1.0') throw new Error('contract identity mismatch');",
      "if (runtime.createHttpStorageRuntime === undefined) throw new Error('runtime export missing');",
      "if (root.CAPABILITY_POLICY_VERSION !== '1') throw new Error('control-plane export missing');",
    ].join('\n'),
  );
  await execFileAsync('node', ['verify.mjs'], { cwd: consumerDirectory });

  const installedManifest = JSON.parse(
    await readFile(
      path.join(
        consumerDirectory,
        'node_modules',
        '@zimspace',
        'z-s-control-plane',
        'package.json',
      ),
      'utf8',
    ),
  );
  assert.equal(installedManifest.name, '@zimspace/z-s-control-plane');
  assert.equal(installedManifest.version, '0.2.0');
  assertNoFloatingOrLocalDependencies(installedManifest);
  console.log(`pack:check passed ${filename} sha256:${checksum}`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
