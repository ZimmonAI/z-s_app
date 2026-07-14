import { rm } from 'node:fs/promises';
await rm('.test-dist', { recursive: true, force: true });
