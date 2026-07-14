import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const roots = ['src', 'tests', 'db', 'config', 'docs'];
const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['access key', /AKIA[0-9A-Z]{16}/],
  ['credentialed URL', /https?:\/\/[^\s/@]+:[^\s/@]+@/],
  ['literal secret assignment', /(?:secretAccessKey|password|token)\s*[:=]\s*['"][^'"\s]{8,}['"]/i],
  ['signed URL', /[?&](?:X-Amz-Signature|X-Amz-Credential)=/i],
];
const errors = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(fullPath);
      continue;
    }
    const content = await readFile(fullPath, 'utf8');
    for (const [label, pattern] of patterns) {
      if (pattern.test(content)) errors.push(`${fullPath}: ${label}`);
    }
  }
}

for (const root of roots) await visit(root);
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('secret-pattern enforcement: passed');
}
