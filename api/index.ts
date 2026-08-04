import { createNodeHttpHandler } from '../src/node-http-adapter.js';
import { createVideoMakerControlRuntimeComposition } from '../src/runtime-control-composition.js';

const composition = createVideoMakerControlRuntimeComposition(process.env);

export default createNodeHttpHandler(composition.runtime);
