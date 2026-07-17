import { createServer, type Server } from 'node:http';
import { createNodeHttpHandler } from './node-http-adapter.js';
import { createRuntimeLocalComposition } from './runtime-local-composition.js';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 4310;
const SHUTDOWN_TIMEOUT_MS = 15_000;

function readPort(): number {
  const raw = process.env.Z_S_RUNTIME_PORT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Z_S_RUNTIME_PORT must be a TCP port.');
  }
  return port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
}

const composition = createRuntimeLocalComposition();
const server = createServer(createNodeHttpHandler(composition.runtime));
const host = process.env.Z_S_RUNTIME_HOST?.trim() || DEFAULT_HOST;
const port = readPort();

server.listen(port, host, () => {
  console.log(JSON.stringify({ service: 'z-s', host, port, state: 'listening' }));
});

let shutdownStarted = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(JSON.stringify({ service: 'z-s', signal, state: 'stopping' }));
  const timeout = setTimeout(() => {
    console.error(JSON.stringify({ service: 'z-s', state: 'shutdown-timeout' }));
    process.exitCode = 1;
  }, SHUTDOWN_TIMEOUT_MS);
  timeout.unref();
  try {
    await closeServer(server);
    await composition.close();
    console.log(JSON.stringify({ service: 'z-s', state: 'stopped' }));
  } catch {
    process.exitCode = 1;
    console.error(JSON.stringify({ service: 'z-s', state: 'shutdown-failed' }));
  } finally {
    clearTimeout(timeout);
  }
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
