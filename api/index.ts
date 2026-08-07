import { createNodeHttpHandler } from '../src/node-http-adapter.js';
import { maybeRunH10R2OnlySmoke } from '../src/h10-r2-only-smoke.js';
import { createVideoMakerControlRuntimeComposition } from '../src/runtime-control-composition.js';
import type { HttpStorageRuntime } from '../src/runtime-contract.js';

const composition = createVideoMakerControlRuntimeComposition(process.env);

const runtime: HttpStorageRuntime = Object.freeze({
  async handle(request: Request): Promise<Response> {
    const smoke = await maybeRunH10R2OnlySmoke({
      request,
      runtime: composition.runtime,
      environment: process.env,
    });
    return smoke ?? composition.runtime.handle(request);
  },
  health: () => composition.runtime.health(),
  readiness: () => composition.runtime.readiness(),
});

export default createNodeHttpHandler(runtime);
