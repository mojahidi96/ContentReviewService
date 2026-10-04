import type { NextFunction, Request, Response } from 'express';
import { Errors } from '../shared/errors/app-error.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Rejects state-changing requests whose Origin (or Referer, as a fallback) is not allow-listed.
 * Requests with neither header (non-browser clients) are allowed through; they still need a
 * valid CSRF token, so this is a defense-in-depth layer, not the primary CSRF control.
 */
export function createOriginCheck(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins);

  return (req: Request, _res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const origin = req.get('origin');
    if (origin !== undefined) {
      next(allowed.has(origin) ? undefined : Errors.originNotAllowed());
      return;
    }
    const referer = req.get('referer');
    if (referer !== undefined) {
      const refererOrigin = URL.parse(referer)?.origin;
      next(refererOrigin && allowed.has(refererOrigin) ? undefined : Errors.originNotAllowed());
      return;
    }
    next();
  };
}
