import { createServer } from 'node:http';
import { createNodeHttpHandler } from './node-http-adapter.js';
import { createVideoMakerRuntimeComposition } from './runtime-local-composition.js';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 4310;

function readPort(): number {
  const raw = process.env.Z_S_RUNTIME_PORT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Z_S_RUNTIME_PORT must be a TCP port.');
  }
  return port;
}

const composition = createVideoMakerRuntimeComposition();
const server = createServer(createNodeHttpHandler(composition.runtime));
const host = process.env.Z_S_RUNTIME_HOST?.trim() || DEFAULT_HOST;
const port = readPort();
let closing = false;

server.listen(port, host, () => {
  console.log(JSON.stringify({ service: 'z-s', host, port, state: 'listening' }));
});

server.on('error', () => {
  console.error(JSON.stringify({
    service: 'z-s',
    state: 'listener-error',
    diagnostic: {
      category: 'internal',
      code: 'listener-error',
      retryable: true,
    },
  }));
});

async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  try {
    await composition.close();
  } finally {
    console.log(JSON.stringify({ service: 'z-s', state: 'stopped', signal }));
  }
}

process.once('SIGINT', () => {
  void shutdown('SIGINT').then(() => process.exit(0), () => process.exit(1));
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM').then(() => process.exit(0), () => process.exit(1));
});
