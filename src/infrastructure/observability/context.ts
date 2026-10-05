import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Correlation identifiers attached to every log line written while a request or job runs.
 * Only identifiers belong here — never content, tokens or other sensitive values.
 */
export interface LogContext {
  requestId?: string;
  userId?: string;
  reviewId?: string;
  jobId?: string;
  attempt?: number;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with a fresh context that follows all async work it starts. */
export function runWithContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

export function getContext(): LogContext | undefined {
  return storage.getStore();
}

/** Adds a value to the current context (no-op outside a context). */
export function setContextValue<K extends keyof LogContext>(key: K, value: LogContext[K]): void {
  const store = storage.getStore();
  if (store) store[key] = value;
}
