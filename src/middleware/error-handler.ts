import type { ErrorRequestHandler } from 'express';
import { AppError } from '../shared/errors/app-error.js';
import { ErrorCode } from '../shared/errors/error-codes.js';

interface HttpLikeError {
  status?: number;
  statusCode?: number;
  type?: string;
  code?: string;
}

/** Maps framework errors (body-parser, csrf-csrf) onto the public error vocabulary. */
function normalize(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  if (typeof err !== 'object' || err === null) return null;
  const e = err as HttpLikeError;

  switch (e.type) {
    case 'entity.parse.failed':
      return new AppError(ErrorCode.MALFORMED_JSON, 400, 'The request body is not valid JSON.');
    case 'entity.too.large':
      return new AppError(ErrorCode.PAYLOAD_TOO_LARGE, 413, 'The request body is too large.');
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return new AppError(
        ErrorCode.UNSUPPORTED_MEDIA_TYPE,
        415,
        'The request encoding is not supported.',
      );
    default:
      break;
  }
  if (e.code === ErrorCode.CSRF_INVALID) {
    return new AppError(ErrorCode.CSRF_INVALID, 403, 'The CSRF token is missing or invalid.');
  }
  return null;
}

export function createErrorHandler(): ErrorRequestHandler {
  return (err: unknown, req, res, next) => {
    if (res.headersSent) {
      // Streaming responses (SSE) cannot carry a JSON error; let Express close the socket.
      next(err);
      return;
    }

    const appError = normalize(err);
    const log = req.log;

    if (!appError) {
      log.error({ err, requestId: req.requestId }, 'Unhandled error');
      res.status(500).json({
        error: {
          code: ErrorCode.INTERNAL_ERROR,
          message: 'An unexpected error occurred.',
          requestId: req.requestId,
        },
      });
      return;
    }

    if (appError.statusCode >= 500) {
      log.error({ err: appError, code: appError.code }, 'Request failed');
    } else {
      log.info({ code: appError.code, statusCode: appError.statusCode }, 'Request rejected');
    }

    if (appError.headers) res.set(appError.headers);
    res.status(appError.statusCode).json({
      error: {
        code: appError.code,
        message: appError.message,
        requestId: req.requestId,
        ...(appError.details ? { details: appError.details } : {}),
      },
    });
  };
}
