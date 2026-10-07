import { Router, type RequestHandler } from 'express';
import { getAuth, requireAuth } from '../../middleware/authenticate.js';
import { validateRequest } from '../../middleware/validate-request.js';
import {
  createDocumentBodySchema,
  documentParamsSchema,
  listDocumentsQuerySchema,
  updateDocumentBodySchema,
} from './document.schemas.js';
import type { DocumentService } from './document.service.js';

export function createDocumentRouter(deps: {
  documentService: DocumentService;
  csrfProtect: RequestHandler;
  maxContentChars: number;
}): Router {
  const { documentService, csrfProtect, maxContentChars } = deps;
  const router = Router();
  router.use(requireAuth);

  router.post(
    '/',
    csrfProtect,
    validateRequest(
      { body: createDocumentBodySchema(maxContentChars) },
      async (req, res, { body }) => {
        const document = await documentService.create(getAuth(req).userId, body);
        res
          .status(201)
          .location(`/api/v1/documents/${document.documentId}`)
          .set('Cache-Control', 'no-store')
          .json({ document });
      },
    ),
  );

  router.get(
    '/',
    validateRequest({ query: listDocumentsQuerySchema }, async (req, res, { query }) => {
      res
        .set('Cache-Control', 'no-store')
        .json(await documentService.list(getAuth(req).userId, query));
    }),
  );

  router.get(
    '/:documentId',
    validateRequest({ params: documentParamsSchema }, async (req, res, { params }) => {
      const document = await documentService.get(getAuth(req).userId, params.documentId);
      res.set('Cache-Control', 'no-store').json({ document });
    }),
  );

  router.put(
    '/:documentId',
    csrfProtect,
    validateRequest(
      { params: documentParamsSchema, body: updateDocumentBodySchema(maxContentChars) },
      async (req, res, { params, body }) => {
        const document = await documentService.update(getAuth(req).userId, params.documentId, body);
        res.set('Cache-Control', 'no-store').json({ document });
      },
    ),
  );

  router.delete(
    '/:documentId',
    csrfProtect,
    validateRequest({ params: documentParamsSchema }, async (req, res, { params }) => {
      await documentService.delete(getAuth(req).userId, params.documentId);
      res.status(204).end();
    }),
  );

  return router;
}
