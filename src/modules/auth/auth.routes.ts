import { Router, type Request, type Response } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import type { Env } from '../../config/env.js';
import { setContextValue } from '../../infrastructure/observability/context.js';
import { getAuth, requireAuth } from '../../middleware/authenticate.js';
import type { CsrfProtection } from '../../middleware/csrf.js';
import { createRateLimiter } from '../../middleware/rate-limit.js';
import { validateRequest } from '../../middleware/validate-request.js';
import type { AuthService, IssuedSession } from './auth.service.js';
import { Errors } from '../../shared/errors/app-error.js';
import { sha256Hex } from '../../shared/utils/hash.js';
import { normalizeEmail } from '../users/user.model.js';
import {
  emailOnlyBodySchema,
  loginBodySchema,
  otpLoginBodySchema,
  passwordResetBodySchema,
  registerBodySchema,
} from './auth.schemas.js';
import type { OtpService } from './otp.service.js';
import {
  anonCookieName,
  anonCookieOptions,
  clearSessionCookieOptions,
  sessionCookieOptions,
} from './cookies.js';

export function createAuthRouter(deps: {
  env: Env;
  authService: AuthService;
  otpService: OtpService;
  csrf: CsrfProtection;
  authRateLimiter: (req: Request, res: Response, next: () => void) => void;
}): Router {
  const { env, authService, otpService, csrf } = deps;
  const router = Router();

  // Per-email limits apply whether or not the account exists, so 429s reveal nothing. The key
  // is a hash of the normalised email; unparseable bodies fall back to the client IP.
  const ipKey = (req: Request): string => `ip:${ipKeyGenerator(req.ip ?? '')}`;
  const emailKey = (req: Request): string => {
    const email: unknown = (req.body as { email?: unknown } | undefined)?.email;
    return typeof email === 'string' && email.length <= 254
      ? `email:${sha256Hex(normalizeEmail(email))}`
      : ipKey(req);
  };
  const otpLimiters = (kind: 'request' | 'verify') => {
    const request = kind === 'request';
    const common = {
      windowMs: env.OTP_RATE_LIMIT_WINDOW_MS,
      skipSuccessfulRequests: !request,
    };
    return [
      createRateLimiter({
        ...common,
        limit: request ? env.OTP_REQUEST_LIMIT_PER_IP : env.OTP_VERIFY_LIMIT_PER_IP,
        keyGenerator: ipKey,
      }),
      createRateLimiter({
        ...common,
        limit: request ? env.OTP_REQUEST_LIMIT_PER_EMAIL : env.OTP_VERIFY_LIMIT_PER_EMAIL,
        keyGenerator: emailKey,
      }),
    ];
  };
  const expiresInSeconds = env.OTP_TTL_SECONDS;

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

  router.post(
    '/otp/request',
    deps.authRateLimiter,
    csrf.protect,
    ...otpLimiters('request'),
    validateRequest({ body: emailOnlyBodySchema }, (req, res, { body }) => {
      otpService.requestCode(body.email, 'login', req.log);
      res.status(202).set('Cache-Control', 'no-store').json({ expiresInSeconds });
    }),
  );

  router.post(
    '/password/forgot',
    deps.authRateLimiter,
    csrf.protect,
    ...otpLimiters('request'),
    validateRequest({ body: emailOnlyBodySchema }, (req, res, { body }) => {
      otpService.requestCode(body.email, 'reset', req.log);
      res.status(202).set('Cache-Control', 'no-store').json({ expiresInSeconds });
    }),
  );

  router.post(
    '/otp/login',
    deps.authRateLimiter,
    csrf.protect,
    ...otpLimiters('verify'),
    validateRequest({ body: otpLoginBodySchema }, async (req, res, { body }) => {
      const userId = await otpService.consume(body.email, 'login', body.otp);
      if (!userId) {
        req.log.info({ outcome: 'otp_invalid' }, 'Code sign-in rejected');
        throw Errors.otpInvalid();
      }
      const session = await authService.loginVerifiedUser(userId);
      const csrfToken = startSession(req, res, session);
      req.log.info({ userId, outcome: 'ok' }, 'User signed in with emailed code');
      res.status(200).set('Cache-Control', 'no-store').json({ user: session.user, csrfToken });
    }),
  );

  router.post(
    '/password/reset',
    deps.authRateLimiter,
    csrf.protect,
    ...otpLimiters('verify'),
    validateRequest({ body: passwordResetBodySchema }, async (req, res, { body }) => {
      const userId = await otpService.consume(body.email, 'reset', body.otp);
      if (!userId) {
        req.log.info({ outcome: 'otp_invalid' }, 'Password reset rejected');
        throw Errors.otpInvalid();
      }
      const session = await authService.resetPassword(userId, body.newPassword);
      const csrfToken = startSession(req, res, session);
      req.log.info({ userId, outcome: 'ok' }, 'Password reset with emailed code');
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
