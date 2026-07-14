import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const roots = ['src', 'tests', 'scripts'];
const extensions = new Set(['.ts', '.mjs']);
const failures = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(fullPath);
    } else if (extensions.has(path.extname(entry.name))) {
      const content = await readFile(fullPath, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, index) => {
        if (/\s+$/.test(line)) failures.push(`${fullPath}:${index + 1}: trailing whitespace`);
        if (line.includes('\t')) failures.push(`${fullPath}:${index + 1}: tab character`);
      });
      if (!content.endsWith('\n')) failures.push(`${fullPath}: missing final newline`);
    }
  }
}

for (const root of roots) await visit(root);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('lint: passed');
}
