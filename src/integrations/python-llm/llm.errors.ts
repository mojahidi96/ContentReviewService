import { ErrorCode } from '../../shared/errors/error-codes.js';
import type { QuotaInfo } from './llm.types.js';

/** Quota waits longer than this are not worth retrying inside the job; fail with the reset time. */
const MAX_QUOTA_RETRY_WAIT_SECONDS = 5 * 60;

/**
 * Integration errors. `message` is internal (logged); `publicMessage` is safe for end users.
 * None of these carry document content.
 */
export abstract class LlmError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly retryable: boolean;
  abstract readonly publicMessage: string;
  /** Structured, user-safe details the UI can render (e.g. when a quota resets). */
  readonly publicDetails: Record<string, unknown> | undefined = undefined;
  /** Minimum delay before retrying, when the upstream told us (Retry-After). */
  readonly retryAfterMs: number | undefined;
  /**
   * Retries allowed for this kind of failure. `undefined` means the job's own attempt budget
   * (JOB_MAX_ATTEMPTS) applies.
   */
  readonly maxRetries: number | undefined;

  constructor(
    message: string,
    options: { cause?: unknown; retryAfterMs?: number; maxRetries?: number } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.retryAfterMs = options.retryAfterMs;
    this.maxRetries = options.maxRetries;
  }
}

/**
 * Timeouts are usually systemic (provider overloaded, content too slow to review), and every
 * attempt can run up to PYTHON_LLM_TIMEOUT_MS, so only one retry is allowed to keep the worst
 * case near two timeouts instead of JOB_MAX_ATTEMPTS.
 */
export class LlmTimeoutError extends LlmError {
  readonly code = ErrorCode.LLM_SERVICE_TIMEOUT;
  readonly retryable = true;
  readonly publicMessage = 'The review service took too long to respond. Please try again.';

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { ...options, maxRetries: 1 });
  }
}

/** Unreachable service or 5xx. A 503 (provider down, concurrency limit) gets at most 2 retries. */
export class LlmUnavailableError extends LlmError {
  readonly code = ErrorCode.LLM_SERVICE_UNAVAILABLE;
  readonly retryable = true;
  readonly publicMessage = 'The review service is temporarily unavailable.';
}

/**
 * 429 LLM_QUOTA_EXHAUSTED. A short wait (per-minute quota) is retried within the job's attempt
 * budget, honoring Retry-After. A long wait (daily quota) fails immediately: retrying cannot
 * succeed, and the author needs to know the reset time or pick another model.
 */
export class LlmRateLimitedError extends LlmError {
  readonly code = ErrorCode.LLM_SERVICE_RATE_LIMITED;
  readonly retryable: boolean;
  readonly publicMessage: string;
  override readonly publicDetails: Record<string, unknown> | undefined;
  readonly quota: QuotaInfo | undefined;

  constructor(
    message: string,
    options: {
      cause?: unknown;
      retryAfterMs?: number;
      quota?: QuotaInfo;
      upstreamMessage?: string;
    } = {},
  ) {
    super(message, options);
    this.quota = options.quota;
    const wait = options.quota?.retryAfterSeconds;
    this.retryable = wait == null ? true : wait <= MAX_QUOTA_RETRY_WAIT_SECONDS;
    this.publicMessage =
      options.upstreamMessage ?? 'The review service is busy. Please try again later.';
    this.publicDetails = options.quota ? { ...options.quota } : undefined;
  }
}

/**
 * 502 INVALID_MODEL_OUTPUT, malformed JSON, or a response that violates the contract.
 * Model output varies, so one retry may help; more rarely does.
 */
export class LlmBadResponseError extends LlmError {
  readonly code = ErrorCode.LLM_INVALID_RESPONSE;
  readonly retryable = true;
  readonly publicMessage = 'The review service returned an invalid result.';

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { ...options, maxRetries: 1 });
  }
}

/** 401 (credential misconfigured), 422 (bug in our payload) and other 4xx. Retrying will not help. */
export class LlmRejectedError extends LlmError {
  readonly code = ErrorCode.LLM_REQUEST_REJECTED;
  readonly retryable = false;
  readonly publicMessage = 'The content could not be reviewed.';

  constructor(
    message: string,
    readonly upstreamStatus: number,
    readonly upstreamCode?: string,
  ) {
    super(message);
  }
}

/** 413 CONTENT_TOO_LARGE: the content must be shortened or split before it can be reviewed. */
export class LlmContentTooLargeError extends LlmError {
  readonly code = ErrorCode.LLM_CONTENT_TOO_LARGE;
  readonly retryable = false;
  readonly publicMessage = 'The content is too long to review. Shorten it and try again.';
}

/** The caller aborted the request (e.g. graceful shutdown). Not a failure of the review. */
export class LlmAbortedError extends LlmError {
  readonly code = ErrorCode.LLM_SERVICE_UNAVAILABLE;
  readonly retryable = true;
  readonly publicMessage = 'The review was interrupted.';
}

export function isRetryableError(err: unknown): boolean {
  if (err instanceof LlmError) return err.retryable;
  // Unknown errors (e.g. a transient database failure) get the bounded retry budget.
  return true;
}

/**
 * Whether a job whose attempt number `attempt` (1-based) just failed with `err` should be
 * retried, given the job's overall attempt budget and the error's own retry limit.
 */
export function shouldRetry(err: unknown, attempt: number, maxAttempts: number): boolean {
  if (!isRetryableError(err) || attempt >= maxAttempts) return false;
  const maxRetries = err instanceof LlmError ? err.maxRetries : undefined;
  return maxRetries === undefined || attempt <= maxRetries;
}
