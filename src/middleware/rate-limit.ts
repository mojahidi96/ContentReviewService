import type { Request, Response } from 'express';
import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import { ErrorCode } from '../shared/errors/error-codes.js';

/**
 * In-memory rate limiting per client IP. For multiple API instances, plug a shared store
 * (e.g. rate-limit-redis / rate-limit-mongo) into `store`; see docs/architecture.md.
 */
export function createRateLimiter(options: {
  windowMs: number;
  limit: number;
  keyGenerator?: (req: Request) => string;
  /** Count only failed (status >= 400) requests. */
  skipSuccessfulRequests?: boolean;
}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    ...(options.keyGenerator ? { keyGenerator: options.keyGenerator } : {}),
    ...(options.skipSuccessfulRequests ? { skipSuccessfulRequests: true } : {}),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req: Request, res: Response) => {
      res.status(429).json({
        error: {
          code: ErrorCode.RATE_LIMITED,
          message: 'Too many requests. Please try again later.',
          requestId: req.requestId,
        },
      });
    },
  });
}
