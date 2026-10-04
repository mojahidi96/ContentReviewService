import type { NextFunction, Request, Response } from 'express';
import type { Env } from '../config/env.js';
import type { AuthService } from '../modules/auth/auth.service.js';
import { clearSessionCookieOptions } from '../modules/auth/cookies.js';
import { Errors } from '../shared/errors/app-error.js';

/**
 * Resolves the session cookie (if any) into `req.auth`. Never rejects on its own; invalid or
 * revoked cookies are cleared and the request continues anonymously.
 */
export function createSessionLoader(authService: AuthService, env: Env) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token: unknown = req.cookies[env.AUTH_COOKIE_NAME];
    if (typeof token !== 'string' || token.length === 0) {
      next();
      return;
    }
    const auth = await authService.resolveSession(token);
    if (auth) req.auth = auth;
    else res.clearCookie(env.AUTH_COOKIE_NAME, clearSessionCookieOptions(env));
    next();
  };
}

/** Rejects requests without an authenticated session. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  next(req.auth ? undefined : Errors.authRequired());
}

/** Narrowing helper for handlers mounted behind `requireAuth`. */
export function getAuth(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw Errors.authRequired();
  return req.auth;
}
