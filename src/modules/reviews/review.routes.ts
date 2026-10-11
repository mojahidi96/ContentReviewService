import { Router, type RequestHandler } from 'express';
import { getAuth, requireAuth } from '../../middleware/authenticate.js';
import { validateRequest } from '../../middleware/validate-request.js';
import {
  createReviewBodySchema,
  findingParamsSchema,
  listReviewsQuerySchema,
  reviewParamsSchema,
  updateFindingBodySchema,
} from './review.schemas.js';
import type { ReviewService } from './review.service.js';

export function createReviewRouter(deps: {
  reviewService: ReviewService;
  csrfProtect: RequestHandler;
  eventsHandler: RequestHandler;
  maxContentChars: number;
}): Router {
  const { reviewService, csrfProtect } = deps;
  const router = Router();
  router.use(requireAuth);

  // Registered before '/:reviewId', which would reject "models" as an invalid id.
  router.get('/models', async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await reviewService.listModels());
  });

  router.post(
    '/',
    csrfProtect,
    validateRequest(
      { body: createReviewBodySchema(deps.maxContentChars) },
      async (req, res, { body }) => {
        const created = await reviewService.create(getAuth(req).userId, body);
        res.status(202).location(`/api/v1/reviews/${created.reviewId}`).json(created);
      },
    ),
  );

  router.get(
    '/',
    validateRequest({ query: listReviewsQuerySchema }, async (req, res, { query }) => {
      res
        .set('Cache-Control', 'no-store')
        .json(await reviewService.list(getAuth(req).userId, query));
    }),
  );

  router.get(
    '/:reviewId',
    validateRequest({ params: reviewParamsSchema }, async (req, res, { params }) => {
      const review = await reviewService.get(getAuth(req).userId, params.reviewId);
      res.set('Cache-Control', 'no-store').json({ review });
    }),
  );

  router.get('/:reviewId/events', deps.eventsHandler);

  router.patch(
    '/:reviewId/findings/:findingId',
    csrfProtect,
    validateRequest(
      { params: findingParamsSchema, body: updateFindingBodySchema },
      async (req, res, { params, body }) => {
        const finding = await reviewService.updateFinding(
          getAuth(req).userId,
          params.reviewId,
          params.findingId,
          body.status,
        );
        res.json({ finding });
      },
    ),
  );

  router.delete(
    '/:reviewId',
    csrfProtect,
    validateRequest({ params: reviewParamsSchema }, async (req, res, { params }) => {
      await reviewService.delete(getAuth(req).userId, params.reviewId);
      res.status(204).end();
    }),
  );

  return router;
}
