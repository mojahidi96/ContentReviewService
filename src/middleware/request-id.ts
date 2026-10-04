import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Honors a well-formed inbound X-Request-Id (e.g. from a gateway); otherwise generates one. */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.get('x-request-id');
  req.requestId = inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}
