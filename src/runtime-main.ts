import { createServer } from 'node:http';
import { createHttpStorageRuntime } from './runtime-service.js';
import { createNodeHttpHandler } from './node-http-adapter.js';

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

function callerForToken(token: string): { readonly appId: 'video-maker_app' | 'z-x_app' } | null {
  if (token === process.env.Z_S_VIDEO_MAKER_BEARER_TOKEN) return { appId: 'video-maker_app' };
  if (token === process.env.Z_S_Z_X_BEARER_TOKEN) return { appId: 'z-x_app' };
  return null;
}

const runtime = createHttpStorageRuntime({
  authenticate: callerForToken,
  authorizeCaller: () => true,
  resolveStorageProfile: (request) => ({
    ...request,
    active: true,
    ready: false,
    safeFingerprint: 'local-runtime-placeholder',
    capabilityPolicy: {
      checksumVerification: 'required',
      sizeVerification: 'required-when-supported',
      headContentLength: 'optional-with-checksum',
      rangeRead: 'required',
    },
    capabilities: {
      objectWriteIntent: false,
      objectReadGrant: false,
      objectDeleteRequest: false,
      objectRepairOperation: false,
    },
    protectionStages: [],
  }),
  createObjectWriteIntent: () => {
    throw new Error('write runtime is not configured');
  },
  controlPlaneReadiness: () => ({ status: 'ready' }),
  dataPlaneReadiness: () => ({ status: 'ready' }),
});

const server = createServer(createNodeHttpHandler(runtime));
const host = process.env.Z_S_RUNTIME_HOST?.trim() || DEFAULT_HOST;
const port = readPort();

server.listen(port, host, () => {
  console.log(JSON.stringify({ service: 'z-s', host, port, state: 'listening' }));
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
