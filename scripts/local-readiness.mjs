import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const expectedFolderName = 'z-s_app';
const requiredFiles = [
  'package.json',
  'src/index.ts',
  'db/migrations/0001_z_s_control_plane_foundation.sql',
  'db/seeds/0001_video_maker_dev_profiles.sql',
  'docs/db-handoff.md',
  'config/example.env'
];

async function exists(relativePath) {
  try {
    await access(path.resolve(relativePath), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const artifactChecks = Object.fromEntries(
  await Promise.all(requiredFiles.map(async (file) => [file, await exists(file)]))
);

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
const folderName = path.basename(process.cwd());
const gitMetadataPresent = await exists('.git');
const packageIdentityMatches = packageJson.name === '@zimmonai/z-s-control-plane';
const nodeSupported = nodeMajor >= 22;
const folderNameMatches = folderName === expectedFolderName;
const requiredArtifactsPresent = Object.values(artifactChecks).every(Boolean);

const ready =
  gitMetadataPresent &&
  packageIdentityMatches &&
  nodeSupported &&
  folderNameMatches &&
  requiredArtifactsPresent;

const summary = {
  schemaVersion: 1,
  appId: 'z-s_app',
  expectedRepository: 'ZimmonAI/z-s_app',
  expectedLocalFolder: '\\apps\\z-s_app',
  observedFolderName: folderName,
  nodeVersion: process.versions.node,
  checks: {
    gitMetadataPresent,
    packageIdentityMatches,
    nodeSupported,
    folderNameMatches,
    requiredArtifactsPresent,
    artifacts: artifactChecks
  },
  safety: {
    secretsRead: false,
    databaseActionsPerformed: false,
    providerActionsPerformed: false,
    browserActionsPerformed: false,
    serviceActionsPerformed: false
  },
  ready
};

console.log(JSON.stringify(summary, null, 2));

if (!ready) {
  process.exitCode = 1;
}
