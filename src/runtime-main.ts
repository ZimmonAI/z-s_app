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

server.listen(port, host, () => {
  console.log(JSON.stringify({ service: 'z-s', host, port, state: 'listening' }));
});

let shutdownStarted = false;
async function shutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
  await composition.close();
}

function requestShutdown(): void {
  void shutdown().catch(() => {
    process.exitCode = 1;
  });
}

process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);
