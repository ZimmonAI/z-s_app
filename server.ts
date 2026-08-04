import { createVideoMakerNodeRuntimeServer } from './src/runtime-node-server.js';

function readPort(): number {
  const raw = process.env.PORT?.trim();
  if (raw === undefined || raw === '') return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be a TCP port.');
  }
  return port;
}

const runtimeServer = createVideoMakerNodeRuntimeServer(process.env);
const host = '0.0.0.0';
const port = readPort();

runtimeServer.server.listen(port, host, () => {
  console.log(JSON.stringify({ service: 'z-s', host, port, state: 'listening' }));
});

export default runtimeServer.server;
