import { PassThrough, type Readable } from 'node:stream';
import {
  IMAGE_DERIVATIVE_LIMITS,
  ImageDerivativeError,
  type ImageDerivativeJob,
  type ImageDerivativeSource,
  type ProcessedImageDerivative,
} from './image-derivative.js';
import { PngImageDerivativeProcessor as BasePngImageDerivativeProcessor } from './image-derivative-png.js';

export const IMAGE_DERIVATIVE_SOURCE_READ_DEADLINE_MS = 120_000;

interface SourceReadTimer {
  readonly setTimeout: typeof setTimeout;
  readonly clearTimeout: typeof clearTimeout;
}

export interface PngImageDerivativeProcessorOptions {
  readonly sourceReadDeadlineMs?: number;
  readonly timer?: Readonly<SourceReadTimer>;
}

function interruptedError(): ImageDerivativeError {
  return new ImageDerivativeError(
    'dependency-unavailable',
    'image-derivative-source-read-interrupted',
    true,
  );
}

function boundedSourceBody(
  source: Readable,
  deadlineMs: number,
  timer: Readonly<SourceReadTimer>,
): Readable {
  const body = new PassThrough();
  let settled = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  const cleanup = (): void => {
    if (deadline !== undefined) {
      timer.clearTimeout(deadline);
      deadline = undefined;
    }
    source.off('data', onData);
    source.off('error', onError);
    source.off('end', onEnd);
    source.off('close', onClose);
    source.off('aborted', onAborted);
    body.off('drain', onDrain);
    body.off('close', onProxyClose);
  };

  const destroySource = (): void => {
    if (!source.destroyed) source.destroy();
  };

  const reject = (error: Error): void => {
    if (settled) return;
    settled = true;
    cleanup();
    destroySource();
    body.destroy(error);
  };

  const finish = (): void => {
    if (settled) return;
    settled = true;
    cleanup();
    body.end();
  };

  function onData(chunk: Buffer | Uint8Array | string): void {
    if (settled) return;
    const value = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    if (!body.write(value)) source.pause();
  }

  function onDrain(): void {
    if (!settled && source.readable && !source.destroyed) source.resume();
  }

  function onError(error: Error): void {
    reject(error);
  }

  function onEnd(): void {
    finish();
  }

  function onClose(): void {
    if (!settled) reject(interruptedError());
  }

  function onAborted(): void {
    reject(interruptedError());
  }

  function onProxyClose(): void {
    if (settled) return;
    settled = true;
    cleanup();
    destroySource();
  }

  source.on('data', onData);
  source.once('error', onError);
  source.once('end', onEnd);
  source.once('close', onClose);
  source.once('aborted', onAborted);
  body.on('drain', onDrain);
  body.once('close', onProxyClose);
  deadline = timer.setTimeout(() => {
    reject(new ImageDerivativeError(
      'dependency-unavailable',
      'image-derivative-source-read-timeout',
      true,
    ));
  }, deadlineMs);
  deadline.unref?.();
  return body;
}

export class PngImageDerivativeProcessor extends BasePngImageDerivativeProcessor {
  readonly #sourceReadDeadlineMs: number;
  readonly #timer: Readonly<SourceReadTimer>;

  constructor(input: Readonly<PngImageDerivativeProcessorOptions> = {}) {
    super();
    const deadlineMs = input.sourceReadDeadlineMs ?? IMAGE_DERIVATIVE_SOURCE_READ_DEADLINE_MS;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs >= IMAGE_DERIVATIVE_LIMITS.leaseDurationMs) {
      throw new TypeError('image derivative source read deadline must be positive and shorter than the lease');
    }
    this.#sourceReadDeadlineMs = deadlineMs;
    this.#timer = input.timer ?? Object.freeze({ setTimeout, clearTimeout });
  }

  override async process(
    job: Readonly<ImageDerivativeJob>,
    source: Readonly<ImageDerivativeSource>,
  ): Promise<Readonly<ProcessedImageDerivative>> {
    if (source.mediaType !== 'image/png') {
      throw new ImageDerivativeError('invalid-request', 'image-derivative-input-mime-unsupported');
    }
    if (job.outputFormat !== 'png') {
      throw new ImageDerivativeError('not-ready', 'image-derivative-output-format-unsupported');
    }
    return super.process(job, Object.freeze({
      ...source,
      body: boundedSourceBody(
        source.body,
        this.#sourceReadDeadlineMs,
        this.#timer,
      ),
    }));
  }
}
