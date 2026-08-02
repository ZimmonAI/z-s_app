import { createServer, type Server } from 'node:http';
import { createNodeHttpHandler } from './node-http-adapter.js';
import { createVideoMakerControlRuntimeComposition } from './runtime-control-composition.js';

export interface VideoMakerNodeRuntimeServer {
  readonly server: Server;
  close(): Promise<void>;
}

export function createVideoMakerNodeRuntimeServer(
  environment: NodeJS.ProcessEnv = process.env,
): VideoMakerNodeRuntimeServer {
  const composition = createVideoMakerControlRuntimeComposition(environment);
  const server = createServer(createNodeHttpHandler(composition.runtime));
  let closePromise: Promise<void> | undefined;

  return Object.freeze({
    server,
    close(): Promise<void> {
      closePromise ??= (async () => {
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error === undefined) resolve();
              else reject(error);
            });
            server.closeIdleConnections();
          });
        }
        await composition.close();
      })();
      return closePromise;
    },
  });
}
