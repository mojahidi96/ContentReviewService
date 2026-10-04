import type { NextFunction, Request, Response } from 'express';
import { doubleCsrf } from 'csrf-csrf';
import type { Env } from '../config/env.js';
import { anonCookieName, anonCookieOptions } from '../modules/auth/cookies.js';
import { ErrorCode } from '../shared/errors/error-codes.js';
import { randomToken } from '../shared/utils/hash.js';

export interface CsrfProtection {
  /** Validates X-CSRF-Token for unsafe methods (POST/PUT/PATCH/DELETE). */
  protect: (req: Request, res: Response, next: NextFunction) => void;
  /** Issues (or re-uses) a token bound to the caller's current session or anonymous id. */
  issueToken: (req: Request, res: Response, options?: { rotate?: boolean }) => string;
  /** Clears the CSRF cookie (used on logout). */
  clear: (res: Response) => void;
}

/**
 * Signed double-submit cookie (csrf-csrf). The HttpOnly cookie holds an HMAC of
 * (session identifier, random value); the client echoes the token value in X-CSRF-Token.
 * Binding to the session identifier means a token minted for one session (or for an attacker's
 * anonymous browser) is useless for another.
 */
export function createCsrfProtection(env: Env): CsrfProtection {
  const anonName = anonCookieName(env);
  const cookieOptions = {
    httpOnly: true,
    secure: env.AUTH_COOKIE_SECURE,
    sameSite: env.AUTH_COOKIE_SAMESITE,
    path: '/',
  } as const;

  const { doubleCsrfProtection, generateCsrfToken } = doubleCsrf({
    getSecret: () => env.CSRF_SECRET,
    getSessionIdentifier: (req) => {
      if (req.auth) return `session:${req.auth.sessionId}`;
      const anon: unknown = req.cookies[anonName];
      // An unknown identity gets a random identifier, so validation can never succeed.
      return typeof anon === 'string' && anon.length > 0
        ? `anon:${anon}`
        : `none:${randomToken(16)}`;
    },
    cookieName: env.CSRF_COOKIE_NAME,
    cookieOptions,
    getCsrfTokenFromRequest: (req) => req.get('x-csrf-token'),
    ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
    errorConfig: {
      statusCode: 403,
      message: 'The CSRF token is missing or invalid.',
      code: ErrorCode.CSRF_INVALID,
    },
  });

  return {
    protect: doubleCsrfProtection,
    issueToken(req, res, options = {}) {
      if (!req.auth) {
        const existing: unknown = req.cookies[anonName];
        if (typeof existing !== 'string' || existing.length === 0) {
          const anonId = randomToken(24);
          res.cookie(anonName, anonId, anonCookieOptions(env));
          // Make the new identifier visible to getSessionIdentifier for this request.
          (req.cookies as Record<string, string>)[anonName] = anonId;
        }
      }
      return generateCsrfToken(req, res, {
        overwrite: options.rotate ?? false,
        validateOnReuse: false,
      });
    },
    clear(res) {
      res.clearCookie(env.CSRF_COOKIE_NAME, cookieOptions);
    },
  };
}
