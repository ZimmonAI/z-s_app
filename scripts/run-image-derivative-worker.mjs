import { createImageDerivativeWorkerComposition } from '../dist/image-derivative-worker-composition.js';

const maximumJobs = (() => {
  const argument = process.argv.find((value) => value.startsWith('--maximum-jobs='));
  if (argument === undefined) return 1;
  const parsed = Number(argument.slice('--maximum-jobs='.length));
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('invalid-maximum-jobs');
  }
  return parsed;
})();

const composition = createImageDerivativeWorkerComposition(process.env);
let processed = 0;
try {
  while (processed < maximumJobs) {
    const result = await composition.runOnce();
    if (result === null) break;
    processed += 1;
    process.stdout.write(`${JSON.stringify({
      jobId: result.jobId,
      state: result.state,
      attemptCount: result.attemptCount,
      safeDiagnosticCode: result.safeDiagnosticCode,
    })}\n`);
  }
} finally {
  await composition.close();
}
