import { ControlPlaneUiError } from './control-plane-ui-request.js';

export interface ControlLoginAttemptLimiter {
  assertAllowed(key: string, now: Date): void;
  recordFailure(key: string, now: Date): void;
  recordSuccess(key: string): void;
}

interface AttemptWindow {
  count: number;
  startedAtMilliseconds: number;
}

const MAX_FAILURES = 5;
const WINDOW_MILLISECONDS = 60_000;

export function createControlLoginAttemptLimiter(
  rateLimitCode = 'control-login-rate-limited',
): ControlLoginAttemptLimiter {
  const windows = new Map<string, AttemptWindow>();

  function activeWindow(key: string, now: Date): AttemptWindow | undefined {
    const current = windows.get(key);
    if (current === undefined) return undefined;
    if (now.getTime() - current.startedAtMilliseconds >= WINDOW_MILLISECONDS) {
      windows.delete(key);
      return undefined;
    }
    return current;
  }

  return Object.freeze({
    assertAllowed(key: string, now: Date): void {
      const current = activeWindow(key, now);
      if (current !== undefined && current.count >= MAX_FAILURES) {
        throw new ControlPlaneUiError(429, rateLimitCode);
      }
    },
    recordFailure(key: string, now: Date): void {
      const current = activeWindow(key, now);
      if (current === undefined) {
        windows.set(key, { count: 1, startedAtMilliseconds: now.getTime() });
        return;
      }
      current.count += 1;
    },
    recordSuccess(key: string): void {
      windows.delete(key);
    },
  });
}
