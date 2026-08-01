import { createClientControlComposition } from './client-control-composition.js';
import type { ClientCredentialAuthenticator } from './client-control-auth.js';
import { createControlPlaneUiRuntime } from './control-plane-ui.js';
import type { HttpStorageRuntime } from './runtime-contract.js';
import {
  createVideoMakerRuntimeComposition,
  type VideoMakerRuntimeComposition,
} from './runtime-local-composition.js';

function optionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? undefined : normalized;
}

function controlRuntime(
  runtime: HttpStorageRuntime,
  environment: NodeJS.ProcessEnv,
  clientCredentialAuthenticator: ClientCredentialAuthenticator,
): HttpStorageRuntime {
  const adminPassword = optionalString(environment.Z_S_CONTROL_ADMIN_PASSWORD);
  const sessionSigningKey = optionalString(environment.Z_S_CONTROL_SESSION_SIGNING_KEY);
  return createControlPlaneUiRuntime(runtime, {
    clientCredentialAuthenticator,
    ...(adminPassword === undefined ? {} : { adminPassword }),
    ...(sessionSigningKey === undefined ? {} : { sessionSigningKey }),
  });
}

export function createVideoMakerControlRuntimeComposition(
  environment: NodeJS.ProcessEnv = process.env,
): VideoMakerRuntimeComposition {
  const composition = createVideoMakerRuntimeComposition(environment);
  const clientControl = createClientControlComposition(environment);
  return Object.freeze({
    runtime: controlRuntime(composition.runtime, environment, clientControl.authenticator),
    close: async () => {
      await Promise.all([composition.close(), clientControl.close()]);
    },
  });
}
