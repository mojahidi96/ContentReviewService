import { Router } from 'express';
import type { Container } from '../container.js';
import type { CsrfProtection } from '../middleware/csrf.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { createAuthRouter } from '../modules/auth/auth.routes.js';
import { createHealthRouter } from '../modules/health/health.routes.js';
import { createReviewEventsHandler } from '../modules/reviews/review-sse.controller.js';
import { createReviewRouter } from '../modules/reviews/review.routes.js';

export function createApiRouter(c: Container, csrf: CsrfProtection): Router {
  const router = Router();

  router.use(
    '/auth',
    createAuthRouter({
      env: c.env,
      authService: c.authService,
      csrf,
      authRateLimiter: createRateLimiter({
        windowMs: c.env.RATE_LIMIT_WINDOW_MS,
        limit: c.env.AUTH_RATE_LIMIT_MAX,
      }),
    }),
  );

  router.use(
    '/reviews',
    createReviewRouter({
      reviewService: c.reviewService,
      csrfProtect: csrf.protect,
      maxContentChars: c.env.REVIEW_MAX_CONTENT_CHARS,
      eventsHandler: createReviewEventsHandler({
        env: c.env,
        reviewService: c.reviewService,
        events: c.events,
        bus: c.bus,
        registry: c.sseRegistry,
        metrics: c.metrics,
      }),
    }),
  );

  return router;
}

export function createRootHealthRouter(c: Container): Router {
  return createHealthRouter({
    llmClient: c.llmClient,
    checkPython: c.env.PYTHON_LLM_HEALTH_CHECK,
    isShuttingDown: () => c.lifecycle.shuttingDown,
  });
}
