import { ErrorCode } from '../../shared/errors/error-codes.js';

/**
 * Integration errors. `message` is internal (logged); `publicMessage` is safe for end users.
 * None of these carry document content.
 */
export abstract class LlmError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly retryable: boolean;
  abstract readonly publicMessage: string;
  /** Minimum delay before retrying, when the upstream told us (Retry-After). */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: { cause?: unknown; retryAfterMs?: number } = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class LlmTimeoutError extends LlmError {
  readonly code = ErrorCode.LLM_SERVICE_TIMEOUT;
  readonly retryable = true;
  readonly publicMessage = 'The review service took too long to respond.';
}

export class LlmUnavailableError extends LlmError {
  readonly code = ErrorCode.LLM_SERVICE_UNAVAILABLE;
  readonly retryable = true;
  readonly publicMessage = 'The review service is temporarily unavailable.';
}

export class LlmRateLimitedError extends LlmError {
  readonly code = ErrorCode.LLM_SERVICE_RATE_LIMITED;
  readonly retryable = true;
  readonly publicMessage = 'The review service is busy. Please try again later.';
}

/** Malformed JSON or a response that violates the contract. One retry may help (model output varies). */
export class LlmBadResponseError extends LlmError {
  readonly code = ErrorCode.LLM_INVALID_RESPONSE;
  readonly retryable = true;
  readonly publicMessage = 'The review service returned an invalid result.';
}

/** 4xx from Python (bad request, auth/config problems, content too large). Retrying will not help. */
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
