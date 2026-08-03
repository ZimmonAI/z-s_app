import type { HttpStorageRuntime } from './runtime-contract.js';
import type { ImageDerivativeStore } from './image-derivative.js';

function completionStorageObjectId(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = (value as Record<string, unknown>).result;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const record = result as Record<string, unknown>;
  return record.state === 'recorded' && typeof record.storageObjectId === 'string'
    ? record.storageObjectId
    : undefined;
}

export function createImageDerivativeEnqueueRuntime(
  runtime: HttpStorageRuntime,
  store: ImageDerivativeStore,
): HttpStorageRuntime {
  return Object.freeze({
    async handle(request: Request): Promise<Response> {
      const response = await runtime.handle(request);
      if (
        !store.configured ||
        request.method !== 'PUT' ||
        !/^\/v1\/object-write-intents\/[^/]+\/content$/.test(new URL(request.url).pathname) ||
        response.status < 200 ||
        response.status >= 300
      ) {
        return response;
      }
      try {
        const storageObjectId = completionStorageObjectId(await response.clone().json());
        if (storageObjectId !== undefined) {
          await store.enqueueVerifiedSource(storageObjectId);
        }
      } catch {
        // A verified upload response remains authoritative. Duplicate-safe derivative
        // enqueue can be reconciled without weakening the completed object write.
      }
      return response;
    },
    health: () => runtime.health(),
    readiness: () => runtime.readiness(),
  });
}
