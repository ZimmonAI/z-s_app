import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const roots = ['src', 'tests', 'db'];
const errors = [];
const literalPattern = /['"][a-f0-9]{24}['"]/g;
const behaviorPattern = /(?:delivery|resource)[-_ ]?id.{0,50}(?:fallback|redirect|delegate|scan|parse)/i;

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(fullPath);
      continue;
    }
    const content = await readFile(fullPath, 'utf8');
    if (literalPattern.test(content)) errors.push(`${fullPath}: fixed-length identifier literal`);
    if (behaviorPattern.test(content)) errors.push(`${fullPath}: legacy delivery behavior language`);
  }
}

for (const root of roots) await visit(root);
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('legacy delivery identifier enforcement: passed');
}
