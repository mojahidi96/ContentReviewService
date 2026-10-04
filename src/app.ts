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
import { requestId } from './middleware/request-id.js';
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
    res.on('finish', () => {
      c.metrics.observeHttpRequest({
        method: req.method,
        route:
          `${req.baseUrl}${(req.route as { path?: string } | undefined)?.path ?? ''}` ||
          'unmatched',
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
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
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
  app.use('/api', cookieParser());
  app.use('/api', createSessionLoader(c.authService, env));

  const csrf = createCsrfProtection(env);
  app.use('/api/v1', createApiRouter(c, csrf));

  app.use(notFound);
  app.use(createErrorHandler());
  return app;
}
