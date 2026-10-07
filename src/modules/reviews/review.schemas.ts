import { z } from 'zod';
import { FINDING_CATEGORIES } from '../../integrations/python-llm/llm.types.js';
import { codePointLength } from '../../shared/utils/offsets.js';
import { isObjectIdString } from '../../shared/utils/ids.js';
import { REVIEW_STATUSES } from './review.model.js';
import { USER_FINDING_ACTIONS } from './review-state.js';

export function createReviewBodySchema(maxContentChars: number) {
  return z.strictObject({
    documentTitle: z
      .string()
      .trim()
      .min(1, 'Document title is required')
      .max(200)
      .refine((s) => s.isWellFormed(), 'Document title contains invalid characters'),
    // Content is stored exactly as submitted (no trimming or normalization) so offsets match.
    content: z
      .string()
      .refine((s) => s.trim().length > 0, 'Content must not be empty')
      .refine((s) => s.isWellFormed(), 'Content contains invalid Unicode (lone surrogates)')
      .refine(
        (s) => codePointLength(s) <= maxContentChars,
        `Content must be at most ${maxContentChars} characters`,
      ),
    // Optional and informational: the AI service always checks every issue type. Kept so
    // existing clients that still send it continue to work.
    categories: z
      .array(z.enum(FINDING_CATEGORIES))
      .min(1, 'At least one category is required')
      .max(FINDING_CATEGORIES.length)
      .refine((c) => new Set(c).size === c.length, 'Categories must be unique')
      .optional(),
  });
}

export type CreateReviewBody = z.infer<ReturnType<typeof createReviewBodySchema>>;

const reviewIdSchema = z.string().refine(isObjectIdString, 'Invalid review id');

export const reviewParamsSchema = z.object({ reviewId: reviewIdSchema });

export const findingParamsSchema = z.object({
  reviewId: reviewIdSchema,
  findingId: z.string().regex(/^fnd_[a-f0-9]{24}$/, 'Invalid finding id'),
});

export const listReviewsQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(REVIEW_STATUSES).optional(),
});

export const updateFindingBodySchema = z.strictObject({
  status: z.enum(USER_FINDING_ACTIONS),
});

export type ListReviewsQuery = z.infer<typeof listReviewsQuerySchema>;
