import { Router, type Request, type Response } from 'express';
import type { Env } from '../../config/env.js';
import { setContextValue } from '../../infrastructure/observability/context.js';
import { getAuth, requireAuth } from '../../middleware/authenticate.js';
import type { CsrfProtection } from '../../middleware/csrf.js';
import { validateRequest } from '../../middleware/validate-request.js';
import type { AuthService, IssuedSession } from './auth.service.js';
import { loginBodySchema, registerBodySchema } from './auth.schemas.js';
import {
  anonCookieName,
  anonCookieOptions,
  clearSessionCookieOptions,
  sessionCookieOptions,
} from './cookies.js';

export function createAuthRouter(deps: {
  env: Env;
  authService: AuthService;
  csrf: CsrfProtection;
  authRateLimiter: (req: Request, res: Response, next: () => void) => void;
}): Router {
  const { env, authService, csrf } = deps;
  const router = Router();

  /** Sets the session cookie and returns a CSRF token bound to the new session. */
  function startSession(req: Request, res: Response, session: IssuedSession): string {
    res.cookie(env.AUTH_COOKIE_NAME, session.token, sessionCookieOptions(env));
    const { maxAge: _maxAge, ...anonClear } = anonCookieOptions(env);
    res.clearCookie(anonCookieName(env), anonClear);
    req.auth = { userId: session.user.id, sessionId: session.sessionId };
    setContextValue('userId', session.user.id);
    return csrf.issueToken(req, res, { rotate: true });
  }

  router.get('/csrf', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ csrfToken: csrf.issueToken(req, res) });
  });

  router.post(
    '/register',
    deps.authRateLimiter,
    csrf.protect,
    validateRequest({ body: registerBodySchema }, async (req, res, { body }) => {
      const session = await authService.register(body);
      const csrfToken = startSession(req, res, session);
      req.log.info({ userId: session.user.id }, 'User registered');
      res.status(201).set('Cache-Control', 'no-store').json({ user: session.user, csrfToken });
    }),
  );

  router.post(
    '/login',
    deps.authRateLimiter,
    csrf.protect,
    validateRequest({ body: loginBodySchema }, async (req, res, { body }) => {
      const session = await authService.login(body);
      const csrfToken = startSession(req, res, session);
      req.log.info({ userId: session.user.id }, 'User logged in');
      res.status(200).set('Cache-Control', 'no-store').json({ user: session.user, csrfToken });
    }),
  );

  router.post('/logout', requireAuth, csrf.protect, async (req, res) => {
    const auth = getAuth(req);
    await authService.logout(auth.sessionId);
    res.clearCookie(env.AUTH_COOKIE_NAME, clearSessionCookieOptions(env));
    csrf.clear(res);
    req.log.info({ userId: auth.userId }, 'User logged out');
    res.status(204).end();
  });

  router.get('/me', requireAuth, async (req, res) => {
    const user = await authService.getUser(getAuth(req).userId);
    res.set('Cache-Control', 'no-store').json({ user });
  });

  return router;
}
