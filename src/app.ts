import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Container } from './container.js';
import { createSessionLoader } from './middleware/authenticate.js';
import { createCsrfProtection } from './middleware/csrf.js';
import { createErrorHandler } from './middleware/error-handler.js';
import { notFound } from './middleware/not-found.js';
import { createOriginCheck } from './middleware/origin-check.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { requestId, restoreRequestContext } from './middleware/request-id.js';
import { createApiRouter, createRootHealthRouter } from './routes/index.js';
import './shared/types/express.js';

export function createApp(c: Container): Express {
  const { env, logger } = c;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.set('etag', false);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      // Log only method, path and status: never headers, cookies, query strings or bodies.
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          path: req.url.split('?')[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : 'info'),
      autoLogging: { ignore: (req) => req.url.startsWith('/health') },
    }),
  );
  app.use((req, res, next) => {
    const started = performance.now();
    const route = captureRouteTemplate(req);
    res.on('finish', () => {
      c.metrics.observeHttpRequest({
        method: req.method,
        route: route.template ?? 'unmatched',
        statusCode: res.statusCode,
        durationMs: performance.now() - started,
      });
    });
    next();
  });

  app.use(
    helmet({
      // JSON/SSE API only: deny all content and framing.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: env.NODE_ENV === 'production',
    }),
  );

  app.use('/health', createRootHealthRouter(c));

  app.use(
    '/api',
    cors({
      origin: (origin, callback) => {
        // Same-origin and non-browser requests have no Origin header.
        callback(null, origin === undefined || env.FRONTEND_ORIGIN.includes(origin));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-Id', 'Last-Event-ID'],
      exposedHeaders: ['X-Request-Id', 'Location', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
      maxAge: 600,
    }),
  );
  app.use('/api', createOriginCheck(env.FRONTEND_ORIGIN));
  app.use(
    '/api',
    createRateLimiter({ windowMs: env.RATE_LIMIT_WINDOW_MS, limit: env.RATE_LIMIT_MAX }),
  );
  app.use('/api', express.json({ limit: env.BODY_LIMIT, strict: true, type: 'application/json' }));
  app.use('/api', restoreRequestContext);
  app.use('/api', cookieParser());
  app.use('/api', createSessionLoader(c.authService, env));

  const csrf = createCsrfProtection(env);
  app.use('/api/v1', createApiRouter(c, csrf));

  app.use(notFound);
  app.use(createErrorHandler());
  return app;
}

/**
 * Records the matched route template (e.g. "/api/v1/reviews/:reviewId") at the moment the
 * router assigns `req.route`, while `req.baseUrl` is still the router's mount path. Reading it at
 * response time is unreliable because Express restores `baseUrl` when an error leaves a router.
 * Templates (never raw URLs) keep metric label cardinality bounded.
 */
function captureRouteTemplate(req: express.Request): { template?: string } {
  const captured: { template?: string } = {};
  let current: unknown;
  Object.defineProperty(req, 'route', {
    configurable: true,
    enumerable: true,
    get: () => current,
    set: (value: { path?: unknown } | undefined) => {
      current = value;
      if (value && typeof value.path === 'string') {
        captured.template = `${req.baseUrl}${value.path}`.replace(/(.)\/$/, '$1');
      }
    },
  });
  return captured;
}
