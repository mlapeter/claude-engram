/** Error thrown when a watchdog timeout fires. */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Hard watchdog: race a promise against a timeout. On timeout, rejects with
 * TimeoutError — the underlying work is NOT cancelled (the caller is expected
 * to log, skip, and move on; hook processes exit shortly after anyway).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!)) as Promise<T>;
}
