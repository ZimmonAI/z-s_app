import { createClientControlComposition } from './client-control-composition.js';
import type { ClientCredentialAuthenticator } from './client-control-auth.js';
import type { ClientStorageConfigurationStore } from './client-storage-configuration.js';
import { createControlPlaneUiRuntime } from './control-plane-ui.js';
import { createImageDerivativeRuntime } from './image-derivative-runtime.js';
import type { ImageDerivativeStore } from './image-derivative.js';
import type { BoundedImageDerivativeWorker } from './image-derivative-worker.js';
import type { HttpStorageRuntime } from './runtime-contract.js';
import {
  createVideoMakerRuntimeComposition,
  type VideoMakerRuntimeComposition,
} from './runtime-local-composition.js';
import { createReplicaProtectionRuntimeComposition } from './runtime-replica-protection-runtime.js';
import type { StorageServiceApplicationService } from './storage-service-application.js';
import { createStorageServiceRuntime } from './storage-service-runtime.js';

function optionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? undefined : normalized;
}

function controlRuntime(
  runtime: HttpStorageRuntime,
  environment: NodeJS.ProcessEnv,
  clientCredentialAuthenticator: ClientCredentialAuthenticator,
  clientStorageConfigurationStore: ClientStorageConfigurationStore,
  storageService: StorageServiceApplicationService | null,
  imageDerivativeStore: ImageDerivativeStore,
  imageDerivativeWorker: BoundedImageDerivativeWorker | null,
): HttpStorageRuntime {
  const adminPassword = optionalString(environment.Z_S_CONTROL_ADMIN_PASSWORD);
  const sessionSigningKey = optionalString(environment.Z_S_CONTROL_SESSION_SIGNING_KEY);
  const control = createControlPlaneUiRuntime(runtime, {
    clientCredentialAuthenticator,
    clientStorageConfigurationStore,
    ...(adminPassword === undefined ? {} : { adminPassword }),
    ...(sessionSigningKey === undefined ? {} : { sessionSigningKey }),
  });
  const storageServices = storageService === null
    ? control
    : createStorageServiceRuntime(control, {
      service: storageService,
      ...(sessionSigningKey === undefined ? {} : { sessionSigningKey }),
    });
  return createImageDerivativeRuntime(storageServices, {
    store: imageDerivativeStore,
    ...(sessionSigningKey === undefined ? {} : { sessionSigningKey }),
    ...(imageDerivativeWorker === null ? {} : { worker: imageDerivativeWorker }),
  });
}

export function createVideoMakerControlRuntimeComposition(
  environment: NodeJS.ProcessEnv = process.env,
): VideoMakerRuntimeComposition {
  const clientControl = createClientControlComposition(environment);
  const composition = createVideoMakerRuntimeComposition(
    environment,
    clientControl.credentialResolver,
  );
  const applicationRuntime = controlRuntime(
    composition.runtime,
    environment,
    clientControl.authenticator,
    clientControl.configurationStore,
    clientControl.storageService,
    clientControl.imageDerivativeStore,
    clientControl.imageDerivativeWorker,
  );
  const protection = createReplicaProtectionRuntimeComposition({
    runtime: applicationRuntime,
    environment,
    credentialResolver: clientControl.credentialResolver,
    configurationStore: clientControl.configurationStore,
  });
  return Object.freeze({
    runtime: protection.runtime,
    close: async () => {
      await Promise.all([composition.close(), clientControl.close(), protection.close()]);
    },
  });
}
