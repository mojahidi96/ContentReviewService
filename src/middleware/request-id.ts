import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getContext, runWithContext } from '../infrastructure/observability/context.js';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Honors a well-formed inbound X-Request-Id (e.g. from a gateway); otherwise generates one. */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.get('x-request-id');
  req.requestId = inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  runWithContext({ requestId: req.requestId }, next);
}

/**
 * Re-enters the request's log context. Body parsing resumes from stream callbacks that may run
 * outside the context started by `requestId`, so this is mounted again after the body parser.
 */
export function restoreRequestContext(req: Request, _res: Response, next: NextFunction): void {
  if (getContext()?.requestId === req.requestId) {
    next();
    return;
  }
  runWithContext({ requestId: req.requestId }, next);
}
