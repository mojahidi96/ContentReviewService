import { z } from 'zod';
import { codePointLength } from '../../shared/utils/offsets.js';
import { isObjectIdString } from '../../shared/utils/ids.js';

const title = z
  .string()
  .trim()
  .min(1, 'Title is required')
  .max(200)
  .refine((s) => s.isWellFormed(), 'Title contains invalid characters');

/**
 * Content is validated but never transformed: whitespace, indentation and line endings are kept
 * exactly as sent. Empty content is allowed (an author may save a blank document).
 */
function content(maxChars: number) {
  return z
    .string()
    .refine((s) => s.isWellFormed(), 'Content contains invalid Unicode (lone surrogates)')
    .refine(
      (s) => codePointLength(s) <= maxChars,
      `Content must be at most ${maxChars} characters`,
    );
}

export function createDocumentBodySchema(maxChars: number) {
  return z.strictObject({ title, content: content(maxChars) });
}

export function updateDocumentBodySchema(maxChars: number) {
  return z.strictObject({
    title,
    content: content(maxChars),
    /** The version the client last loaded; the update is rejected if it is no longer current. */
    version: z.number().int().min(1),
  });
}

export const documentParamsSchema = z.object({
  documentId: z.string().refine(isObjectIdString, 'Invalid document id'),
});

export const listDocumentsQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type CreateDocumentBody = z.infer<ReturnType<typeof createDocumentBodySchema>>;
export type UpdateDocumentBody = z.infer<ReturnType<typeof updateDocumentBodySchema>>;
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;
