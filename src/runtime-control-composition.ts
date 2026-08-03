import { createClientControlComposition } from './client-control-composition.js';
import type { ClientCredentialAuthenticator } from './client-control-auth.js';
import type { ClientStorageConfigurationStore } from './client-storage-configuration.js';
import { createControlPlaneUiRuntime } from './control-plane-ui.js';
import { createImageDerivativeControlRuntime } from './image-derivative-control.js';
import { createImageDerivativeEnqueueRuntime } from './image-derivative-runtime.js';
import type { ImageDerivativeStore } from './image-derivative.js';
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
  clientStorageConfigurationStore: ClientStorageConfigurationStore,
  imageDerivativeStore: ImageDerivativeStore,
): HttpStorageRuntime {
  const adminPassword = optionalString(environment.Z_S_CONTROL_ADMIN_PASSWORD);
  const sessionSigningKey = optionalString(environment.Z_S_CONTROL_SESSION_SIGNING_KEY);
  const dataRuntime = createImageDerivativeEnqueueRuntime(runtime, imageDerivativeStore);
  const control = createControlPlaneUiRuntime(dataRuntime, {
    clientCredentialAuthenticator,
    clientStorageConfigurationStore,
    ...(adminPassword === undefined ? {} : { adminPassword }),
    ...(sessionSigningKey === undefined ? {} : { sessionSigningKey }),
  });
  return createImageDerivativeControlRuntime(control, {
    store: imageDerivativeStore,
    ...(sessionSigningKey === undefined ? {} : { sessionSigningKey }),
  });
}

export function createVideoMakerControlRuntimeComposition(
  environment: NodeJS.ProcessEnv = process.env,
): VideoMakerRuntimeComposition {
  const composition = createVideoMakerRuntimeComposition(environment);
  const clientControl = createClientControlComposition(environment);
  return Object.freeze({
    runtime: controlRuntime(
      composition.runtime,
      environment,
      clientControl.authenticator,
      clientControl.configurationStore,
      clientControl.imageDerivativeStore,
    ),
    close: async () => {
      await Promise.all([composition.close(), clientControl.close()]);
    },
  });
}
