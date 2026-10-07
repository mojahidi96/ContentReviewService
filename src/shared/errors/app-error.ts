import { ErrorCode } from './error-codes.js';

export interface ErrorDetail {
  path: string;
  message: string;
}

/**
 * An error whose `message` is safe to show to API clients.
 * Anything that is not an AppError is reported to clients as INTERNAL_ERROR.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: ErrorDetail[] | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(
    code: ErrorCode,
    statusCode: number,
    message: string,
    options: { details?: ErrorDetail[]; headers?: Record<string, string>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = options.details;
    this.headers = options.headers;
  }
}

export const Errors = {
  validation: (details: ErrorDetail[]) =>
    new AppError(ErrorCode.VALIDATION_FAILED, 400, 'The request is invalid.', { details }),
  authRequired: () => new AppError(ErrorCode.AUTH_REQUIRED, 401, 'Authentication is required.'),
  invalidCredentials: () =>
    new AppError(ErrorCode.INVALID_CREDENTIALS, 401, 'The email or password is incorrect.'),
  emailTaken: () =>
    new AppError(
      ErrorCode.EMAIL_ALREADY_REGISTERED,
      409,
      'An account with this email address already exists.',
    ),
  csrfInvalid: () =>
    new AppError(ErrorCode.CSRF_INVALID, 403, 'The CSRF token is missing or invalid.'),
  originNotAllowed: () =>
    new AppError(ErrorCode.ORIGIN_NOT_ALLOWED, 403, 'The request origin is not allowed.'),
  notFound: () => new AppError(ErrorCode.NOT_FOUND, 404, 'The requested resource was not found.'),
  reviewNotFound: () => new AppError(ErrorCode.REVIEW_NOT_FOUND, 404, 'The review was not found.'),
  findingNotFound: () =>
    new AppError(ErrorCode.FINDING_NOT_FOUND, 404, 'The finding was not found.'),
  documentNotFound: () =>
    new AppError(ErrorCode.DOCUMENT_NOT_FOUND, 404, 'The document was not found.'),
  documentVersionConflict: () =>
    new AppError(
      ErrorCode.DOCUMENT_VERSION_CONFLICT,
      409,
      'The document was changed since you loaded it. Reload it before saving again.',
    ),
  reviewNotCompleted: () =>
    new AppError(
      ErrorCode.REVIEW_NOT_COMPLETED,
      409,
      'Findings can only be updated after the review has completed.',
    ),
  invalidTransition: (from: string, to: string) =>
    new AppError(
      ErrorCode.INVALID_STATE_TRANSITION,
      409,
      `A finding cannot change from "${from}" to "${to}".`,
    ),
  conflict: () =>
    new AppError(
      ErrorCode.CONFLICT,
      409,
      'The resource was modified concurrently. Reload and try again.',
    ),
};
