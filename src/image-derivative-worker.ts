import {
  IMAGE_DERIVATIVE_LIMITS,
  ImageDerivativeApplicationService,
} from './image-derivative.js';

export interface ImageDerivativeWorkerBatchResult {
  readonly processed: number;
  readonly idleWorkers: number;
}

export class BoundedImageDerivativeWorker {
  readonly #service: ImageDerivativeApplicationService;
  readonly #concurrency: number;

  constructor(
    service: ImageDerivativeApplicationService,
    concurrency: number = IMAGE_DERIVATIVE_LIMITS.maximumConcurrentJobs,
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
      throw new TypeError('image derivative worker concurrency must be between 1 and 8');
    }
    this.#service = service;
    this.#concurrency = concurrency;
  }

  async runBatch(workerId: string, now = new Date()): Promise<Readonly<ImageDerivativeWorkerBatchResult>> {
    const results = await Promise.all(
      Array.from({ length: this.#concurrency }, async (_, index) =>
        this.#service.processNext(`${workerId}:${index + 1}`, now),
      ),
    );
    return Object.freeze({
      processed: results.filter((result) => result === 'processed').length,
      idleWorkers: results.filter((result) => result === 'idle').length,
    });
  }
}
