export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Random source in [0, 1); injectable for tests. */
  random?: () => number;
}

/**
 * Exponential backoff with "full jitter": a random delay in
 * [base * 2^(attempt-1) / 2, base * 2^(attempt-1)], capped at maxMs.
 * `attempt` is 1-based (the attempt that just failed).
 */
export function computeBackoffMs(attempt: number, options: BackoffOptions): number {
  const random = options.random ?? Math.random;
  const exponent = Math.max(0, attempt - 1);
  const ceiling = Math.min(options.maxMs, options.baseMs * 2 ** exponent);
  const floor = ceiling / 2;
  return Math.round(floor + random() * (ceiling - floor));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
